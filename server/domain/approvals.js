// One queue for every human decision; routes each decision to its module.
import { all, one, run, tx } from '../db/index.js';
import { jparse, nowIso } from '../lib/util.js';
import { audit } from '../core/base.js';
import { decideLead, getLead, suggestAssignment } from './leads.js';
import { servicesText, natureText, areaText, leadPlace } from './common.js';
import { decideVisitReport } from './visits.js';
import { decideQuotation, getQuote } from './quotations.js';
import { decideMilestone, decideHandover, decideChangeManager } from './projects.js';
import { decideLeave, decideExpense, reviewAttendance } from './staff.js';

export const APPROVAL_LABELS = {
  lead_assignment: 'Approve visit', lead_review: 'Outside Jaipur', visit_report: 'Site report', quotation: 'Quotation', milestone: 'Quality review',
  handover: 'Handover', change_request: 'Change request', leave: 'Leave', expense: 'Expense', attendance_exception: 'Attendance', payroll: 'Payroll',
};

export function listApprovals({ status = 'pending', kind } = {}) {
  const rows = kind
    ? all('SELECT * FROM approvals WHERE status=? AND kind=? ORDER BY COALESCE(due_at, created_at), id', status, kind)
    : all('SELECT * FROM approvals WHERE status=? ORDER BY escalated DESC, COALESCE(due_at, created_at), id LIMIT 300', status);
  return rows.map((a) => {
    const out = { ...a, data: jparse(a.data, {}), label: APPROVAL_LABELS[a.kind] || a.kind };
    if (a.kind === 'lead_assignment' && a.entity_type === 'lead' && a.status === 'pending') {
      const lead = getLead(a.entity_id);
      out.lead = lead;
      out.leadText = lead ? { services: servicesText(lead.services), nature: natureText(lead), area: areaText(lead), place: leadPlace(lead) } : null;
      out.data.suggestion = suggestAssignment(lead) || out.data.suggestion || null;
    }
    if (a.kind === 'visit_report') {
      const v = one('SELECT * FROM visits WHERE id=?', a.entity_id);
      out.visit = v ? { ...v, report: jparse(v.report, {}) } : null;
    }
    if (a.kind === 'quotation') { const q = getQuote(a.entity_id); out.quote = q ? { ...q, items: jparse(q.items, []), payment_schedule: jparse(q.payment_schedule, []) } : null; }
    if (a.kind === 'attendance_exception') out.event = one('SELECT * FROM attendance_events WHERE id=?', a.entity_id);
    return out;
  });
}

export function decideApproval(id, body, actor) {
  return tx(() => {
    const a = one('SELECT * FROM approvals WHERE id=?', id);
    if (!a) return { error: 'Approval not found' };
    switch (a.kind) {
      case 'lead_assignment':
      case 'lead_review': return decideLead(id, body, actor);
      case 'visit_report': return decideVisitReport(id, body, actor);
      case 'quotation': return decideQuotation(id, body, actor);
      case 'milestone': return decideMilestone(id, body, actor);
      case 'handover': return decideHandover(id, body, actor);
      case 'change_request': return decideChangeManager(id, body, actor);
      case 'leave': return decideLeave(id, body, actor);
      case 'expense': return decideExpense(id, body, actor);
      case 'attendance_exception': return reviewAttendance(id, body, actor);
      case 'payroll': {
        if (a.status !== 'pending') return { error: 'Already handled' };
        run('UPDATE approvals SET status=?, decision=?, decided_by=?, decision_note=?, decided_at=? WHERE id=?', body.decision === 'approve' ? 'approved' : 'rejected', body.decision, actor?.id || null, body.note || null, nowIso(), id);
        audit(`user:${actor?.id}`, 'payroll.' + body.decision, 'approval', id, jparse(a.data, {}));
        return { ok: true };
      }
      default: return { error: `No handler for ${a.kind}` };
    }
  });
}
