// Deterministic work self-service for a currently registered staff WhatsApp
// number. Every entity action checks assignment; dashboard powers never apply.
import { all, one, run, tx } from '../db/index.js';
import { audit, notify } from '../core/base.js';
import { enqueueWhatsApp, registerGuard } from '../core/outbox.js';
import { getContact, getConversation, setFlow, servicesText, leadPlace } from '../domain/common.js';
import { getLead } from '../domain/leads.js';
import { architectRespond, pendingOffersFor } from '../domain/scheduling.js';
import { getVisit, submitVisitReport } from '../domain/visits.js';
import { getProject, addSiteLog } from '../domain/projects.js';
import { updateTask } from '../domain/staff.js';
import { travelOptions, selectTravel, readTravel, claimTravel } from '../domain/travel.js';
import { travelSettings, dispatchSettings, originFor } from '../domain/dispatch.js';
import { nowIso, jparse, randomToken, fmtSlot, mapsLink, inr, prettyPhone, normPhone, addMinIso, sha256 } from '../lib/util.js';
import { bad, forbidden, HttpError, broadcast } from '../lib/http.js';
import { config } from '../config.js';
import { detectIntents } from './nlu.js';

const l = (c, en, hi) => c.language === 'hi' ? hi : en;
const cut = (value, max = 1000) => String(value || '').slice(0, max);
const FLOW = 'staff_work';
const PAGE_SIZE = 7;
const REPORT_STEPS = ['scope', 'measurements', 'constraints', 'recommendation', 'photos'];
const LOG_STEPS = ['work_done', 'issues', 'photos'];
const WORK_STATES = ['confirmed', 'in_progress', 'report_submitted', 'completed'];
const STATUS = {
  confirmed: ['Confirmed', 'पुष्टि हो गई'], in_progress: ['In progress', 'काम जारी'], report_submitted: ['Report submitted', 'रिपोर्ट जमा'], completed: ['Completed', 'पूरा'],
  todo: ['To do', 'करना है'], blocked: ['Blocked', 'रुका हुआ'], done: ['Done', 'पूरा'], active: ['Active', 'काम जारी'], on_hold: ['On hold', 'रुका हुआ'], awaiting_advance: ['Awaiting advance', 'अग्रिम की प्रतीक्षा'], handover: ['Handover', 'हैंडओवर'],
};
const statusText = (c, value) => STATUS[value] ? l(c, ...STATUS[value]) : cut(value, 40);
const menuRow = (c) => ({ id: 'W:MENU', title: l(c, 'Work menu', 'काम का मेन्यू') });
const cancelButton = (c) => ({ id: 'W:CANCEL', title: l(c, 'Cancel draft', 'ड्राफ्ट रद्द करें') });

