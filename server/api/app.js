// Employee / architect / supervisor app API (phone + PIN login, works offline-first).
import { all, one, run, tx } from '../db/index.js';
import { nowIso, addMinIso, jparse, istDate, addDays, fromIst, prettyPhone, mapsLink } from '../lib/util.js';
import { bad, notFound, forbidden } from '../lib/http.js';
import { saveMediaBuffer } from '../whatsapp/providers.js';
import { insert } from '../db/index.js';
import { getSettings } from '../core/base.js';
import { publicUser, recordAttendance, requestLeave, submitExpense, updateTask, allowedPlaces } from '../domain/staff.js';
import { architectRespond, pendingOffersFor } from '../domain/scheduling.js';
import { getVisit, visitCheckin, markClientNoShow, submitVisitReport, visitsForArchitect } from '../domain/visits.js';
import { getProject, addSiteLog, submitMilestone } from '../domain/projects.js';
import { getLead } from '../domain/leads.js';
import { servicesText, natureText, areaText, leadPlace } from '../domain/common.js';

export function saveUpload(b, owner, by) {
  if (!b?.data) return null;
  const mime = String(b.mime || 'image/jpeg');
  if (!/^(image\/(jpeg|png|webp)|application\/pdf)$/.test(mime)) throw bad('Only JPG, PNG, WEBP images or PDF are allowed');
  const buf = Buffer.from(String(b.data).replace(/^data:[^,]+,/, ''), 'base64');
  if (buf.length > 8 * 1024 * 1024) throw bad('File too large (max 8 MB)');
  const saved = saveMediaBuffer(buf, mime);
  return insert('media', { mime, file_path: saved.filePath, size: saved.size, sha256: saved.sha256, caption: b.caption || null, owner_type: owner[0], owner_id: owner[1], uploaded_by: by, lat: b.lat ?? null, lng: b.lng ?? null, status: 'stored', created_at: nowIso() });
}

function myProjects(u) {
  return all("SELECT * FROM projects WHERE status IN ('active','awaiting_advance','handover') AND (supervisor_id=? OR engineer_id=? OR architect_id=? OR manager_id=?) ORDER BY ref", u.id, u.id, u.id, u.id);
}

