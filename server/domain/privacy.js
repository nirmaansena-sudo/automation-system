// Contact erasure keeps financial amounts/statuses, but removes identifying
// text, pending communications, raw payloads, attachments and shared links.
import fs from 'node:fs';
import path from 'node:path';
import { all, one, run, onCommit } from '../db/index.js';
import { config } from '../config.js';
import { bad, notFound } from '../lib/http.js';
import { audit } from '../core/base.js';
import { nowIso, normPhone, jparse } from '../lib/util.js';

export function eraseContact(contactId, actor) {
  const c = one('SELECT * FROM contacts WHERE id=?', contactId);
  if (!c) throw notFound();
  if (c.erased_at) return { ok: true, erased: true, already_erased: true, cleanupFailures: [] };
  if (c.user_id) throw bad('This is a staff contact. Manage the staff account instead.');
  if (one("SELECT 1 FROM projects WHERE client_contact_id=? AND status NOT IN ('closed','cancelled')", c.id)) throw bad('Close the client’s projects and warranty before erasing their personal data.');
  const leads = all('SELECT * FROM leads WHERE contact_id=?', c.id);
  const projects = all('SELECT * FROM projects WHERE client_contact_id=?', c.id);
  const leadIds = new Set(leads.map((x) => x.id)); const projectIds = new Set(projects.map((x) => x.id));
  const visits = all('SELECT id, lead_id FROM visits').filter((x) => leadIds.has(x.lead_id));
  const visitIds = new Set(visits.map((x) => x.id));
  const logs = all('SELECT id, project_id FROM site_logs').filter((x) => projectIds.has(x.project_id));
  const logIds = new Set(logs.map((x) => x.id));
  const quotes = all('SELECT id, lead_id, project_id FROM quotations').filter((x) => leadIds.has(x.lead_id) || projectIds.has(x.project_id));
  const quoteIds = new Set(quotes.map((x) => x.id));
  const related = (type, id) => (type === 'contact' && id === c.id) || (type === 'lead' && leadIds.has(id)) || (type === 'project' && projectIds.has(id)) || (type === 'visit' && visitIds.has(id)) || (type === 'site_log' && logIds.has(id)) || (['quote', 'quotation'].includes(type) && quoteIds.has(id));
  const result = { ok: true, erased: true, media: 0, inbound: 0, outbox: 0, cleanupFailures: [], retained: 'Financial amounts, dates and record relationships; historical backups expire under the backup retention policy.' };
  const anon = `Erased client ${c.id}`;
  const personalLabels = [...new Set([c.name, c.profile_name, c.email, c.wa_id, ...leads.flatMap((l) => [l.name, l.phone, l.address]), ...projects.flatMap((p) => [p.client_name, p.client_phone, p.address])].filter((x) => typeof x === 'string' && x.length >= 3))].sort((a, b) => b.length - a.length);
  const redact = (value) => personalLabels.reduce((text, label) => text.split(label).join('[erased]'), String(value || ''));
  const phones = new Set([c.wa_id, ...leads.map((l) => l.phone), ...projects.map((p) => p.client_phone)].filter(Boolean).map(normPhone).filter((phone) => /^\d{11,15}$/.test(phone)));
  const containsPhone = (value) => {
    if (typeof value === 'string') return phones.has(normPhone(value)) || [...phones].some((phone) => phone && value.includes(phone));
    if (Array.isArray(value)) return value.some(containsPhone);
    return !!value && typeof value === 'object' && Object.values(value).some(containsPhone);
  };
  const refs = [...leads, ...projects].map((x) => x.ref).filter(Boolean);
  const containsRef = (value) => typeof value === 'string' && refs.some((ref) => value.includes(ref));

  for (const event of all('SELECT id, wa_id, payload FROM inbound_events')) {
    if (phones.has(normPhone(event.wa_id)) || containsPhone(jparse(event.payload, {}))) {
      run("UPDATE inbound_events SET wa_id=NULL, payload='{}', dedupe_key=?, status='ignored', last_error=NULL, locked_at=NULL, processed_at=? WHERE id=?", `erased:${event.id}`, nowIso(), event.id); result.inbound++;
    }
  }
  for (const job of all('SELECT id, contact_id, to_wa_id, payload, template FROM outbox')) {
    if (job.contact_id === c.id || phones.has(normPhone(job.to_wa_id)) || containsPhone(jparse(job.payload, {})) || containsRef(job.payload)) {
      run("UPDATE outbox SET to_wa_id=NULL, payload='{}', template=NULL, status=CASE WHEN status='sent' THEN status ELSE 'cancelled' END, last_error=NULL, lease_until=NULL, updated_at=? WHERE id=?", nowIso(), job.id); result.outbox++;
    }
  }
  const files = [];
  const hasTranscripts = !!one("SELECT 1 FROM sqlite_master WHERE type='table' AND name='media_transcripts'");
  for (const media of all('SELECT * FROM media')) if (related(media.owner_type, media.owner_id)) {
    if (media.file_path) files.push({ id: media.id, path: media.file_path });
    if (hasTranscripts) run('DELETE FROM media_transcripts WHERE media_id=?', media.id);
    run("UPDATE media SET file_path=NULL, caption=NULL, lat=NULL, lng=NULL, provider_media_id=NULL, sha256=NULL, status='erased' WHERE id=?", media.id); result.media++;
  }
  run("UPDATE contacts SET wa_id=?, name=NULL, profile_name=NULL, email=NULL, notes=NULL, tags='[]', erased_at=?, opted_out=1, updated_at=? WHERE id=?", `erased-${c.id}`, nowIso(), nowIso(), c.id);
  run("UPDATE conversations SET ctx='{}', flow=NULL, step=NULL, last_message_preview='[erased]', unread=0, needs_attention=0, attention_reason=NULL WHERE contact_id=?", c.id);
  run("UPDATE messages SET body='[erased]', payload=NULL, error=NULL WHERE contact_id=?", c.id);
  run('UPDATE leads SET name=?, phone=NULL, address=NULL, locality=NULL, site_lat=NULL, site_lng=NULL, requirements=NULL, ai_summary=NULL, preferred_slots=\'[]\', lost_reason=NULL WHERE contact_id=?', anon, c.id);
  run("UPDATE projects SET name=?, client_name=?, client_phone=NULL, address=NULL, site_lat=NULL, site_lng=NULL, authorized_phones='[]', notes=NULL, public_token=NULL, digest_enabled=0 WHERE client_contact_id=?", anon, anon, c.id);
  for (const q of quotes) run('UPDATE quotations SET public_token=NULL, notes=NULL, client_note=NULL WHERE id=?', q.id);
  for (const v of visits) run('UPDATE visits SET report=NULL, review_note=NULL, cancel_reason=NULL WHERE id=?', v.id);
  if (one("SELECT 1 FROM sqlite_master WHERE type='table' AND name='visit_travel'")) {
    // Travel amounts and expense links remain, while precise route endpoints
    // are replaced with neutral coordinates and the snapshot is marked erased.
    for (const v of visits) run("UPDATE visit_travel SET origin_lat=0, origin_lng=0, site_lat=0, site_lng=0, note=NULL, policy='{}', status='erased', updated_at=? WHERE visit_id=?", nowIso(), v.id);
    run('DELETE FROM route_cache');
  }
  if (one("SELECT 1 FROM sqlite_master WHERE type='table' AND name='purchase_orders'")) {
    for (const p of projects) {
      for (const order of all('SELECT id,material,unit,supplier FROM purchase_orders WHERE project_id=?', p.id)) {
        run('UPDATE purchase_orders SET material=?,unit=?,supplier=?,note=NULL WHERE id=?', redact(order.material), redact(order.unit), redact(order.supplier), order.id);
        for (const movement of all('SELECT id FROM stock_movements WHERE order_id=?', order.id)) run('UPDATE stock_movements SET reference=?,note=NULL WHERE id=?', `ERASED-${movement.id}`, movement.id);
      }
      run('UPDATE project_budgets SET note=NULL WHERE project_id=?', p.id);
      for (const cost of all('SELECT id FROM project_external_costs WHERE project_id=?', p.id)) run("UPDATE project_external_costs SET reference=?,note='[erased]' WHERE id=?", `ERASED-${cost.id}`, cost.id);
    }
  }
  run("UPDATE tickets SET subject='[erased]', description=NULL WHERE contact_id=?", c.id);
  for (const approval of all('SELECT id, entity_type, entity_id FROM approvals')) if (related(approval.entity_type, approval.entity_id)) run("UPDATE approvals SET title='[erased client record]', summary=NULL, data='{}', decision_note=NULL, status=CASE WHEN status='pending' THEN 'cancelled' ELSE status END WHERE id=?", approval.id);
  for (const task of all('SELECT id, entity_type, entity_id FROM tasks')) if (related(task.entity_type, task.entity_id)) run("UPDATE tasks SET title='[erased client record]', description=NULL, evidence=NULL, status=CASE WHEN status IN ('todo','in_progress','blocked') THEN 'cancelled' ELSE status END WHERE id=?", task.id);
  for (const entry of all('SELECT id, entity_type, entity_id, data FROM audit_log')) if (related(entry.entity_type, entry.entity_id) || containsPhone(jparse(entry.data, {}))) run("UPDATE audit_log SET data='{}' WHERE id=?", entry.id);
  for (const timer of all('SELECT id, entity_type, entity_id FROM timers')) if (related(timer.entity_type, timer.entity_id)) run("UPDATE timers SET data='{}', result=NULL, status=CASE WHEN status='pending' THEN 'cancelled' ELSE status END WHERE id=?", timer.id);
  for (const notification of all('SELECT id, title, body FROM notifications')) if (containsRef(notification.title) || containsRef(notification.body) || containsPhone(notification.body)) run("UPDATE notifications SET title='[erased client record]', body=NULL WHERE id=?", notification.id);
  // Files are removed only after the erasure transaction succeeds.
  onCommit(() => {
    for (const file of files) {
      const full = path.resolve(config.mediaDir, file.path); const rel = path.relative(config.mediaDir, full);
      if (rel.startsWith('..') || path.isAbsolute(rel)) { result.cleanupFailures.push(file.id); continue; }
      try { fs.unlinkSync(full); } catch (e) { if (e.code !== 'ENOENT') result.cleanupFailures.push(file.id); }
    }
  });
  audit(`user:${actor.id}`, 'contact.erased', 'contact', c.id, { media: result.media, inbound: result.inbound, outbox: result.outbox });
  return result;
}
