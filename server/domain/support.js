// Support tickets for existing clients (with SLA timers and escalation).
import { all, one, run, insert, update, onCommit } from '../db/index.js';
import { nowIso, addMinIso, truncate } from '../lib/util.js';
import { broadcast } from '../lib/http.js';
import { audit, nextRef, notify, createTask } from '../core/base.js';
import { enqueueWhatsApp, enqueueEvent } from '../core/outbox.js';
import { schedule, cancelTimers, registerTimer } from '../core/timers.js';
import { getContact } from './common.js';

const SLA_MIN = { high: 120, normal: 8 * 60, low: 24 * 60 };

export function createTicket({ contactId, projectId = null, category = 'general', subject, description, priority = 'normal', actor = 'client' }) {
  const p = projectId ? one('SELECT * FROM projects WHERE id=?', projectId) : null;
  const assignee = p ? (p.supervisor_id || p.engineer_id || p.manager_id) : null;
  const at = nowIso();
  const due = addMinIso(at, SLA_MIN[priority] || SLA_MIN.normal);
  const id = insert('tickets', { ref: nextRef('NS-TKT'), contact_id: contactId, project_id: projectId, category, subject: truncate(subject || category, 120), description: description || null, priority, status: 'open', assignee_id: assignee, due_at: due, created_at: at, updated_at: at });
  const tk = one('SELECT * FROM tickets WHERE id=?', id);
  createTask({ title: `Ticket ${tk.ref}: ${tk.subject}`, description: description || '', assigneeId: assignee, priority, entityType: 'ticket', entityId: id, dueAt: due, dedupeKey: `ticket:${id}` });
  schedule('ticket_sla', { entityType: 'ticket', entityId: id, dueAt: due, dedupeKey: `ticket-sla:${id}` });
  audit(actor, 'ticket.created', 'ticket', id, { category, projectId });
  enqueueEvent('ticket.created', { ref: tk.ref, category, project: p?.ref || null, priority });
  onCommit(() => broadcast('tickets'));
  return tk;
}

registerTimer('ticket_sla', (tm) => {
  const tk = one('SELECT * FROM tickets WHERE id=?', tm.entity_id);
  if (!tk || ['resolved', 'closed'].includes(tk.status) || tk.first_response_at) return 'ok';
  notify({ audience: 'managers', title: `Ticket ${tk.ref} is past its response time`, body: tk.subject, link: '#/tickets', level: 'error' });
  return 'escalated';
});

export function appendToTicket(ticketId, text) {
  const tk = one('SELECT * FROM tickets WHERE id=?', ticketId);
  if (!tk) return;
  update('tickets', tk.id, { description: [tk.description, text].filter(Boolean).join('\n').slice(0, 4000), updated_at: nowIso() });
  if (tk.assignee_id) notify({ userId: tk.assignee_id, title: `Client added details · ${tk.ref}`, body: truncate(text, 160), link: '#/tickets' });
}

export function updateTicket(id, { status, assignee_id, reply }, actor) {
  const tk = one('SELECT * FROM tickets WHERE id=?', id);
  if (!tk) return { error: 'Ticket not found' };
  const at = nowIso();
  const patch = { updated_at: at };
  if (status) patch.status = status;
  if (assignee_id !== undefined) patch.assignee_id = assignee_id;
  if (status && !tk.first_response_at) patch.first_response_at = at;
  if (['resolved', 'closed'].includes(status)) { patch.resolved_at = at; cancelTimers('ticket', id); run("UPDATE tasks SET status='done', completed_at=? WHERE entity_type='ticket' AND entity_id=? AND status!='done'", at, id); }
  update('tickets', id, patch);
  if (reply) {
    const c = getContact(tk.contact_id);
    if (c) enqueueWhatsApp({ to: c.wa_id, kind: 'ticket.update', sender: `user:${actor?.id}`, essential: true, message: { type: 'text', text: `🛠 ${tk.ref}: ${reply}` }, template: { name: 'ns_ticket_update', params: [tk.ref, truncate(reply, 500)] } });
    if (!tk.first_response_at) update('tickets', id, { first_response_at: at });
  }
  audit(`user:${actor?.id}`, 'ticket.update', 'ticket', id, { status, reply: !!reply });
  onCommit(() => broadcast('tickets'));
  return { ok: true };
}

export function openTicketsFor(contactId) { return all("SELECT * FROM tickets WHERE contact_id=? AND status NOT IN ('resolved','closed') ORDER BY id DESC", contactId); }
