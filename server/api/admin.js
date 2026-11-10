// Dashboard API (owner / manager / finance).
import fs from 'node:fs';
import path from 'node:path';
import { all, one, run, insert, update, tx, tableNames, columns, backupTo } from '../db/index.js';
import { nowIso, addMinIso, jparse, istDate, addDays, fromIst, normPhone, randomToken, fmtSlot, istParts, minutesBetween } from '../lib/util.js';
import { bad, notFound, forbidden, broadcast } from '../lib/http.js';
import { config, publicSecretsForOwner } from '../config.js';
import { eraseContact } from '../domain/privacy.js';
import { validateSettings } from '../lib/settings-validation.js';
import { validateDispatch, validateTravel, pointOK } from '../domain/dispatch.js';
import { listFullBackups } from '../lib/backups.js';
import { retryTimer } from '../core/timers.js';
import { financeSummary } from '../domain/finance.js';
import { paise, rupees } from '../lib/money.js';
import { audit, notify, createTask, getSettings, saveSettings, DEFAULT_SETTINGS, getState } from '../core/base.js';
import { enqueueWhatsApp, retryJob, outboxHealth, resolveUnknownJob } from '../core/outbox.js';
import { providerStatus } from '../whatsapp/providers.js';
import { aiStatus } from '../bot/ai.js';
import { routineStatus, runRoutine, healthReport } from '../core/routines.js';
import { staffReply, takeOver, releaseToBot } from '../bot/engine.js';
import { ensureContact, getContact, getConversation, contactProjects, displayName, projectLink, quoteLink } from '../domain/common.js';
import { getLead, createLead, updateLead, submitLead, markLost, suggestAssignment } from '../domain/leads.js';
import { createOffer, availableSlots, eligibleArchitects, candidateSlots } from '../domain/scheduling.js';
import { getVisit, cancelVisit, submitVisitReport } from '../domain/visits.js';
import { createQuotation, submitQuotation, sendQuotation, getQuote, defaultSchedule } from '../domain/quotations.js';
import { getProject, recordPayment, issueInvoice, submitMilestone, clientMilestone, createChangeRequest, addSiteLog, startNextMilestone } from '../domain/projects.js';
import { updateTicket } from '../domain/support.js';
import { listApprovals, decideApproval } from '../domain/approvals.js';
import { publicUser, createUser, updateUser, resetPin, teamBoard, updateTask, monthlySummary, attendanceMorningSweep, attendanceEveningSweep, recomputeDay } from '../domain/staff.js';
import { SERVICES, NATURES, WINDOWS, COMMERCIAL_MODELS, SERVICE_TYPES } from '../bot/catalog.js';
import { usageReport } from '../lib/costs.js';

const M = ['owner', 'manager'];
const MF = ['owner', 'manager', 'finance'];
const O = ['owner'];
const parseRow = (r, keys) => { if (!r) return r; const o = { ...r }; for (const k of keys) o[k] = jparse(o[k], k.endsWith('s') ? [] : {}); return o; };
const mediaFor = (type, id) => all('SELECT id, mime, caption, uploaded_by, created_at, lat, lng FROM media WHERE owner_type=? AND owner_id=? ORDER BY id', type, id);
const timeline = (type, id) => all('SELECT * FROM audit_log WHERE entity_type=? AND entity_id=? ORDER BY id DESC LIMIT 100', type, id).map((a) => ({ ...a, data: jparse(a.data, null) }));