export function registerApp(r) {
  const a = { auth: 'app' };
  r.get('/api/app/me', a, (ctx) => {
    const u = ctx.user; const day = istDate();
    const from = fromIst(day, '00:00').toISOString(); const to = fromIst(addDays(day, 1), '00:00').toISOString();
    const events = all('SELECT * FROM attendance_events WHERE user_id=? AND effective_time>=? AND effective_time<? ORDER BY effective_time', u.id, from, to);
    const last = events[events.length - 1];
    return {
      user: publicUser(u), day, checkedIn: last?.kind === 'in', events: events.map((e) => ({ kind: e.kind, at: e.effective_time, place: e.place_name, validation: e.validation, reasons: jparse(e.reasons, []) })),
      places: allowedPlaces(u, day).map((p) => ({ type: p.type, id: p.id, name: p.name })),
      tasks: all("SELECT * FROM tasks WHERE assignee_id=? AND status NOT IN ('done','cancelled') ORDER BY CASE priority WHEN 'high' THEN 0 ELSE 1 END, COALESCE(due_at,'9999') LIMIT 50", u.id),
      offers: pendingOffersFor(u.id).map((o) => ({ id: o.id, revision: o.revision, ref: o.ref, slot_start: o.slot_start, expires_at: o.expires_at, place: leadPlace(o), services: servicesText(o.services), nature: natureText(o), area: areaText(o) })),
      visits: visitsForArchitect(u.id, from, addMinIso(to, 7 * 1440)).filter((v) => v.status !== 'cancelled').map((v) => ({ id: v.id, ref: v.ref, start_at: v.start_at, status: v.status, client: v.client_name, place: leadPlace(v) })),
      projects: myProjects(u).map((p) => ({ id: p.id, ref: p.ref, name: p.name, status: p.status })),
      unread: one('SELECT COUNT(*) n FROM notifications WHERE user_id=? AND read_at IS NULL', u.id).n,
      office: getSettings().office,
    };
  });

  r.post('/api/app/attendance', { auth: 'app', limit: 12 * 1024 * 1024 }, (ctx) => tx(() => {
    const b = ctx.body || {};
    if (b.owner_user_id !== undefined && Number(b.owner_user_id) !== ctx.user.id) throw forbidden('Saved item belongs to a different employee');
    const photo = b.photo ? saveUpload({ ...b.photo, lat: b.lat, lng: b.lng }, ['attendance', ctx.user.id], `user:${ctx.user.id}`) : null;
    const res = recordAttendance(ctx.user.id, { ...b, photo_media_id: photo });
    if (res.error) throw bad(res.error);
    return res;
  }));

  /** Offline queue sync: [{type:'attendance'|'site_log'|'task', client_event_id, ...}] */
  r.post('/api/app/sync', { auth: 'app', limit: 25 * 1024 * 1024 }, (ctx) => {
    const items = Array.isArray(ctx.body?.items) ? ctx.body.items.slice(0, 100) : [];
    return items.map((it) => {
      try {
        return tx(() => {
          if (it.owner_user_id !== undefined && Number(it.owner_user_id) !== ctx.user.id) throw forbidden('Saved item belongs to a different employee');
          if (it.type === 'attendance') {
            const photo = it.photo ? saveUpload({ ...it.photo, lat: it.lat, lng: it.lng }, ['attendance', ctx.user.id], `user:${ctx.user.id}`) : null;
            return { client_event_id: it.client_event_id, ...recordAttendance(ctx.user.id, { ...it, offline: true, photo_media_id: photo }) };
          }
          if (it.type === 'site_log') return { client_event_id: it.client_event_id, ...siteLog(ctx.user, it) };
          if (it.type === 'task') return { client_event_id: it.client_event_id, ...taskUpdate(ctx.user, it) };
          return { client_event_id: it.client_event_id, error: 'Unknown item type' };
        });
      } catch (e) { return { client_event_id: it.client_event_id, error: e.message }; }
    });
  });

  r.get('/api/app/attendance', a, (ctx) => {
    const month = ctx.query.month || istDate().slice(0, 7);
    return { month, days: all('SELECT * FROM attendance_days WHERE user_id=? AND day LIKE ? ORDER BY day', ctx.user.id, `${month}%`) };
  });

  r.patch('/api/app/tasks/:id', a, (ctx) => tx(() => taskUpdate(ctx.user, { id: Number(ctx.params.id), ...ctx.body })));

  r.post('/api/app/offers/:id/respond', a, (ctx) => {
    const res = architectRespond(Number(ctx.params.id), Number(ctx.body?.revision), !!ctx.body?.accept, { userId: ctx.user.id, reason: ctx.body?.reason, via: 'app' });
    if (res.stale) throw bad('This request is no longer active');
    return res;
  });

  r.get('/api/app/visits/:id', a, (ctx) => {
    const v = getVisit(Number(ctx.params.id));
    if (!v || v.architect_id !== ctx.user.id) throw notFound();
    const l = getLead(v.lead_id);
    const confirmed = ['confirmed', 'in_progress', 'report_submitted', 'completed', 'no_show_client'].includes(v.status);
    return {
      visit: { ...v, report: jparse(v.report, null) },
      lead: { ref: l.ref, services: servicesText(l.services), nature: natureText(l), area: areaText(l), place: leadPlace(l), requirements: l.requirements, window: l.execution_window },
      client: confirmed ? { name: l.name, phone: prettyPhone(l.phone), tel: l.phone, address: l.address, lat: l.site_lat, lng: l.site_lng, maps: mapsLink(l.site_lat, l.site_lng, l.address || leadPlace(l)) } : null,
      media: all("SELECT id, mime, caption FROM media WHERE (owner_type='lead' AND owner_id=?) OR (owner_type='visit' AND owner_id=?)", l.id, v.id),
    };
  });
  r.post('/api/app/visits/:id/checkin', a, (ctx) => tx(() => { const res = visitCheckin(Number(ctx.params.id), ctx.user.id, ctx.body || {}); if (res.error) throw bad(res.error); return res; }));
  r.post('/api/app/visits/:id/no-show', a, (ctx) => tx(() => { const res = markClientNoShow(Number(ctx.params.id), ctx.user.id); if (res.error) throw bad(res.error); return res; }));
  r.post('/api/app/visits/:id/report', { auth: 'app', limit: 40 * 1024 * 1024 }, (ctx) => tx(() => {
    const v = getVisit(Number(ctx.params.id));
    if (!v || v.architect_id !== ctx.user.id) throw notFound();
    const b = ctx.body || {};
    for (const p of (b.photos || []).slice(0, 10)) saveUpload(p, ['visit', v.id], `user:${ctx.user.id}`);
    const report = { measurements: b.measurements || '', scope: b.scope || '', constraints: b.constraints || '', recommendation: b.recommendation || '', budget_range: b.budget_range || '', interest: b.interest || '', next_step: b.next_step || 'quotation', notes: b.notes || '' };
    const res = submitVisitReport(v.id, ctx.user.id, report);
    if (res.error) throw bad(res.error);
    return res;
  }));

  r.get('/api/app/projects/:id', a, (ctx) => {
    const p = getProject(Number(ctx.params.id));
    if (!p || ![p.supervisor_id, p.engineer_id, p.architect_id, p.manager_id].includes(ctx.user.id)) throw notFound();
    return {
      project: { id: p.id, ref: p.ref, name: p.name, address: p.address, status: p.status, maps: mapsLink(p.site_lat, p.site_lng, p.address) },
      milestones: all('SELECT id, seq, name, status, progress, planned_end, review_note FROM milestones WHERE project_id=? ORDER BY seq', p.id),
      logs: all('SELECT id, log_date, work_done, labour, issues, progress FROM site_logs WHERE project_id=? ORDER BY id DESC LIMIT 10', p.id).map((l) => ({ ...l, labour: jparse(l.labour, {}) })),
    };
  });
  r.post('/api/app/projects/:id/logs', { auth: 'app', limit: 40 * 1024 * 1024 }, (ctx) => tx(() => siteLog(ctx.user, { ...ctx.body, project_id: Number(ctx.params.id) })));
  r.post('/api/app/milestones/:id/ready', a, (ctx) => tx(() => {
    const m = one('SELECT * FROM milestones WHERE id=?', Number(ctx.params.id)); if (!m) throw notFound();
    const p = getProject(m.project_id);
    if (![p.supervisor_id, p.engineer_id, p.architect_id, p.manager_id].includes(ctx.user.id)) throw forbidden();
    const res = submitMilestone(m.id, ctx.user.id, ctx.body?.note);
    if (res.error) throw bad(res.error);
    return res;
  }));

  r.post('/api/app/leave', a, (ctx) => tx(() => { const res = requestLeave(ctx.user.id, ctx.body || {}); if (res.error) throw bad(res.error); return res; }));
  r.post('/api/app/expenses', { auth: 'app', limit: 12 * 1024 * 1024 }, (ctx) => tx(() => {
    const b = ctx.body || {};
    const receipt = b.receipt ? saveUpload(b.receipt, ['expense', 0], `user:${ctx.user.id}`) : null;
    const res = submitExpense(ctx.user.id, { ...b, receipt_media_id: receipt });
    if (res.error) throw bad(res.error);
    return res;
  }));
  r.get('/api/app/requests', a, (ctx) => ({
    leave: all('SELECT * FROM leave_requests WHERE user_id=? ORDER BY id DESC LIMIT 30', ctx.user.id),
    expenses: all('SELECT * FROM expense_claims WHERE user_id=? ORDER BY id DESC LIMIT 30', ctx.user.id),
  }));
}

function siteLog(u, b) {
  const p = getProject(Number(b.project_id));
  if (!p || ![p.supervisor_id, p.engineer_id, p.architect_id, p.manager_id].includes(u.id)) throw forbidden('Not your project');
  const res = addSiteLog(p.id, u.id, b);
  if (res.error) throw bad(res.error);
  if (!res.duplicate) for (const ph of (b.photos || []).slice(0, 10)) saveUpload({ ...ph, lat: b.lat, lng: b.lng }, ['site_log', res.id], `user:${u.id}`);
  return res;
}
function taskUpdate(u, b) {
  const t = one('SELECT * FROM tasks WHERE id=?', Number(b.id));
  if (!t || t.assignee_id !== u.id) throw forbidden('Not your task');
  if (b.status && !['todo', 'in_progress', 'blocked', 'done'].includes(b.status)) throw bad('Bad status');
  return updateTask(t.id, { status: b.status, note: b.note }, u);
}