export function staffIdentity(contact) {
  const user = one('SELECT * FROM users WHERE phone=?', normPhone(contact.wa_id));
  if (user) return { user: user.active ? user : null, blocked: !user.active, known: true };
  return { user: null, blocked: !!contact.user_id || contact.kind === 'staff', known: !!contact.user_id || contact.kind === 'staff' };
}
function identity(rec) {
  const current = staffIdentity(getContact(rec.contact.id));
  if (!current.user || current.user.id !== rec.staff.id) throw forbidden('Your staff account or registered number has changed. Contact your manager.');
  return current.user;
}
function entityId(value) {
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) throw bad('Invalid work reference. Type MENU.');
  return Number(value);
}
function ownVisit(rec, id) {
  identity(rec); const v = getVisit(entityId(id));
  if (!v || v.architect_id !== rec.staff.id || !WORK_STATES.includes(v.status)) throw forbidden('This active visit is not assigned to you. Open My visits.');
  return v;
}
function ownProject(rec, id) {
  identity(rec); const p = getProject(entityId(id));
  if (!p || ![p.architect_id, p.engineer_id, p.supervisor_id, p.manager_id].includes(rec.staff.id) || ['closed', 'cancelled'].includes(p.status)) throw forbidden('This active project is not assigned to you. Open My projects.');
  return p;
}
function ownTask(rec, id) {
  identity(rec); const task = one('SELECT * FROM tasks WHERE id=?', entityId(id));
  if (!task || task.assignee_id !== rec.staff.id || task.status === 'cancelled') throw forbidden('This task is not assigned to you. Open My tasks.');
  return task;
}
registerGuard('staff_self', (guard) => {
  const user = one('SELECT * FROM users WHERE id=? AND active=1 AND phone=?', guard.userId, guard.phone);
  if (!user) return false;
  const rec = { contact: { id: guard.contactId }, staff: user };
  try {
    if (!guard.allowHuman && getConversation(guard.contactId)?.mode === 'human') return false;
    for (const resource of Array.isArray(guard.resource) ? guard.resource : [guard.resource]) {
      if (resource?.type === 'visit') ownVisit(rec, resource.id);
      if (resource?.type === 'project') ownProject(rec, resource.id);
      if (resource?.type === 'task') ownTask(rec, resource.id);
      if (resource?.type === 'offer' && !one("SELECT 1 FROM visit_offers WHERE id=? AND architect_id=? AND status='pending'", resource.id, user.id)) return false;
    }
    return true;
  } catch { return false; }
});
function send(rec, message, key = 'reply', resource = null) {
  if (!resource && key.startsWith('draft.')) {
    const d = jparse(getConversation(rec.contact.id)?.ctx, {});
    const type = { report: 'visit', log: 'project', task: 'task' }[d.kind];
    if (type) resource = { type, id: d.id };
  }
  return enqueueWhatsApp({ to: rec.contact.wa_id, kind: `staff.work.${key}`, sender: 'bot', essential: true,
    guard: { type: 'staff_self', userId: rec.staff.id, phone: rec.contact.wa_id, contactId: rec.contact.id, resource, allowHuman: key === 'help' },
    dedupeKey: `staff-work:${rec.msgId}:${key}`, message });
}
const text = (rec, en, hi, key = 'reply', resource = null) => send(rec, { type: 'text', text: cut(l(rec.contact, en, hi), 4000) }, key, resource);
function list(rec, body, rows, key, resource = null) {
  return send(rec, { type: 'list', text: cut(body, 3800), button: l(rec.contact, 'Choose', 'चुनें'), footer: l(rec.contact, 'Type MENU or CANCEL anytime', 'MENU या CANCEL लिखें'), sections: [{ rows: rows.slice(0, 10).map((r) => ({ ...r, title: cut(r.title, 24), ...(r.description ? { description: cut(r.description, 72) } : {}) })) }] }, key, resource);
}
function mark(rec) { audit(`user:${rec.staff.id}`, 'staff.wa_processed', 'message', rec.msgId); }
const processed = (rec) => !!one("SELECT 1 FROM audit_log WHERE action='staff.wa_processed' AND entity_type='message' AND entity_id=?", rec.msgId);
function sync(rec, action) { return tx(() => { identity(rec); const result = action(); mark(rec); return result; }); }
function menu(rec, prefix = '') {
  setFlow(rec.contact.id, null);
  const c = rec.contact;
  return list(rec, [prefix, l(c, `Hello ${rec.staff.name}. What would you like to do?`, `नमस्ते ${rec.staff.name}। आप क्या करना चाहेंगे?`)].filter(Boolean).join('\n\n'), [
    { id: 'W:VISITS:0', title: l(c, 'My visits', 'मेरी साइट विज़िट') },
    { id: 'W:OFFERS:0', title: l(c, 'Visit offers', 'नई विज़िट के प्रस्ताव') },
    { id: 'W:TASKS:0', title: l(c, 'My tasks', 'मेरे काम') },
    { id: 'W:PROJECTS:0', title: l(c, 'My projects', 'मेरे प्रोजेक्ट') },
    { id: 'W:HELP', title: l(c, 'Ask my manager', 'मैनेजर से मदद') },
    { id: `W:LANG:${c.language === 'hi' ? 'en' : 'hi'}`, title: c.language === 'hi' ? 'English' : 'हिंदी' },
  ], 'menu');
}
function pageRows(rec, rows, page, kind, makeRow, heading) {
  const result = rows.slice(0, PAGE_SIZE).map(makeRow);
  if (page) result.push({ id: `W:${kind}:${page - 1}`, title: l(rec.contact, 'Previous', 'पिछला पेज') });
  if (rows.length > PAGE_SIZE) result.push({ id: `W:${kind}:${page + 1}`, title: l(rec.contact, 'More', 'अगला पेज') });
  result.push(menuRow(rec.contact));
  const type = { VISITS: 'visit', OFFERS: 'offer', TASKS: 'task', PROJECTS: 'project' }[kind];
  return list(rec, rows.length ? heading : l(rec.contact, 'No matching work is assigned to you.', 'इस सूची में अभी आपका कोई काम नहीं है।'), result, kind.toLowerCase(), rows.slice(0, PAGE_SIZE).map(row => ({ type, id: row.id })));
}
function showVisits(rec, page = 0) {
  const rows = all("SELECT v.*,l.locality FROM visits v LEFT JOIN leads l ON l.id=v.lead_id WHERE v.architect_id=? AND v.status IN ('confirmed','in_progress','report_submitted','completed') AND v.start_at>=? ORDER BY CASE WHEN v.status IN ('confirmed','in_progress') THEN 0 ELSE 1 END, v.start_at DESC LIMIT ? OFFSET ?", rec.staff.id, addMinIso(nowIso(), -30 * 1440), PAGE_SIZE + 1, page * PAGE_SIZE);
  return pageRows(rec, rows, page, 'VISITS', (v) => ({ id: `W:V:${v.id}`, title: v.ref, description: `${fmtSlot(v.start_at, rec.contact.language)} · ${statusText(rec.contact, v.status)}` }), l(rec.contact, 'Your upcoming visits and reports from the last 30 days.', 'आपकी आने वाली विज़िट और पिछले 30 दिन की रिपोर्ट।'));
}
function showVisit(rec, id) {
  const v = ownVisit(rec, id), lead = getLead(v.lead_id), c = rec.contact;
  setFlow(c.id, null);
  const body = `${v.ref} · ${statusText(c, v.status)}\n${fmtSlot(v.start_at, c.language)}\n${l(c, 'Client', 'क्लाइंट')}: ${cut(lead.name, 100)}\n${prettyPhone(lead.phone)}\n${cut(lead.address || leadPlace(lead, c.language), 400)}\n${servicesText(lead.services, c.language)}\n${cut(lead.requirements, 800)}`;
  const rows = [{ id: `W:NAV:${v.id}`, title: l(c, 'Directions / map', 'साइट का रास्ता') }, { id: `W:TR:${v.id}`, title: l(c, 'Travel & reimbursement', 'यात्रा खर्च') }];
  if (v.status !== 'completed') rows.push({ id: `W:REPORT:${v.id}`, title: l(c, 'Submit visit report', 'विज़िट रिपोर्ट भेजें') });
  rows.push({ id: 'W:VISITS:0', title: l(c, 'Back to visits', 'विज़िट सूची') });
  return list(rec, body, rows, 'visit', { type: 'visit', id: v.id });
}
function showOffers(rec, page = 0) {
  const rows = pendingOffersFor(rec.staff.id).slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE + 1);
  return pageRows(rec, rows, page, 'OFFERS', (o) => ({ id: `W:O:${o.id}:${o.revision}`, title: o.ref, description: `${fmtSlot(o.slot_start, rec.contact.language)} · ${leadPlace(o, rec.contact.language)}` }), l(rec.contact, 'Visit offers waiting for your answer.', 'आपके जवाब की प्रतीक्षा में विज़िट प्रस्ताव।'));
}
function showOffer(rec, id, revision) {
  const offer = pendingOffersFor(rec.staff.id).find((x) => x.id === Number(id) && x.revision === Number(revision));
  if (!offer) throw bad('This offer is no longer assigned to you or has expired.');
  return send(rec, { type: 'buttons', text: `${offer.ref}\n${fmtSlot(offer.slot_start, rec.contact.language)}\n${servicesText(offer.services, rec.contact.language)}\n${leadPlace(offer, rec.contact.language)}`, buttons: [{ id: `OF:A:${offer.id}:${offer.revision}`, title: l(rec.contact, 'Accept', 'स्वीकार करें') }, { id: `OF:D:${offer.id}:${offer.revision}`, title: l(rec.contact, 'Decline', 'मना करें') }, { id: 'W:MENU', title: l(rec.contact, 'Work menu', 'काम का मेन्यू') }] }, 'offer', { type: 'offer', id: offer.id });
}
function showTasks(rec, page = 0) {
  const rows = all("SELECT * FROM tasks WHERE assignee_id=? AND status NOT IN ('done','cancelled') ORDER BY CASE priority WHEN 'high' THEN 0 ELSE 1 END,COALESCE(due_at,'9999'),id LIMIT ? OFFSET ?", rec.staff.id, PAGE_SIZE + 1, page * PAGE_SIZE);
  return pageRows(rec, rows, page, 'TASKS', (task) => ({ id: `W:T:${task.id}`, title: task.title, description: `${statusText(rec.contact, task.status)}${task.due_at ? ' · ' + fmtSlot(task.due_at, rec.contact.language) : ''}` }), l(rec.contact, 'Your assigned tasks.', 'आपको सौंपे गए काम।'));
}
function showTask(rec, id) {
  const task = ownTask(rec, id), c = rec.contact;
  setFlow(c.id, null);
  return list(rec, `${cut(task.title, 200)}\n${statusText(c, task.status)}\n${cut(task.description, 2000)}${task.due_at ? '\n' + fmtSlot(task.due_at, c.language) : ''}`, [
    { id: `W:TS:${task.id}:in_progress`, title: l(c, 'Start / in progress', 'काम शुरू / जारी') },
    { id: `W:TS:${task.id}:blocked`, title: l(c, 'Blocked / need help', 'काम रुका हुआ है') },
    { id: `W:TS:${task.id}:done`, title: l(c, 'Mark done', 'काम पूरा') }, menuRow(c),
  ], 'task', { type: 'task', id: task.id });
}
function showProjects(rec, page = 0) {
  const id = rec.staff.id;
  const rows = all("SELECT * FROM projects WHERE status NOT IN ('closed','cancelled') AND (architect_id=? OR engineer_id=? OR supervisor_id=? OR manager_id=?) ORDER BY id DESC LIMIT ? OFFSET ?", id, id, id, id, PAGE_SIZE + 1, page * PAGE_SIZE);
  return pageRows(rec, rows, page, 'PROJECTS', (p) => ({ id: `W:P:${p.id}`, title: p.ref, description: cut(p.name, 72) }), l(rec.contact, 'Your assigned projects.', 'आपको सौंपे गए प्रोजेक्ट।'));
}
function showProject(rec, id) {
  const p = ownProject(rec, id), c = rec.contact;
  setFlow(c.id, null);
  const milestones = all('SELECT name,status,progress FROM milestones WHERE project_id=? ORDER BY seq LIMIT 8', p.id);
  const latest = one('SELECT work_done,issues,log_date FROM site_logs WHERE project_id=? ORDER BY id DESC LIMIT 1', p.id);
  const body = `${p.ref} · ${cut(p.name, 160)}\n${statusText(c, p.status)}\n${cut(p.address, 300)}\n\n${milestones.map((m) => `${cut(m.name, 70)}: ${statusText(c, m.status)}${m.progress ? ` ${m.progress}%` : ''}`).join('\n')}${latest ? `\n\n${l(c, 'Latest update', 'ताज़ा अपडेट')} (${latest.log_date}):\n${cut(latest.work_done, 800)}${latest.issues ? '\n' + cut(latest.issues, 400) : ''}` : ''}`;
  return list(rec, body, [{ id: `W:LOG:${p.id}`, title: l(c, 'Post site update', 'साइट अपडेट भेजें') }, { id: 'W:PROJECTS:0', title: l(c, 'Back to projects', 'प्रोजेक्ट सूची') }, menuRow(c)], 'project', { type: 'project', id: p.id });
}
function startDraft(rec, kind, id, extras = {}) {
  const draft = { kind, id: Number(id), nonce: randomToken(9), started_at: nowIso(), data: {}, media_ids: [], ...extras };
  setFlow(rec.contact.id, FLOW, kind === 'report' ? 'scope' : kind === 'log' ? 'work_done' : kind === 'task' ? 'note' : 'review', draft);
  return draft;
}
function draftFor(rec, nonce = null) {
  identity(rec); const conv = getConversation(rec.contact.id); const draft = jparse(conv.ctx, {});
  if (conv.mode === 'human') throw bad('Your manager is handling this conversation. Wait for their reply.');
  if (conv.flow !== FLOW || !draft.nonce || (nonce && nonce !== draft.nonce) || Date.parse(draft.started_at) < Date.parse(nowIso()) - 2 * 3600000) throw bad('This draft has expired or changed. Type MENU to start again.');
  if (['report', 'travel', 'claim'].includes(draft.kind)) {
    const visit = ownVisit(rec, draft.id);
    if (draft.visit_revision !== visit.revision) throw bad('The visit changed. Type MENU and open the latest visit.');
    if (draft.kind === 'report' && (visit.status === 'completed' || visit.report_at !== draft.base_report_at)) throw bad('The report changed or was reviewed. Start again from My visits.');
  } else if (draft.kind === 'log') ownProject(rec, draft.id);
  else if (draft.kind === 'task') { const task = ownTask(rec, draft.id); if (task.updated_at !== draft.base_updated_at || task.status !== draft.base_status) throw bad('The task changed. Open My tasks again.'); }
  else throw bad('Unknown draft. Type MENU to start again.');
  return { draft, step: conv.step };
}
function promptDraft(rec) {
  const { draft, step } = draftFor(rec), c = rec.contact;
  const prompts = {
    scope: ['Describe the work needed at the site (up to 2,000 characters).', 'साइट पर क्या काम चाहिए? 2,000 अक्षरों तक लिखें।'],
    measurements: ['Send measurements and dimensions, or tap Skip.', 'माप और आकार लिखें, या छोड़ें चुनें।'],
    constraints: ['Describe site constraints or concerns, or tap Skip.', 'साइट की बाधाएँ या समस्याएँ लिखें, या छोड़ें चुनें।'],
    recommendation: ['What do you recommend as the next step?', 'आपके अनुसार अगला कदम क्या होना चाहिए?'],
    work_done: ['Describe today’s site work (up to 2,000 characters).', 'आज साइट पर हुए काम का विवरण लिखें (2,000 अक्षरों तक)।'],
    issues: ['Any issues or help needed? Send details, or tap Skip.', 'कोई समस्या या मदद चाहिए? लिखें, या छोड़ें चुनें।'],
    note: ['Add a short task note, or tap Skip. You will confirm before saving.', 'काम के बारे में छोटी टिप्पणी लिखें, या छोड़ें चुनें। सेव करने से पहले पुष्टि होगी।'],
    photos: [`Send up to 8 JPG/PNG/WEBP photos (8 MB each). ${draft.media_ids.length} added. Tap Review when finished.`, `अधिकतम 8 JPG/PNG/WEBP फोटो भेजें (हर फोटो 8 MB तक)। ${draft.media_ids.length} जुड़ गईं। फिर समीक्षा चुनें।`],
  };
  if (!prompts[step]) return reviewDraft(rec);
  const buttons = [cancelButton(c)];
  if (['measurements', 'constraints', 'issues', 'note'].includes(step)) buttons.unshift({ id: `W:SKIP:${draft.nonce}`, title: l(c, 'Skip', 'छोड़ें') });
  if (step === 'photos') buttons.unshift({ id: `W:REVIEW:${draft.nonce}`, title: l(c, 'Review', 'समीक्षा') });
  return send(rec, { type: 'buttons', text: l(c, ...prompts[step]), buttons }, 'draft.prompt');
}
function reviewDraft(rec) {
  const { draft } = draftFor(rec), c = rec.contact;
  setFlow(c.id, FLOW, 'review', draft);
  const fields = Object.entries(draft.data).filter(([key, value]) => value && !['policy', 'expected_revision'].includes(key)).map(([key, value]) => `${({ scope: l(c, 'Scope', 'काम'), measurements: l(c, 'Measurements', 'माप'), constraints: l(c, 'Concerns', 'समस्याएँ'), recommendation: l(c, 'Next step', 'अगला कदम'), work_done: l(c, 'Work done', 'हुआ काम'), issues: l(c, 'Issues', 'समस्याएँ'), note: l(c, 'Note', 'टिप्पणी'), status: l(c, 'Status', 'स्थिति') })[key] || key}: ${cut(value, 650)}`).join('\n');
  text(rec, `${draft.kind === 'report' ? 'Review visit report' : draft.kind === 'log' ? 'Review site update' : 'Review task update'}\n${fields}\nPhotos: ${draft.media_ids.length}`, `${draft.kind === 'report' ? 'विज़िट रिपोर्ट जाँचें' : draft.kind === 'log' ? 'साइट अपडेट जाँचें' : 'काम का अपडेट जाँचें'}\n${fields}\nफोटो: ${draft.media_ids.length}`, 'draft.preview');
  const buttons = draft.kind === 'log' ? [
    { id: `W:SAVE:${draft.nonce}:private`, title: l(c, 'Internal team only', 'केवल टीम को दिखाएँ') },
    { id: `W:SAVE:${draft.nonce}:client`, title: l(c, 'Share with client', 'क्लाइंट को भी दिखाएँ') }, cancelButton(c),
  ] : [{ id: `W:SAVE:${draft.nonce}`, title: l(c, 'Confirm & submit', 'पुष्टि करके भेजें') }, cancelButton(c)];
  return send(rec, { type: 'buttons', text: l(c, draft.kind === 'log' ? 'Choose who can see this update. The client option also publishes these photos to their project page.' : 'Save this update? Nothing is submitted until you confirm.', draft.kind === 'log' ? 'किसे दिखाना है चुनें। क्लाइंट चुनने पर फोटो भी उनके प्रोजेक्ट पेज पर दिखेंगी।' : 'अपडेट भेजना है? आपकी पुष्टि के बाद ही जमा होगा।'), buttons }, 'draft.confirm');
}
function advanceDraft(rec, value, skip = false) {
  const { draft, step } = draftFor(rec);
  if (step === 'review' || step === 'photos') return promptDraft(rec);
  const optional = ['measurements', 'constraints', 'issues', 'note'].includes(step);
  if (skip && !optional) throw bad('This field is required. Send a short text answer.');
  if (!skip && (!value || value.length > (['scope', 'work_done'].includes(step) ? 2000 : 1000))) throw bad('Send a shorter text answer (maximum 2,000 characters for work, 1,000 for other fields).');
  draft.data[step] = skip ? '' : value;
  const steps = draft.kind === 'report' ? REPORT_STEPS : draft.kind === 'log' ? LOG_STEPS : ['note'];
  const next = steps[steps.indexOf(step) + 1] || 'review';
  setFlow(rec.contact.id, FLOW, next, draft);
  return next === 'review' ? reviewDraft(rec) : promptDraft(rec);
}
function collectPhoto(rec) {
  const { draft, step } = draftFor(rec);
  if (!['report', 'log'].includes(draft.kind) || step !== 'photos') throw bad('Send a text answer first. Photos can be added at the photo step.');
  const photo = one('SELECT a.* FROM media a JOIN messages m ON m.media_id=a.id WHERE m.id=?', rec.msgId);
  if (!photo || photo.status !== 'stored' || photo.owner_type !== 'staff_message' || photo.uploaded_by !== `user:${rec.staff.id}` || !/^image\/(jpeg|png|webp)$/.test(photo.mime) || photo.size > 8 * 1024 * 1024) throw bad('Send a JPG, PNG or WEBP photo under 8 MB.');
  if (draft.media_ids.length >= 8) throw bad('Eight photos are already attached. Tap Review.');
  if (!draft.media_ids.includes(photo.id)) draft.media_ids.push(photo.id);
  setFlow(rec.contact.id, FLOW, 'photos', draft); return promptDraft(rec);
}
function attachPhotos(rec, draft, type, id) {
  for (const mediaId of draft.media_ids) {
    const media = one("SELECT id FROM media WHERE id=? AND owner_type='staff_message' AND uploaded_by=? AND status='stored'", mediaId, `user:${rec.staff.id}`);
    if (!media) throw bad('A draft photo is unavailable. Start the update again.');
    run('UPDATE media SET owner_type=?,owner_id=? WHERE id=?', type, id, mediaId);
  }
}
function saveDraft(rec, nonce, visibility) {
  const { draft, step } = draftFor(rec, nonce);
  if (step !== 'review') throw bad('Finish and review this draft before confirming.');
  let result;
  if (draft.kind === 'report') {
    result = submitVisitReport(draft.id, rec.staff.id, { ...draft.data, via: 'whatsapp' });
    if (result.error) throw bad(result.error);
    attachPhotos(rec, draft, 'visit', draft.id);
  } else if (draft.kind === 'log') {
    if (!['private', 'client'].includes(visibility)) throw bad('Choose internal team or client visibility.');
    result = addSiteLog(draft.id, rec.staff.id, { ...draft.data, client_visible: visibility === 'client', client_event_id: `wa-site:${rec.staff.id}:${draft.nonce}` });
    if (result.error) throw bad(result.error);
    if (!result.duplicate) attachPhotos(rec, draft, 'site_log', result.id);
  } else if (draft.kind === 'task') {
    result = updateTask(draft.id, { status: draft.data.status, note: draft.data.note }, rec.staff);
    if (result.error) throw bad(result.error);
  } else if (draft.kind === 'claim') {
    const travel = readTravel(draft.id, rec.staff);
    if (!travel?.expense_id && travel?.revision !== draft.travel_revision) throw bad('Travel approval changed. Open travel again.');
    result = claimTravel(draft.id, rec.staff);
  } else throw bad('This confirmation is no longer valid.');
  setFlow(rec.contact.id, null);
  return text(rec, draft.kind === 'claim' ? `Travel claim #${result.expense_id} submitted. Finance will review it. Type MENU to continue.` : 'Submitted successfully. Type MENU to continue.', draft.kind === 'claim' ? `यात्रा क्लेम #${result.expense_id} जमा हो गया। आगे जाँच होगी। जारी रखने के लिए MENU लिखें।` : 'अपडेट जमा हो गया। आगे बढ़ने के लिए MENU लिखें।', 'saved');
}
function help(rec) {
  const c = rec.contact;
  setFlow(c.id, null);
  run("UPDATE conversations SET mode='human',human_requested_at=?,owner_until=NULL,owner_user_id=NULL,needs_attention=1,attention_reason='Staff asked for manager help' WHERE contact_id=?", nowIso(), c.id);
  notify({ audience: 'managers', title: `Staff needs help · ${rec.staff.name}`, body: 'Reply in the WhatsApp inbox, then explicitly release the conversation to the bot.', link: `#/inbox/${c.id}`, level: 'warn' });
  broadcast('inbox');
  return text(rec, 'Your manager has been notified. Send your question here. Work automation is paused until the manager releases the conversation.', 'मैनेजर को सूचित कर दिया गया है। अपना सवाल यहाँ भेजें। मैनेजर के वापस चालू करने तक ऑटोमेशन रुका रहेगा।', 'help');
}
function handleSync(m, rec) {
  const c = rec.contact, input = String(m.text || '').trim(), p = String(m.buttonId || '').split(':');
  if (input.length > 4000) throw bad('Please keep messages under 4,000 characters.');
  if (/^(hindi|हिंदी|हिन्दी|english)$/i.test(input) || (p[0] === 'W' && p[1] === 'LANG')) {
    const language = /^(english)$/i.test(input) || p[2] === 'en' ? 'en' : 'hi';
    run('UPDATE contacts SET language=? WHERE id=?', language, c.id); rec.contact = getContact(c.id); return menu(rec);
  }
  if (/^(menu|work|काम|मेन्यू|cancel|रद्द|रद्द करें)$/i.test(input) || (p[0] === 'W' && ['MENU', 'CANCEL'].includes(p[1]))) return menu(rec);
  if (/^(help|manager|मदद|मैनेजर|मदद चाहिए)$/i.test(input) || m.buttonId === 'W:HELP') return help(rec);
  if (/^(attendance|check[ -]?in|check[ -]?out|हाजिरी|उपस्थिति)$/i.test(input)) return text(rec, `Attendance stays in the employee app: ${config.publicUrl}/app/ . Type MENU for work actions.`, `हाजिरी कर्मचारी ऐप में दर्ज करें: ${config.publicUrl}/app/ । काम के लिए MENU लिखें।`, 'attendance.app');
  if (p[0] === 'OF') {
    if (!['A', 'D'].includes(p[1]) || !/^\d+$/.test(p[2] || '') || !/^\d+$/.test(p[3] || '')) throw bad('Invalid offer action.');
    const result = architectRespond(Number(p[2]), Number(p[3]), p[1] === 'A', { userId: rec.staff.id, via: 'whatsapp' });
    if (result.stale) throw bad('This offer is no longer active, changed or assigned to someone else.');
    setFlow(c.id, null); return;
  }
  if (p[0] === 'W') {
    switch (p[1]) {
      case 'VISITS': case 'OFFERS': case 'TASKS': case 'PROJECTS': {
        const page = Number(p[2] || 0); if (!Number.isInteger(page) || page < 0 || page > 1000) throw bad('Invalid page');
        setFlow(c.id, null); return ({ VISITS: showVisits, OFFERS: showOffers, TASKS: showTasks, PROJECTS: showProjects })[p[1]](rec, page);
      }
      case 'V': return showVisit(rec, p[2]);
      case 'NAV': { const v = ownVisit(rec, p[2]), lead = getLead(v.lead_id); return text(rec, `${v.ref}\n${cut(lead.address || leadPlace(lead), 500)}\n${mapsLink(lead.site_lat, lead.site_lng, lead.address || leadPlace(lead))}`, `${v.ref}\n${cut(lead.address || leadPlace(lead, 'hi'), 500)}\n${mapsLink(lead.site_lat, lead.site_lng, lead.address || leadPlace(lead))}`, 'navigation', { type: 'visit', id: v.id }); }
      case 'O': return showOffer(rec, p[2], p[3]);
      case 'T': return showTask(rec, p[2]);
      case 'P': return showProject(rec, p[2]);
      case 'REPORT': { const v = ownVisit(rec, p[2]); if (v.status === 'completed') throw bad('This report has already been reviewed. Ask your manager for changes.'); startDraft(rec, 'report', v.id, { visit_revision: v.revision, base_report_at: v.report_at }); return promptDraft(rec); }
      case 'LOG': { const project = ownProject(rec, p[2]); startDraft(rec, 'log', project.id); return promptDraft(rec); }
      case 'TS': { const task = ownTask(rec, p[2]); if (!['in_progress', 'blocked', 'done'].includes(p[3])) throw bad('Invalid task status'); startDraft(rec, 'task', task.id, { base_updated_at: task.updated_at, base_status: task.status, data: { status: p[3] } }); return promptDraft(rec); }
      case 'SKIP': draftFor(rec, p[2]); return advanceDraft(rec, '', true);
      case 'REVIEW': { const { step } = draftFor(rec, p[2]); if (step !== 'photos') throw bad('Finish the required fields first.'); return reviewDraft(rec); }
      case 'SAVE': return saveDraft(rec, p[2], p[3]);
      case 'CL': {
        const v = ownVisit(rec, p[2]), current = readTravel(v.id, rec.staff);
        if (current?.expense_id) return text(rec, `Travel claim #${current.expense_id} is already recorded.`, `यात्रा क्लेम #${current.expense_id} पहले ही दर्ज है।`, 'claim.exists');
        if (!current || current.stale || current.status !== 'approved' || !['report_submitted', 'completed'].includes(v.status)) throw bad('Submit the visit report and get manager approval of travel before claiming.');
        const draft = startDraft(rec, 'claim', v.id, { visit_revision: v.revision, travel_revision: current.revision });
        return send(rec, { type: 'buttons', text: l(c, `Submit the approved travel claim for ${v.ref}: ${inr(current.amount)}?`, `${v.ref} के लिए स्वीकृत यात्रा खर्च ${inr(current.amount)} का क्लेम जमा करें?`), buttons: [{ id: `W:SAVE:${draft.nonce}`, title: l(c, 'Submit claim', 'क्लेम जमा करें') }, cancelButton(c)] }, 'claim.confirm', { type: 'visit', id: v.id });
      }
      default: throw bad('This work action is unavailable. Type MENU.');
    }
  }
  if (m.buttonId) throw forbidden('That action is not available in the staff work menu.');
  const conv = getConversation(c.id);
  if (conv.flow === FLOW) return m.media ? collectPhoto(rec) : advanceDraft(rec, input);
  const intents = detectIntents(input), pending = pendingOffersFor(rec.staff.id);
  if (pending.length === 1 && (intents.has('yes') || intents.has('no') || /^(accept|decline)$/i.test(input))) {
    const result = architectRespond(pending[0].id, pending[0].revision, intents.has('yes') || /^accept$/i.test(input), { userId: rec.staff.id, via: 'whatsapp', reason: cut(input, 300) });
    if (result.stale) throw bad('This offer has expired. Open Visit offers.'); return;
  }
  if (/^(visits|my visits|विज़िट|विजिट)$/i.test(input)) return showVisits(rec);
  if (/^(tasks|my tasks|मेरे काम)$/i.test(input)) return showTasks(rec);
  if (/^(projects|my projects|प्रोजेक्ट)$/i.test(input)) return showProjects(rec);
  return menu(rec, m.media ? l(c, 'Photo received privately. Open a visit report or site update to attach photos to that work.', 'फोटो निजी तौर पर मिला। किसी काम में जोड़ने के लिए विज़िट रिपोर्ट या साइट अपडेट खोलें।') : '');
}