export function registerAdmin(r) {
  const d = (roles = MF) => ({ auth: 'dashboard', roles });

  // ---------------- overview
  r.get('/api/dashboard/overview', d(), () => {
    const today = istDate();
    const t0 = fromIst(today, '00:00').toISOString(); const t1 = fromIst(addDays(today, 1), '00:00').toISOString();
    const d14 = fromIst(addDays(today, -13), '00:00').toISOString();
    const leadsByDay = all('SELECT substr(created_at,1,10) d, COUNT(*) n FROM leads WHERE created_at>=? GROUP BY d', d14);
    const days = []; for (let i = 13; i >= 0; i--) days.push(addDays(today, -i));
    const byDay = days.map((dd) => ({ day: dd, n: all('SELECT COUNT(*) n FROM leads WHERE created_at>=? AND created_at<?', fromIst(dd, '00:00').toISOString(), fromIst(addDays(dd, 1), '00:00').toISOString())[0].n }));
    const funnel = all("SELECT status, COUNT(*) n FROM leads WHERE created_at>=? GROUP BY status", addMinIso(nowIso(), -90 * 1440));
    const resp = one("SELECT AVG((julianday(first_response_at)-julianday(created_at))*1440) m FROM leads WHERE first_response_at IS NOT NULL AND created_at>=?", addMinIso(nowIso(), -30 * 1440)).m;
    const board = teamBoard(today);
    const month = `${istParts().y}-${String(istParts().m).padStart(2, '0')}`;
    const usage = all("SELECT COALESCE(category, CASE WHEN route='template' THEN 'utility' ELSE 'service' END) cat, COUNT(*) n FROM messages WHERE direction='out' AND status IN ('sent','delivered','read') AND created_at>=? GROUP BY cat", fromIst(`${month}-01`, '00:00').toISOString());
    return {
      kpis: {
        leadsToday: one('SELECT COUNT(*) n FROM leads WHERE created_at>=? AND created_at<?', t0, t1).n,
        openLeads: one("SELECT COUNT(*) n FROM leads WHERE status IN ('capturing','awaiting_approval','scheduling','visit_confirmed','visit_done','quoting','quote_sent','needs_followup','out_of_area')").n,
        avgFirstResponseMin: resp ? Math.round(resp * 10) / 10 : null,
        visitsToday: one("SELECT COUNT(*) n FROM visits WHERE start_at>=? AND start_at<? AND status NOT IN ('cancelled')", t0, t1).n,
        activeProjects: one("SELECT COUNT(*) n FROM projects WHERE status IN ('active','awaiting_advance','handover')").n,
        pendingApprovals: one("SELECT COUNT(*) n FROM approvals WHERE status='pending'").n,
        overdueTasks: one("SELECT COUNT(*) n FROM tasks WHERE status NOT IN ('done','cancelled') AND due_at < ?", nowIso()).n,
        needsHuman: one('SELECT COUNT(*) n FROM conversations WHERE needs_attention=1').n,
        presentToday: board.filter((b) => b.firstIn).length, teamSize: board.length,
        paymentsDue: one("SELECT COALESCE(SUM(amount-paid_amount),0) s FROM invoices WHERE status IN ('issued','partially_paid')").s,
        collectedMonth: one('SELECT COALESCE(SUM(amount),0) s FROM payments WHERE received_at>=?', fromIst(`${month}-01`, '00:00').toISOString()).s,
      },
      leadsByDay: byDay, funnel, usage, month,
      approvals: listApprovals({}).slice(0, 6),
      visitsToday: all("SELECT v.*, u.name architect, l.name client, l.ref lead_ref, l.zone FROM visits v JOIN users u ON u.id=v.architect_id JOIN leads l ON l.id=v.lead_id WHERE v.start_at>=? AND v.start_at<? AND v.status!='cancelled' ORDER BY v.start_at", t0, t1),
      attention: all('SELECT c.*, k.name, k.profile_name, k.wa_id FROM conversations c JOIN contacts k ON k.id=c.contact_id WHERE c.needs_attention=1 ORDER BY c.last_message_at DESC LIMIT 8'),
      health: healthReport(),
    };
  });

  r.get('/api/notifications', { auth: 'any' }, (ctx) => ({
    items: all('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 60', ctx.user.id),
    unread: one('SELECT COUNT(*) n FROM notifications WHERE user_id=? AND read_at IS NULL', ctx.user.id).n,
  }));
  r.post('/api/notifications/read', { auth: 'any' }, (ctx) => { run('UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL', nowIso(), ctx.user.id); return { ok: true }; });

  // ---------------- inbox
  r.get('/api/inbox', d(M), (ctx) => {
    const q = `%${ctx.query.q || ''}%`;
    const f = ctx.query.filter || 'all';
    const where = { attention: 'AND c.needs_attention=1', human: "AND c.mode='human'", unread: 'AND c.unread>0', mine: `AND c.owner_user_id=${Number(ctx.user.id)}` }[f] || '';
    return all(`SELECT c.*, k.wa_id, k.name, k.profile_name, k.kind, k.language, k.opted_out, k.last_inbound_at,
      (SELECT ref FROM leads WHERE contact_id=k.id ORDER BY id DESC LIMIT 1) lead_ref,
      (SELECT ref FROM projects WHERE client_contact_id=k.id ORDER BY id DESC LIMIT 1) project_ref
      FROM conversations c JOIN contacts k ON k.id=c.contact_id
      WHERE c.last_message_at IS NOT NULL AND (k.name LIKE ? OR k.profile_name LIKE ? OR k.wa_id LIKE ?) ${where}
      ORDER BY c.needs_attention DESC, c.last_message_at DESC LIMIT 200`, q, q, q);
  });
  r.get('/api/inbox/:id', d(M), (ctx) => {
    const c = getContact(Number(ctx.params.id)); if (!c) throw notFound();
    const conv = getConversation(c.id);
    const owner = conv?.owner_user_id ? one('SELECT id, name FROM users WHERE id=?', conv.owner_user_id) : null;
    return {
      contact: { ...c, tags: jparse(c.tags, []) }, conversation: conv ? { ...conv, ctx: jparse(conv.ctx, {}), owner } : null,
      windowOpen: !!c.last_inbound_at && minutesBetween(c.last_inbound_at, nowIso()) < 24 * 60 - 10,
      messages: all('SELECT * FROM (SELECT * FROM messages WHERE contact_id=? ORDER BY id DESC LIMIT 300) ORDER BY id', c.id).map((m) => ({ ...m, payload: jparse(m.payload, null) })),
      leads: all('SELECT id, ref, status, created_at FROM leads WHERE contact_id=? ORDER BY id DESC', c.id),
      projects: contactProjects(c).map((p) => ({ id: p.id, ref: p.ref, status: p.status })),
      tickets: all("SELECT id, ref, subject, status FROM tickets WHERE contact_id=? ORDER BY id DESC LIMIT 10", c.id),
      templates: all("SELECT name, language, status, body, params FROM wa_templates ORDER BY name"),
    };
  });
  r.post('/api/inbox/:id/reply', d(M), (ctx) => { const text = String(ctx.body?.text || '').trim(); if (!text) throw bad('Type a message'); return staffReply(Number(ctx.params.id), ctx.user, text.slice(0, 4000)); });
  r.post('/api/inbox/:id/takeover', d(M), (ctx) => takeOver(Number(ctx.params.id), ctx.user));
  r.post('/api/inbox/:id/release', d(M), (ctx) => { const conv = getConversation(Number(ctx.params.id)); releaseToBot(conv.id, `released by user ${ctx.user.id}`); return { ok: true }; });
  r.post('/api/inbox/:id/read', d(M), (ctx) => { run('UPDATE conversations SET unread=0 WHERE contact_id=?', Number(ctx.params.id)); broadcast('inbox'); return { ok: true }; });
  r.post('/api/inbox/:id/resolve', d(M), (ctx) => { run('UPDATE conversations SET needs_attention=0, attention_reason=NULL WHERE contact_id=?', Number(ctx.params.id)); broadcast('inbox'); return { ok: true }; });
  r.post('/api/inbox/:id/template', d(M), (ctx) => tx(() => {
    const c = getContact(Number(ctx.params.id)); const { name, params = [] } = ctx.body || {};
    const tpl = one('SELECT * FROM wa_templates WHERE name=? LIMIT 1', name); if (!tpl) throw bad('Unknown template');
    const id = enqueueWhatsApp({ to: c.wa_id, kind: 'staff.template', sender: `user:${ctx.user.id}`, essential: true, message: { type: 'text', text: tpl.body.replace(/\{\{(\d+)\}\}/g, (_, n) => params[n - 1] ?? '') }, template: { name, params } });
    audit(`user:${ctx.user.id}`, 'conversation.template', 'contact', c.id, { name });
    return { ok: true, outboxId: id };
  }));
  r.post('/api/inbox/new', d(M), (ctx) => tx(() => {
    const wa = normPhone(ctx.body?.phone); if (!wa || wa.length < 11) throw bad('Enter a valid phone number');
    const c = ensureContact(wa, { name: ctx.body?.name || null });
    return { ok: true, contactId: c.id };
  }));

  // ---------------- leads
  r.get('/api/leads', d(), (ctx) => {
    const q = `%${ctx.query.q || ''}%`;
    const st = ctx.query.status;
    const rows = all(`SELECT l.*, (SELECT name FROM users WHERE id=l.owner_id) owner_name FROM leads l WHERE (l.name LIKE ? OR l.ref LIKE ? OR l.phone LIKE ? OR l.locality LIKE ?) ${st ? 'AND l.status=?' : ''} ORDER BY l.id DESC LIMIT 500`, q, q, q, q, ...(st ? [st] : []));
    return rows.map((l) => parseRow(l, ['services', 'preferred_slots']));
  });
  r.get('/api/leads/:id', d(), (ctx) => {
    const l = getLead(Number(ctx.params.id)); if (!l) throw notFound();
    return {
      lead: parseRow(l, ['services', 'preferred_slots']), contact: getContact(l.contact_id),
      offers: all('SELECT o.*, u.name architect FROM visit_offers o JOIN users u ON u.id=o.architect_id WHERE o.lead_id=? ORDER BY o.id DESC', l.id),
      visits: all('SELECT v.*, u.name architect FROM visits v JOIN users u ON u.id=v.architect_id WHERE v.lead_id=? ORDER BY v.id DESC', l.id).map((v) => parseRow(v, ['report'])),
      quotations: all('SELECT * FROM quotations WHERE lead_id=? ORDER BY version DESC', l.id).map((q) => ({ ...parseRow(q, ['items', 'payment_schedule']), link: q.public_token ? quoteLink(q) : null })),
      approvals: all('SELECT * FROM approvals WHERE entity_type=? AND entity_id=? ORDER BY id DESC', 'lead', l.id),
      media: mediaFor('lead', l.id), timeline: timeline('lead', l.id),
      suggestion: ['awaiting_approval', 'needs_followup', 'out_of_area'].includes(l.status) ? suggestAssignment(l) : null,
    };
  });
  r.post('/api/leads', d(M), (ctx) => tx(() => {
    const b = ctx.body || {}; const wa = normPhone(b.phone);
    if (!wa || wa.length < 11) throw bad('Enter the client\'s phone number');
    const c = ensureContact(wa, { name: b.name });
    const lead = createLead({ contactId: c.id, source: b.source || 'manual', fields: { name: b.name, services: b.services || [], zone: b.zone, locality: b.locality, project_nature: b.project_nature, area_sqft: b.area_sqft ? Number(b.area_sqft) : null, area_text: b.area_sqft ? `${b.area_sqft} sq ft` : null, execution_window: b.execution_window, requirements: b.requirements, address: b.address, consent: true }, actor: `user:${ctx.user.id}` });
    if (b.slot) updateLead(lead.id, { preferred_slots: [b.slot] }, `user:${ctx.user.id}`);
    if (b.submit) submitLead(lead.id, { actor: `user:${ctx.user.id}` });
    return { id: lead.id, ref: lead.ref };
  }));
  r.patch('/api/leads/:id', d(M), (ctx) => tx(() => {
    const b = ctx.body || {}; const id = Number(ctx.params.id);
    if (b.status === 'lost') { markLost(id, b.lost_reason || 'Closed by manager', `user:${ctx.user.id}`); return { ok: true }; }
    const patch = { ...b }; delete patch.status;
    if (patch.area_sqft !== undefined) patch.area_sqft = patch.area_sqft ? Number(patch.area_sqft) : null;
    updateLead(id, patch, `user:${ctx.user.id}`);
    return { ok: true };
  }));
  r.post('/api/leads/:id/submit', d(M), (ctx) => tx(() => submitLead(Number(ctx.params.id), { actor: `user:${ctx.user.id}` })));
  r.post('/api/leads/:id/offer', d(M), (ctx) => {
    const res = createOffer(Number(ctx.params.id), { architectId: ctx.body?.architectId || null, slotStart: ctx.body?.slotStart || null, createdBy: `user:${ctx.user.id}` });
    if (res.error) throw bad(res.error);
    return res;
  });
  r.get('/api/leads/:id/slots', d(M), (ctx) => {
    const l = getLead(Number(ctx.params.id)); if (!l) throw notFound();
    const dur = getSettings().visit_duration_min;
    return candidateSlots(5).slice(0, 24).map((s) => ({ start: s.toISOString(), label: fmtSlot(s), architects: eligibleArchitects(l, s, new Date(s.getTime() + dur * 60000)).slice(0, 5).map((x) => ({ id: x.user.id, name: x.user.name, score: x.score })) }));
  });

  // ---------------- approvals
  r.get('/api/approvals', d(), (ctx) => listApprovals({ status: ctx.query.status || 'pending', kind: ctx.query.kind }));
  r.post('/api/approvals/:id/decide', d(), (ctx) => {
    const a = one('SELECT kind FROM approvals WHERE id=?', Number(ctx.params.id)); if (!a) throw notFound();
    if (ctx.user.role === 'finance' && !['expense', 'payroll'].includes(a.kind)) throw forbidden('Finance can decide expenses and payroll only');
    const res = decideApproval(Number(ctx.params.id), ctx.body || {}, ctx.user);
    if (res?.error) throw bad(res.error);
    broadcast('approvals');
    return res;
  });

  // ---------------- visits
  r.get('/api/visits', d(), (ctx) => {
    const from = ctx.query.from || fromIst(addDays(istDate(), -1), '00:00').toISOString();
    const to = ctx.query.to || fromIst(addDays(istDate(), 14), '00:00').toISOString();
    return {
      visits: all("SELECT v.*, u.name architect, l.name client, l.ref lead_ref, l.zone, l.locality, l.phone FROM visits v JOIN users u ON u.id=v.architect_id JOIN leads l ON l.id=v.lead_id WHERE v.start_at>=? AND v.start_at<? ORDER BY v.start_at", from, to),
      offers: all("SELECT o.*, u.name architect, l.name client, l.ref lead_ref, l.zone FROM visit_offers o JOIN users u ON u.id=o.architect_id JOIN leads l ON l.id=o.lead_id WHERE o.status IN ('pending','accepted') ORDER BY o.slot_start"),
      architects: all("SELECT id, name, zones FROM users WHERE active=1 AND role IN ('architect','engineer') ORDER BY name").map((u) => ({ ...u, zones: jparse(u.zones, []) })),
      leaves: all("SELECT h.*, u.name FROM calendar_holds h JOIN users u ON u.id=h.user_id WHERE h.kind IN ('leave','block') AND h.status='active' AND h.end_at>=? AND h.start_at<?", from, to),
    };
  });
  r.get('/api/visits/:id', d(), (ctx) => { const v = getVisit(Number(ctx.params.id)); if (!v) throw notFound(); return { visit: parseRow(v, ['report']), lead: getLead(v.lead_id), architect: publicUser(one('SELECT * FROM users WHERE id=?', v.architect_id)), media: mediaFor('visit', v.id), timeline: timeline('visit', v.id) }; });
  r.post('/api/visits/:id/cancel', d(M), (ctx) => { const res = tx(() => cancelVisit(Number(ctx.params.id), { reason: ctx.body?.reason || 'Cancelled by manager', actor: `user:${ctx.user.id}`, reslot: !!ctx.body?.reslot })); if (res.error) throw bad(res.error); return res; });
  r.post('/api/visits/:id/report', d(M), (ctx) => { const res = tx(() => submitVisitReport(Number(ctx.params.id), null, ctx.body || {})); if (res.error) throw bad(res.error); return res; });

  // ---------------- quotations
  r.get('/api/quote-defaults', d(), () => ({ schedules: getSettings().default_payment_schedules, gst: getSettings().gst_pct, models: COMMERCIAL_MODELS, types: SERVICE_TYPES }));
  r.post('/api/leads/:id/quotations', d(M), (ctx) => { const res = tx(() => createQuotation(Number(ctx.params.id), ctx.body || {}, ctx.user)); if (res.error) throw bad(res.error); if (ctx.body?.submit) tx(() => submitQuotation(res.id, ctx.user)); return res; });
  r.post('/api/quotations/:id/submit', d(M), (ctx) => { const res = tx(() => submitQuotation(Number(ctx.params.id), ctx.user)); if (res.error) throw bad(res.error); return res; });
  r.post('/api/quotations/:id/resend', d(M), (ctx) => { const q = getQuote(Number(ctx.params.id)); if (!q || q.status !== 'sent') throw bad('Only a sent quotation can be resent'); return tx(() => sendQuotation(q.id, ctx.user)); });

  // ---------------- projects
  r.get('/api/projects', d(), (ctx) => all(`SELECT p.*, (SELECT name FROM users WHERE id=p.supervisor_id) supervisor, (SELECT name FROM users WHERE id=p.manager_id) manager,
    (SELECT name FROM milestones WHERE project_id=p.id AND status IN ('in_progress','ready_for_review','rework','client_review') ORDER BY seq LIMIT 1) current_stage,
    (SELECT progress FROM milestones WHERE project_id=p.id AND status IN ('in_progress','ready_for_review','rework','client_review') ORDER BY seq LIMIT 1) current_progress,
    ((SELECT COALESCE(SUM(amount),0) FROM payments WHERE project_id=p.id)-(SELECT COALESCE(SUM(amount),0) FROM refunds WHERE project_id=p.id)) paid,
    (SELECT MAX(log_date) FROM site_logs WHERE project_id=p.id) last_log
    FROM projects p ${ctx.query.status ? 'WHERE p.status=?' : ''} ORDER BY p.id DESC`, ...(ctx.query.status ? [ctx.query.status] : [])));
  r.get('/api/projects/:id', d(), (ctx) => {
    const p = getProject(Number(ctx.params.id)); if (!p) throw notFound();
    const logs = all('SELECT l.*, u.name author FROM site_logs l LEFT JOIN users u ON u.id=l.user_id WHERE l.project_id=? ORDER BY l.log_date DESC, l.id DESC LIMIT 60', p.id).map((l) => ({ ...parseRow(l, ['labour']), media: mediaFor('site_log', l.id) }));
    return {
      project: { ...p, authorized_phones: jparse(p.authorized_phones, []), link: projectLink(p) },
      milestones: all('SELECT * FROM milestones WHERE project_id=? ORDER BY seq', p.id),
      invoices: all('SELECT * FROM invoices WHERE project_id=? ORDER BY id', p.id),
      payments: all('SELECT * FROM payments WHERE project_id=? ORDER BY id DESC', p.id),
      changes: all('SELECT * FROM change_requests WHERE project_id=? ORDER BY id DESC', p.id),
      tickets: all('SELECT * FROM tickets WHERE project_id=? ORDER BY id DESC', p.id),
      logs, media: mediaFor('project', p.id), timeline: timeline('project', p.id),
      team: all("SELECT id, name, role, phone FROM users WHERE active=1 ORDER BY name"),
      client: getContact(p.client_contact_id),
    };
  });
  r.patch('/api/projects/:id', d(M), (ctx) => tx(() => {
    const id = Number(ctx.params.id); const b = ctx.body || {}; const p = getProject(id); if (!p) throw notFound();
    const allowed = ['name', 'address', 'site_lat', 'site_lng', 'geofence_m', 'zone', 'manager_id', 'architect_id', 'supervisor_id', 'engineer_id', 'start_date', 'target_end', 'digest_enabled', 'portfolio_consent', 'notes', 'status', 'client_name', 'area_sqft'];
    const patch = { updated_at: nowIso() };
    for (const k of allowed) if (b[k] !== undefined) patch[k] = b[k] === '' ? null : b[k];
    if (patch.status && !['active', 'on_hold', 'closed', 'cancelled', 'awaiting_advance', 'handover', 'warranty'].includes(patch.status)) throw bad('Invalid status');
    if (patch.status && ['warranty', 'closed'].includes(patch.status) && p.require_payment_before_handover && financeSummary(id).due > 0) throw bad('Clear the project balance before handover or closing');
    if (patch.site_lat !== undefined || patch.site_lng !== undefined) { const lat = patch.site_lat === undefined ? p.site_lat : patch.site_lat, lng = patch.site_lng === undefined ? p.site_lng : patch.site_lng; if (!(lat === null && lng === null) && !pointOK(lat, lng)) throw bad('Enter a valid pair of site coordinates'); }
    if (patch.geofence_m !== undefined && (!Number.isFinite(Number(patch.geofence_m)) || Number(patch.geofence_m) < 10 || Number(patch.geofence_m) > 10000)) throw bad('Geofence must be between 10 and 10000 metres');
    if (b.authorized_phones) patch.authorized_phones = JSON.stringify(b.authorized_phones.map(normPhone).filter((x) => x.length >= 11));
    update('projects', id, patch);
    if (b.supervisor_id && b.supervisor_id !== p.supervisor_id) notify({ userId: Number(b.supervisor_id), title: `You are the supervisor for ${p.ref}`, link: '#/projects' });
    audit(`user:${ctx.user.id}`, 'project.update', 'project', id, b);
    broadcast('projects');
    return { ok: true };
  }));
  r.patch('/api/milestones/:id', d(M), (ctx) => tx(() => {
    const m = one('SELECT * FROM milestones WHERE id=?', Number(ctx.params.id)); if (!m) throw notFound();
    const b = ctx.body || {}; const patch = { updated_at: nowIso() };
    for (const k of ['name', 'planned_start', 'planned_end', 'progress']) if (b[k] !== undefined) patch[k] = b[k];
    if (b.start && m.status === 'planned') patch.status = 'in_progress';
    update('milestones', m.id, patch);
    audit(`user:${ctx.user.id}`, 'milestone.update', 'project', m.project_id, b);
    broadcast('projects');
    return { ok: true };
  }));
  r.post('/api/milestones/:id/submit', d(M), (ctx) => { const res = tx(() => submitMilestone(Number(ctx.params.id), ctx.user.id, ctx.body?.note)); if (res.error) throw bad(res.error); return res; });
  r.post('/api/milestones/:id/client-override', d(M), (ctx) => { const res = tx(() => clientMilestone(Number(ctx.params.id), ctx.body?.approve !== false, { note: ctx.body?.note || `Recorded by ${ctx.user.name}`, actor: `user:${ctx.user.id}` })); if (res.stale) throw bad('Stage is not waiting for client sign-off'); return res; });
  r.post('/api/projects/:id/next-milestone', d(M), (ctx) => tx(() => ({ started: startNextMilestone(Number(ctx.params.id)) })));
  r.post('/api/projects/:id/invoices', d(MF), (ctx) => tx(() => {
    const p = getProject(Number(ctx.params.id)); const b = ctx.body || {};
    if (!p) throw notFound('Project not found');
    let amount; try { amount = rupees(paise(b.amount, { min: 0.01 })); } catch (e) { throw bad(e.message); }
    if (b.payment_link) { try { if (!['https:', 'http:'].includes(new URL(b.payment_link).protocol)) throw new Error(); } catch { throw bad('Payment link must be an HTTP or HTTPS URL'); } }
    if (b.due_date && (!/^\d{4}-\d{2}-\d{2}$/.test(b.due_date) || !Number.isFinite(Date.parse(b.due_date)))) throw bad('Enter a valid due date');
    const inv = issueInvoice(p, { id: null, amount, name: b.title || 'Invoice' }, { title: b.title });
    if (b.due_date) run('UPDATE invoices SET due_date=? WHERE id=?', b.due_date, inv.id);
    if (b.payment_link) run('UPDATE invoices SET payment_link=? WHERE id=?', b.payment_link, inv.id);
    return { ok: true, id: inv.id };
  }));
  r.patch('/api/invoices/:id', d(MF), (ctx) => tx(() => {
    const id = Number(ctx.params.id); const invoice = one('SELECT * FROM invoices WHERE id=?', id);
    if (!invoice) throw notFound('Invoice not found');
    const b = ctx.body; if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad('Invoice changes must be an object');
    const patch = {};
    if (b.payment_link !== undefined) {
      if (b.payment_link === '' || b.payment_link === null) patch.payment_link = null;
      else {
        if (typeof b.payment_link !== 'string' || b.payment_link.length > 2048) throw bad('Payment link must be a valid HTTP or HTTPS URL');
        try { const url = new URL(b.payment_link); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error(); }
        catch { throw bad('Payment link must be an HTTP or HTTPS URL without embedded credentials'); }
        patch.payment_link = b.payment_link;
      }
    }
    if (b.due_date !== undefined) {
      if (b.due_date === '' || b.due_date === null) patch.due_date = null;
      else {
        const date = typeof b.due_date === 'string' ? new Date(`${b.due_date}T00:00:00Z`) : null;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(b.due_date) || !date || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== b.due_date) throw bad('Enter a valid due date');
        patch.due_date = b.due_date;
      }
    }
    if (b.status !== undefined) {
      if (b.status !== 'cancelled') throw bad('Use payment or credit controls to change invoice status');
      if (invoice.paid_amount > 0 || ['paid', 'partially_paid'].includes(invoice.status) || one('SELECT 1 FROM payments WHERE invoice_id=?', id)) throw bad('A paid or partially paid invoice cannot be cancelled; use the credit and refund controls');
      patch.status = 'cancelled';
    }
    if (!Object.keys(patch).length) throw bad('No invoice changes provided');
    update('invoices', id, patch);
    audit(`user:${ctx.user.id}`, 'invoice.updated', 'project', invoice.project_id, { invoiceId: id, ...patch, reason: typeof b.reason === 'string' ? b.reason.slice(0, 1000) : null });
    broadcast('projects'); return { ok: true };
  }));
  r.post('/api/invoices/:id/payments', d(MF), (ctx) => { const res = tx(() => recordPayment(Number(ctx.params.id), ctx.body || {}, ctx.user)); if (res.error) throw bad(res.error); return res; });
  r.post('/api/projects/:id/changes', d(M), (ctx) => { const res = tx(() => createChangeRequest(Number(ctx.params.id), ctx.body || {}, ctx.user)); if (res.error) throw bad(res.error); return res; });
  r.post('/api/projects/:id/logs', d(M), (ctx) => { const res = tx(() => addSiteLog(Number(ctx.params.id), ctx.user.id, ctx.body || {})); if (res.error) throw bad(res.error); return res; });
  r.post('/api/projects/:id/update', d(M), (ctx) => tx(() => {
    const p = getProject(Number(ctx.params.id)); const c = getContact(p.client_contact_id); const text = String(ctx.body?.text || '').trim();
    if (!text) throw bad('Type the update');
    enqueueWhatsApp({ to: c.wa_id, kind: 'project.manual_update', sender: `user:${ctx.user.id}`, essential: true, message: { type: 'text', text: `🏗 ${p.ref}: ${text}` }, template: { name: 'ns_client_update', params: [p.ref, text.slice(0, 600)] } });
    return { ok: true };
  }));

  // ---------------- clients (contacts)
  r.get('/api/contacts', d(), (ctx) => {
    const q = `%${ctx.query.q || ''}%`;
    const kind = ctx.query.kind || 'client';
    if (!['all','client','vendor','job_seeker','staff','spam'].includes(kind)) throw bad('Invalid contact category');
    if (ctx.user.role === 'finance' && kind !== 'client') throw forbidden('The contact directory is available to managers');
    const filter = kind === 'all' ? '' : kind === 'staff' ? "AND (k.user_id IS NOT NULL OR k.kind='staff')" : 'AND k.user_id IS NULL AND k.kind=?';
    return all(`SELECT k.*, (SELECT COUNT(*) FROM leads WHERE contact_id=k.id) leads, (SELECT COUNT(*) FROM projects WHERE client_contact_id=k.id) projects
      FROM contacts k WHERE (k.name LIKE ? OR k.profile_name LIKE ? OR k.wa_id LIKE ?) ${filter} ORDER BY COALESCE(k.last_inbound_at, k.created_at) DESC LIMIT 500`, q, q, q, ...(['all','staff'].includes(kind) ? [] : [kind])).map((c) => ({ ...c, kind: c.user_id ? 'staff' : c.kind, tags: jparse(c.tags, []) }));
  });
  r.get('/api/contacts/:id', d(), (ctx) => {
    const c = getContact(Number(ctx.params.id)); if (!c) throw notFound();
    if (ctx.user.role === 'finance' && (c.user_id || c.kind !== 'client')) throw forbidden('The contact directory is available to managers');
    return { contact: { ...c, tags: jparse(c.tags, []) }, leads: all('SELECT * FROM leads WHERE contact_id=? ORDER BY id DESC', c.id), projects: all('SELECT * FROM projects WHERE client_contact_id=? ORDER BY id DESC', c.id), tickets: all('SELECT * FROM tickets WHERE contact_id=? ORDER BY id DESC', c.id), media: mediaFor('contact', c.id), timeline: timeline('contact', c.id) };
  });
  r.patch('/api/contacts/:id', d(M), (ctx) => tx(() => {
    const b = ctx.body || {}; const patch = { updated_at: nowIso() };
    const c = getContact(Number(ctx.params.id)); if (!c) throw notFound();
    if (b.kind !== undefined && (!['client','vendor','job_seeker','spam','staff'].includes(b.kind) || (c.user_id && b.kind !== 'staff') || (!c.user_id && b.kind === 'staff'))) throw bad('Staff contacts are managed through Team; choose a valid external contact category');
    if (b.language !== undefined && !['en','hi'].includes(b.language)) throw bad('Choose English or Hindi');
    for (const [key, max] of [['name',120],['email',254],['notes',4000]]) if (b[key] !== undefined && (typeof b[key] !== 'string' || b[key].length > max)) throw bad(`Invalid ${key}`);
    if (b.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email)) throw bad('Enter a valid email');
    if (b.tags !== undefined && (!Array.isArray(b.tags) || b.tags.length > 30 || b.tags.some(t => typeof t !== 'string' || t.length > 80))) throw bad('Tags must be a list of short labels');
    if (b.opted_out !== undefined && typeof b.opted_out !== 'boolean') throw bad('Opt-out must be true or false');
    for (const k of ['name', 'email', 'kind', 'language', 'notes']) if (b[k] !== undefined) patch[k] = b[k];
    if (b.tags) patch.tags = JSON.stringify(b.tags);
    if (b.opted_out !== undefined) { patch.opted_out = b.opted_out ? 1 : 0; patch.opted_out_at = b.opted_out ? nowIso() : null; }
    update('contacts', Number(ctx.params.id), patch);
    audit(`user:${ctx.user.id}`, 'contact.update', 'contact', Number(ctx.params.id), b);
    return { ok: true };
  }));
  r.post('/api/contacts/:id/erase', d(O), (ctx) => tx(() => eraseContact(Number(ctx.params.id), ctx.user)));

  // ---------------- team & attendance
  r.get('/api/team', d(), () => all('SELECT * FROM users ORDER BY active DESC, role, name').map(publicUser));
  r.post('/api/team', d(M), (ctx) => { if (ctx.body?.role === 'owner' && ctx.user.role !== 'owner') throw forbidden(); const res = tx(() => createUser(ctx.body || {}, ctx.user)); if (res.error) throw bad(res.error); return res; });
  r.patch('/api/team/:id', d(M), (ctx) => { const id = Number(ctx.params.id); const target = one('SELECT role FROM users WHERE id=?', id); if ((target?.role === 'owner' || ctx.body?.role === 'owner') && ctx.user.role !== 'owner') throw forbidden(); if (id === ctx.user.id && ctx.body?.password) throw bad('Change your own password in My security, where your current credentials are verified'); const res = tx(() => updateUser(id, ctx.body || {}, ctx.user)); if (res.error) throw bad(res.error); return res; });
  r.post('/api/team/:id/reset-pin', d(M), (ctx) => tx(() => resetPin(Number(ctx.params.id), ctx.user)));
  r.get('/api/team/board', d(), (ctx) => teamBoard(ctx.query.day || istDate()));
  r.get('/api/team/:id', d(), (ctx) => {
    const u = one('SELECT * FROM users WHERE id=?', Number(ctx.params.id)); if (!u) throw notFound();
    const month = ctx.query.month || istDate().slice(0, 7);
    return {
      user: publicUser(u), days: all('SELECT * FROM attendance_days WHERE user_id=? AND day LIKE ? ORDER BY day', u.id, `${month}%`),
      events: all('SELECT * FROM attendance_events WHERE user_id=? ORDER BY effective_time DESC LIMIT 60', u.id).map((e) => parseRow(e, ['reasons'])),
      tasks: all("SELECT * FROM tasks WHERE assignee_id=? AND (status NOT IN ('done','cancelled') OR updated_at > ?) ORDER BY status, due_at", u.id, addMinIso(nowIso(), -7 * 1440)),
      visits: all("SELECT v.*, l.ref lead_ref, l.name client FROM visits v JOIN leads l ON l.id=v.lead_id WHERE v.architect_id=? ORDER BY v.start_at DESC LIMIT 30", u.id),
      logs: all('SELECT l.*, p.ref FROM site_logs l JOIN projects p ON p.id=l.project_id WHERE l.user_id=? ORDER BY l.id DESC LIMIT 30', u.id),
      leave: all('SELECT * FROM leave_requests WHERE user_id=? ORDER BY id DESC LIMIT 20', u.id),
      expenses: all('SELECT * FROM expense_claims WHERE user_id=? ORDER BY id DESC LIMIT 20', u.id),
      activity: all("SELECT * FROM audit_log WHERE actor=? ORDER BY id DESC LIMIT 40", `user:${u.id}`),
    };
  });
  r.get('/api/attendance/register', d(), (ctx) => {
    const month = ctx.query.month || istDate().slice(0, 7);
    const users = all("SELECT id, name, role FROM users WHERE active=1 AND role!='owner' ORDER BY role, name");
    const rows = all('SELECT * FROM attendance_days WHERE day LIKE ?', `${month}%`);
    return { month, users, days: rows };
  });
  r.get('/api/attendance/events', d(), (ctx) => {
    const day = ctx.query.day || istDate();
    return all('SELECT e.*, u.name FROM attendance_events e JOIN users u ON u.id=e.user_id WHERE e.effective_time>=? AND e.effective_time<? ORDER BY e.effective_time DESC', fromIst(day, '00:00').toISOString(), fromIst(addDays(day, 1), '00:00').toISOString()).map((e) => parseRow(e, ['reasons']));
  });
  r.post('/api/attendance/recompute', d(M), (ctx) => tx(() => { const day = ctx.body?.day || istDate(); for (const u of all('SELECT id FROM users WHERE active=1')) recomputeDay(u.id, day); return { ok: true }; }));
  r.get('/api/leave', d(), () => all('SELECT l.*, u.name FROM leave_requests l JOIN users u ON u.id=l.user_id ORDER BY l.id DESC LIMIT 200'));
  r.get('/api/expenses', d(), () => all('SELECT e.*, u.name, p.ref project_ref FROM expense_claims e JOIN users u ON u.id=e.user_id LEFT JOIN projects p ON p.id=e.project_id ORDER BY e.id DESC LIMIT 300'));
  r.post('/api/expenses/:id/paid', d(MF), (ctx) => tx(() => { const e = one('SELECT * FROM expense_claims WHERE id=?', Number(ctx.params.id)); if (!e || e.status !== 'approved') throw bad('Only approved claims can be marked paid'); update('expense_claims', e.id, { status: 'paid' }); notify({ userId: e.user_id, title: 'Expense paid 💸', body: `₹${e.amount}` }); audit(`user:${ctx.user.id}`, 'expense.paid', 'expense', e.id); return { ok: true }; }));
  r.get('/api/payroll', d(), (ctx) => monthlySummary(ctx.query.month));
  r.get('/api/payroll/export.csv', d(), (ctx) => {
    const s = monthlySummary(ctx.query.month);
    const head = ['Name', 'Role', 'Present', 'Late', 'Half day', 'Absent', 'Leave', 'Needs review', 'Hours', 'Approved expenses'];
    const csv = [head.join(','), ...s.rows.map((r2) => [r2.name, r2.role, r2.present, r2.late, r2.half_day, r2.absent, r2.leave, r2.needs_review, r2.hours, r2.expenses].map(csvCell).join(','))].join('\n');
    ctx.res.setHeader('Content-Disposition', `attachment; filename="payroll-${s.month}.csv"`);
    ctx.text(csv, 200, 'text/csv; charset=utf-8');
  });

  // ---------------- tasks & tickets
  r.get('/api/tasks', d(), (ctx) => {
    const st = ctx.query.status || 'open';
    const where = st === 'open' ? "t.status NOT IN ('done','cancelled')" : st === 'all' ? '1=1' : 't.status=?';
    return all(`SELECT t.*, u.name assignee FROM tasks t LEFT JOIN users u ON u.id=t.assignee_id WHERE ${where} ${ctx.query.assignee ? 'AND t.assignee_id=?' : ''} ORDER BY CASE t.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, COALESCE(t.due_at, '9999'), t.id DESC LIMIT 500`,
      ...(st !== 'open' && st !== 'all' ? [st] : []), ...(ctx.query.assignee ? [Number(ctx.query.assignee)] : []));
  });
  r.post('/api/tasks', d(M), (ctx) => tx(() => { const b = ctx.body || {}; if (!b.title) throw bad('Title is required'); const id = createTask({ title: b.title, description: b.description, assigneeId: b.assignee_id ? Number(b.assignee_id) : null, priority: b.priority || 'normal', dueAt: b.due_at || null, entityType: b.entity_type, entityId: b.entity_id, createdBy: `user:${ctx.user.id}` }); return { id }; }));
  r.patch('/api/tasks/:id', d(M), (ctx) => { const res = tx(() => updateTask(Number(ctx.params.id), ctx.body || {}, ctx.user)); if (res.error) throw bad(res.error); return res; });
  r.get('/api/tickets', d(), () => all("SELECT t.*, k.name, k.profile_name, k.wa_id, p.ref project_ref, u.name assignee FROM tickets t LEFT JOIN contacts k ON k.id=t.contact_id LEFT JOIN projects p ON p.id=t.project_id LEFT JOIN users u ON u.id=t.assignee_id ORDER BY CASE WHEN t.status IN ('resolved','closed') THEN 1 ELSE 0 END, t.id DESC LIMIT 300"));
  r.patch('/api/tickets/:id', d(M), (ctx) => { const res = tx(() => updateTicket(Number(ctx.params.id), ctx.body || {}, ctx.user)); if (res.error) throw bad(res.error); return res; });

  // ---------------- messages / outbox / templates
  r.get('/api/messages/outbox', d(M), (ctx) => all(`SELECT o.id, o.channel, o.to_wa_id, o.kind, o.status, o.attempts, o.route, o.last_error, o.error_code, o.created_at, o.sent_at, o.next_attempt_at, k.name, k.profile_name FROM outbox o LEFT JOIN contacts k ON k.id=o.contact_id ${ctx.query.status ? 'WHERE o.status=?' : ''} ORDER BY o.id DESC LIMIT 300`, ...(ctx.query.status ? [ctx.query.status] : [])));
  r.post('/api/messages/outbox/:id/retry', d(M), (ctx) => ({ ok: tx(() => retryJob(Number(ctx.params.id), `user:${ctx.user.id}`)) }));
  r.post('/api/messages/outbox/:id/reconcile', d(M), (ctx) => tx(() => resolveUnknownJob(Number(ctx.params.id), `user:${ctx.user.id}`, ctx.body || {})));
  r.get('/api/messages/templates', d(M), () => all('SELECT * FROM wa_templates ORDER BY name, language').map((t) => parseRow(t, ['params', 'buttons'])));
  r.patch('/api/messages/templates', d(M), (ctx) => tx(() => { const { name, language, status } = ctx.body || {}; if (!['draft', 'submitted', 'approved', 'rejected'].includes(status)) throw bad('Bad status'); run('UPDATE wa_templates SET status=?, updated_at=? WHERE name=? AND language=?', status, nowIso(), name, language); audit(`user:${ctx.user.id}`, 'template.status', 'template', null, { name, language, status }); return { ok: true }; }));
  r.get('/api/messages/usage', d(M), (ctx) => {
    try { return usageReport(ctx.query.month); } catch (error) { throw bad(error.message); }
  });
  r.get('/api/inbound/failed', d(M), () => all("SELECT id, kind, wa_id, last_error, attempts, received_at FROM inbound_events WHERE status='failed' ORDER BY id DESC LIMIT 100"));
  r.post('/api/inbound/:id/retry', d(M), (ctx) => { run("UPDATE inbound_events SET status='pending', attempts=0 WHERE id=? AND status='failed'", Number(ctx.params.id)); return { ok: true }; });

  // ---------------- data (database dashboard)
  const HIDDEN_COLS = { users: ['password_hash', 'pin_hash'], sessions: ['token_hash'] };
  const PRIVATE_TABLES = ['sessions', 'account_security', 'architect_locations', 'route_cache', 'visit_travel'];
  r.get('/api/data/tables', d(M), () => tableNames().filter((t) => !PRIVATE_TABLES.includes(t)).map((t) => ({ name: t, rows: one(`SELECT COUNT(*) n FROM ${t}`).n })));
  r.get('/api/data/tables/:name', d(M), (ctx) => {
    const t = ctx.params.name; if (!tableNames().includes(t) || PRIVATE_TABLES.includes(t)) throw notFound();
    const cols = columns(t).filter((c) => !(HIDDEN_COLS[t] || []).includes(c));
    const page = Math.max(0, Number(ctx.query.page || 0)); const size = 50;
    const q = ctx.query.q ? `%${ctx.query.q}%` : null;
    const textCols = cols.slice(0, 12);
    const where = q ? `WHERE ${textCols.map((c) => `CAST(${c} AS TEXT) LIKE ?`).join(' OR ')}` : '';
    const params = q ? textCols.map(() => q) : [];
    const total = one(`SELECT COUNT(*) n FROM ${t} ${where}`, ...params).n;
    const rows = all(`SELECT ${cols.join(',')} FROM ${t} ${where} ORDER BY rowid DESC LIMIT ? OFFSET ?`, ...params, size, page * size);
    return { name: t, columns: cols, rows, total, page, size };
  });
  r.get('/api/data/tables/:name/export.csv', d(M), (ctx) => {
    const t = ctx.params.name; if (!tableNames().includes(t) || PRIVATE_TABLES.includes(t)) throw notFound();
    const cols = columns(t).filter((c) => !(HIDDEN_COLS[t] || []).includes(c));
    const rows = all(`SELECT ${cols.join(',')} FROM ${t} ORDER BY rowid`);
    audit(`user:${ctx.user.id}`, 'data.export', t, null, { rows: rows.length });
    ctx.res.setHeader('Content-Disposition', `attachment; filename="${t}-${istDate()}.csv"`);
    ctx.text([cols.join(','), ...rows.map((r2) => cols.map((c) => csvCell(r2[c])).join(','))].join('\n'), 200, 'text/csv; charset=utf-8');
  });
  r.get('/api/data/audit', d(M), (ctx) => {
    const q = ctx.query.q ? `%${ctx.query.q}%` : '%';
    return all('SELECT * FROM audit_log WHERE (action LIKE ? OR actor LIKE ? OR entity_type LIKE ? OR data LIKE ?) ORDER BY id DESC LIMIT 300', q, q, q, q).map((a) => ({ ...a, data: jparse(a.data, null) }));
  });
  r.post('/api/data/backup', d(O), () => runRoutine('backup', 'manual', { force: true }));
  r.get('/api/data/backups', d(O), () => listFullBackups());
  r.get('/api/data/backup-key', d(O), (ctx) => {
    const key = path.join(config.dataDir, 'backup.key');
    if (config.backupPassword || !fs.existsSync(key)) throw bad('No generated backup key is in use. Keep your configured BACKUP_PASSWORD separately.');
    audit(`user:${ctx.user.id}`, 'data.backup_key_download', 'backup', null);
    ctx.send(fs.readFileSync(key), 'application/octet-stream', { 'Content-Disposition': 'attachment; filename="nirmaan-backup.key"', 'Cache-Control': 'no-store' });
  });
  r.get('/api/data/backups/:file', d(O), (ctx) => {
    const f = path.basename(ctx.params.file); const full = path.join(config.backupDir, f);
    if ((!f.endsWith('.db') && !f.endsWith('.nsbackup')) || !fs.existsSync(full)) throw notFound();
    audit(`user:${ctx.user.id}`, 'data.backup_download', 'backup', null, { file: f });
    ctx.res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${f}"`, 'Cache-Control': 'no-store' });
    ctx.headersSent = true;
    const stream = fs.createReadStream(full); stream.on('error', () => ctx.res.destroy()); ctx.res.on('close', () => stream.destroy()); stream.pipe(ctx.res);
  });

  // ---------------- settings & system
  r.get('/api/settings', d(), (ctx) => ({
    settings: getSettings(), defaults: DEFAULT_SETTINGS,
    zones: all('SELECT * FROM zones ORDER BY sort'), faqs: all('SELECT * FROM faqs ORDER BY id'), holidays: all('SELECT * FROM holidays ORDER BY day'),
    catalog: { services: SERVICES.map((s) => ({ code: s.code, en: s.en })), natures: NATURES.map((n) => ({ code: n.code, en: n.en })), windows: WINDOWS.map((w) => ({ code: w.code, en: w.en })) },
    system: {
      whatsapp: providerStatus(), ai: aiStatus(), routinesMode: config.routinesMode, n8n: { baseUrl: config.n8n.baseUrl || null, lastSeen: getState('n8n_last_seen')?.value || null, lastDelivery: getState('n8n_last_delivery')?.value || null },
      publicUrl: config.publicUrl, webhookUrl: `${config.publicUrl}/webhooks/whatsapp${config.whatsapp.provider === 'dialog360' && ctx.user.role === 'owner' ? `?key=${encodeURIComponent(config.whatsapp.verifyToken)}` : ''}`, websiteFormUrl: `${config.publicUrl}/api/public/website-enquiry`, dataDir: config.dataDir,
      health: healthReport(), routines: routineStatus(),
      secrets: ctx.user.role === 'owner' ? publicSecretsForOwner() : null,
    },
  }));
  r.patch('/api/settings', d(M), (ctx) => tx(() => { const patch = ctx.body; validateSettings(patch); if (Object.hasOwn(patch, 'dispatch')) patch.dispatch = validateDispatch(patch.dispatch); if (Object.hasOwn(patch, 'travel')) patch.travel = validateTravel(patch.travel); saveSettings(patch, `user:${ctx.user.id}`); return { ok: true, settings: getSettings() }; }));
  r.put('/api/zones', d(M), (ctx) => tx(() => {
    for (const [i, z] of (ctx.body?.zones || []).entries()) {
      if (!z.code || !z.name) continue;
      run('INSERT INTO zones(code, name, name_hi, lat, lng, active, sort) VALUES (?,?,?,?,?,?,?) ON CONFLICT(code) DO UPDATE SET name=excluded.name, name_hi=excluded.name_hi, lat=excluded.lat, lng=excluded.lng, active=excluded.active, sort=excluded.sort', z.code, z.name, z.name_hi || null, z.lat ?? null, z.lng ?? null, z.active === false ? 0 : 1, i);
    }
    audit(`user:${ctx.user.id}`, 'zones.update', 'zones', null);
    return { ok: true };
  }));
  r.post('/api/faqs', d(M), (ctx) => tx(() => { const b = ctx.body || {}; if (!b.question || !b.answer_en) throw bad('Question and English answer are required'); const id = insert('faqs', { question: b.question, answer_en: b.answer_en, answer_hi: b.answer_hi || null, keywords: b.keywords || '', active: b.active === false ? 0 : 1, updated_at: nowIso() }); audit(`user:${ctx.user.id}`, 'faq.create', 'faq', id); return { id }; }));
  r.patch('/api/faqs/:id', d(M), (ctx) => tx(() => { const b = ctx.body || {}; const patch = { updated_at: nowIso() }; for (const k of ['question', 'answer_en', 'answer_hi', 'keywords']) if (b[k] !== undefined) patch[k] = b[k]; if (b.active !== undefined) patch.active = b.active ? 1 : 0; update('faqs', Number(ctx.params.id), patch); audit(`user:${ctx.user.id}`, 'faq.update', 'faq', Number(ctx.params.id), b); return { ok: true }; }));
  r.del('/api/faqs/:id', d(M), (ctx) => tx(() => { run('DELETE FROM faqs WHERE id=?', Number(ctx.params.id)); return { ok: true }; }));
  r.post('/api/holidays', d(M), (ctx) => tx(() => { const { day, name } = ctx.body || {}; if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) throw bad('Date must be YYYY-MM-DD'); run('INSERT OR REPLACE INTO holidays(day, name) VALUES (?,?)', day, name || 'Holiday'); return { ok: true }; }));
  r.del('/api/holidays/:day', d(M), (ctx) => tx(() => { run('DELETE FROM holidays WHERE day=?', ctx.params.day); return { ok: true }; }));
  r.get('/api/routines', d(), () => routineStatus());
  r.get('/api/timers/failed', d(M), () => all("SELECT id,kind,entity_type,entity_id,due_at,result FROM timers WHERE status='failed' ORDER BY id DESC LIMIT 200"));
  r.post('/api/timers/:id/retry', d(M), (ctx) => tx(() => ({ ok: retryTimer(Number(ctx.params.id), `user:${ctx.user.id}`) })));
  r.post('/api/routines/:name/run', d(M), (ctx) => runRoutine(ctx.params.name, 'manual', { force: !!ctx.body?.force }));
  r.post('/api/attendance/sweep/:which', d(M), (ctx) => tx(() => (ctx.params.which === 'morning' ? attendanceMorningSweep() : attendanceEveningSweep())));
  r.post('/api/settings/test-whatsapp', d(M), (ctx) => tx(() => {
    const wa = normPhone(ctx.body?.to); if (!wa) throw bad('Enter a phone number');
    ensureContact(wa);
    const id = enqueueWhatsApp({ to: wa, kind: 'test', sender: `user:${ctx.user.id}`, essential: true, message: { type: 'text', text: '✅ Test message from the Nirmaan Sena automation system.' }, template: { name: 'ns_staff_alert', params: ['test message from the automation system'] } });
    return { ok: true, outboxId: id };
  }));
}

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const value = String(v);
  const s = /^[\s]*[=+@-]/.test(value) && typeof v !== 'number' ? `'${value}` : value;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