async function handleTravel(m, rec) {
  const p = m.buttonId.split(':'), c = rec.contact;
  if (p[1] === 'SAVE') {
    const { draft, step } = draftFor(rec, p[2]);
    if (draft.kind !== 'travel' || step !== 'review') throw bad('Travel confirmation expired.');
    if (JSON.stringify(travelSettings()) !== JSON.stringify(draft.policy)) throw bad('Travel rates changed. Open travel and select again.');
    const result = await selectTravel(draft.id, rec.staff, { origin_type: draft.origin_type, expected_revision: draft.expected_revision }, { authorize: ({ distance }) => {
      draftFor(rec, draft.nonce);
      if (travelSnapshot(rec, draft.id) !== draft.snapshot || distance.distance_km !== draft.distance_km) throw bad('The route or estimate changed. Open travel and confirm the new estimate.');
    } });
    return sync(rec, () => { draftFor(rec, draft.nonce); setFlow(c.id, null); text(rec, `Origin saved: ${result.origin_type}. ${result.distance_km} km · ${result.amount === null ? 'rate not set' : inr(result.amount)}. A manager must verify and approve this before reimbursement.`, `यात्रा का शुरुआती स्थान सेव हुआ: ${result.origin_type === 'home' ? 'घर' : 'ऑफिस'}। ${result.distance_km} किमी · ${result.amount === null ? 'दर तय नहीं है' : inr(result.amount)}। क्लेम से पहले मैनेजर की जाँच और स्वीकृति जरूरी है।`, 'travel.saved', { type: 'visit', id: draft.id }); });
  }
  const v = ownVisit(rec, p[2]);
  const snapshot = travelSnapshot(rec, v.id);
  const options = await travelOptions(v.id, rec.staff);
  return sync(rec, () => {
    ownVisit(rec, v.id); if (getConversation(c.id).mode === 'human') throw bad('Your manager is now handling this conversation.');
    if (travelSnapshot(rec, v.id) !== snapshot) throw bad('The route or travel settings changed. Open travel again.');
    if (p[1] === 'TO') {
      const choice = options.choices.find((x) => x.type === p[3] && !x.unavailable);
      const revision = Number(p[4]); if (!Number.isInteger(revision) || revision < 0 || revision !== (options.current?.revision || 0)) throw bad('Travel estimate changed. Open travel again.');
      if (!choice || options.current?.expense_id) throw bad('This origin is unavailable or the trip is already claimed.');
      const draft = startDraft(rec, 'travel', v.id, { visit_revision: v.revision, origin_type: choice.type, expected_revision: options.current?.revision || null, policy: options.policy, snapshot, distance_km: choice.distance_km });
      return send(rec, { type: 'buttons', text: l(c, `Choose ${choice.type} for ${v.ref}? ${choice.distance_km} km · ${choice.amount === null ? 'rate not configured' : inr(choice.amount)}. ${choice.source === 'estimated' ? 'Distance is an estimate. ' : ''}This submits the origin for manager approval.`, `${v.ref} के लिए ${choice.type === 'home' ? 'घर' : 'ऑफिस'} से यात्रा चुनें? ${choice.distance_km} किमी · ${choice.amount === null ? 'दर तय नहीं है' : inr(choice.amount)}। ${choice.source === 'estimated' ? 'दूरी अनुमानित है। ' : ''}मैनेजर की स्वीकृति के लिए जाएगा।`), buttons: [{ id: `W:SAVE:${draft.nonce}`, title: l(c, 'Confirm origin', 'स्थान की पुष्टि') }, cancelButton(c)] }, 'travel.confirm', { type: 'visit', id: v.id });
    }
    setFlow(c.id, null);
    const lines = options.choices.map((choice) => `${choice.type === 'home' ? l(c, 'Home', 'घर') : l(c, 'Office', 'ऑफिस')}: ${choice.unavailable ? l(c, 'save the location in the employee app first', 'पहले कर्मचारी ऐप में स्थान सेव करें') : `${choice.distance_km} km · ${choice.amount === null ? l(c, 'rate not set', 'दर तय नहीं') : inr(choice.amount)}${choice.source === 'estimated' ? l(c, ' (estimated)', ' (अनुमानित)') : ''}`}`);
    const current = options.current;
    if (current) lines.push(l(c, `Current: ${current.origin_type} · ${current.status}${current.stale ? ' · changed, select again' : ''}${current.expense_id ? ` · claim #${current.expense_id}` : ''}`, `अभी: ${current.origin_type === 'home' ? 'घर' : 'ऑफिस'} · ${current.status}${current.stale ? ' · बदलाव हुआ, दोबारा चुनें' : ''}${current.expense_id ? ` · क्लेम #${current.expense_id}` : ''}`));
    const rows = current?.expense_id ? [] : options.choices.filter((x) => !x.unavailable).map((choice) => ({ id: `W:TO:${v.id}:${choice.type}:${current?.revision || 0}`, title: choice.type === 'home' ? l(c, 'Choose home', 'घर से यात्रा') : l(c, 'Choose office', 'ऑफिस से यात्रा') }));
    if (current?.status === 'approved' && !current.stale && !current.expense_id) rows.push({ id: `W:CL:${v.id}`, title: l(c, 'Submit approved claim', 'स्वीकृत क्लेम जमा करें') });
    rows.push({ id: `W:V:${v.id}`, title: l(c, 'Back to visit', 'विज़िट पर वापस') }, menuRow(c));
    return list(rec, `${v.ref}\n${lines.join('\n')}\n\n${l(c, 'A manager verifies distance and approves the amount. Claim after submitting the visit report.', 'मैनेजर दूरी और रकम की जाँच करते हैं। विज़िट रिपोर्ट के बाद क्लेम जमा करें।')}`, rows, 'travel', { type: 'visit', id: v.id });
  });
}

function travelSnapshot(rec, visitId) {
  const v = ownVisit(rec, visitId), lead = getLead(v.lead_id);
  // Compare sensitive route inputs without retaining home coordinates in the
  // conversation draft. Changing an origin/rate requires another confirmation.
  return sha256(JSON.stringify([v.revision, v.architect_id, lead.site_lat, lead.site_lng,
    originFor(rec.staff.id, 'home'), originFor(rec.staff.id, 'office'), travelSettings(), dispatchSettings(), config.routing?.osrmUrl]));
}

export async function handleStaffMessage(m, rec, { onHumanInbound } = {}) {
  if (processed(rec)) return;
  try {
    identity(rec);
    const conv = getConversation(rec.contact.id);
    if (conv.mode === 'human') return sync(rec, () => { onHumanInbound?.(rec.contact, conv); });
    const parts = String(m.buttonId || '').split(':');
    const isTravel = parts[0] === 'W' && (['TR', 'TO'].includes(parts[1]) || (parts[1] === 'SAVE' && conv.flow === FLOW && jparse(conv.ctx, {}).kind === 'travel'));
    if (isTravel) return await handleTravel(m, rec);
    return sync(rec, () => handleSync(m, rec));
  } catch (error) {
    if (!(error instanceof HttpError) || error.status >= 500) throw error;
    return tx(() => {
      // Re-check identity even when returning an error; a disabled account gets
      // only the generic blocked response from the entry point on retry.
      if (staffIdentity(getContact(rec.contact.id)).user?.id !== rec.staff.id) return;
      text(rec, `${error.message}\nType MENU to recover or HELP to ask your manager.`, `यह कार्रवाई पूरी नहीं हो सकी। ${error.message}\nफिर से शुरू करने के लिए MENU या मैनेजर से मदद के लिए HELP लिखें।`, 'error'); mark(rec);
    });
  }
}
