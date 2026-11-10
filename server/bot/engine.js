// Conversation engine: understands each inbound WhatsApp message and drives
// the flows (new enquiry, visit confirmation, quotations, support, hand-off).
// Client-visible text comes only from fixed bilingual messages, approved FAQ
// answers and database facts — AI is used for understanding only.
import { all, one, run, insert, update, tx } from '../db/index.js';
import { now, nowIso, addMinIso, jparse, minutesBetween, fmtSlot, isDevanagari, truncate, prettyPhone, normPhone } from '../lib/util.js';
import { broadcast } from '../lib/http.js';
import { config } from '../config.js';
import { audit, notify, createTask, setting, isBusinessHours, businessHoursText, setState } from '../core/base.js';
import { enqueueWhatsApp, applyStatus, touchConversation, registerGuard } from '../core/outbox.js';
import { schedule, cancelTimers, registerTimer } from '../core/timers.js';
import { getProvider, saveMediaBuffer, MAX_INBOUND_MEDIA } from '../whatsapp/providers.js';
import { t } from './i18n.js';
import { SERVICES, NATURES, WINDOWS, ZONES_DEFAULT } from './catalog.js';
import { detectIntents, extractServices, extractNature, extractWindow, extractZone, looksOutsideJaipur, parseArea, cleanName, matchFaq, extractProjectRef, norm } from './nlu.js';
import { understand, aiEnabled } from './ai.js';
import { ensureContact, getContact, getUser, getConversation, setFlow, contactProjects, firstName, displayName, servicesText, leadPlace, areaText, natureText, windowText } from '../domain/common.js';
import { getLead, openLeadFor, createLead, updateLead, missingFields, requiredFields, submitLead, markLost } from '../domain/leads.js';
import { architectRespond, clientRespond, reofferAfterReslot, slotFromId, pendingOffersFor, availableSlots } from '../domain/scheduling.js';
import { sendSlotList, cancelVisit, upcomingVisitFor, getVisit } from '../domain/visits.js';
import { clientQuoteAction, recordQuoteChangeNote } from '../domain/quotations.js';
import { clientMilestone, clientChangeDecision, projectStatusText, paymentsText, getProject } from '../domain/projects.js';
import { createTicket, appendToTicket } from '../domain/support.js';
import { staffIdentity, handleStaffMessage } from './staff.js';

const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;
const activeZones = () => all('SELECT * FROM zones WHERE active=1 ORDER BY sort');
const activeFaqs = () => all('SELECT * FROM faqs WHERE active=1');
const zonesWithKw = () => activeZones().map((z) => ({ ...z, kw: (ZONES_DEFAULT.find((d) => d.code === z.code) || {}).kw || [] }));

// ---------------------------------------------------------------- entry point
export async function processInboundEvent(ev) {
  const data = jparse(ev.payload, {});
  if (ev.kind === 'status') { tx(() => applyStatus(data)); return; }
  if (ev.kind === 'echo') { tx(() => handleEcho(data)); return; }
  if (ev.kind === 'form') { tx(() => handleWebsiteForm(data)); return; }
  if (ev.kind === 'message') await handleMessage(data);
}

// ---------------------------------------------------------------- sending
function botSend(contact, message, { kind = 'bot.reply', template } = {}) {
  const conv = getConversation(contact.id);
  const at = nowIso();
  let start = conv.bot_window_start; let count = conv.bot_window_count;
  if (!start || minutesBetween(start, at) >= 60) { start = at; count = 0; }
  if (count >= setting('bot_max_per_hour')) {
    if (conv.mode !== 'human') {
      run("UPDATE conversations SET mode='human', human_requested_at=?, needs_attention=1, attention_reason='Bot reply limit reached — please reply personally', flow=NULL, step=NULL WHERE id=?", at, conv.id);
      notify({ audience:'managers', title:`Reply limit reached · ${displayName(contact)}`, body:'Please review the conversation and reply in the inbox.', link:`#/inbox/${contact.id}`, level:'warn' });
      schedule('human_sla', { entityType:'conversation', entityId:conv.id, dueAt:addMinIso(at,setting('human_sla_min')), dedupeKey:`human-sla:${conv.id}` });
      enqueueWhatsApp({ to:contact.wa_id, kind:'bot.limit_handoff', sender:'bot', essential:true, message:{type:'text',text:t(isBusinessHours()?'handoff':'handoff_closed',contact.language,businessHoursText())}, dedupeKey:`limit-handoff:${conv.id}:${start}` });
      broadcast('inbox');
    }
    return null;
  }
  run('UPDATE conversations SET bot_window_start=?, bot_window_count=? WHERE id=?', start, count + 1, conv.id);
  return enqueueWhatsApp({ to: contact.wa_id, kind, message, template, sender: 'bot', essential: true });
}
const say = (c, key, vars, kind) => botSend(c, { type: 'text', text: t(key, c.language, vars) }, { kind: kind || key });

// ---------------------------------------------------------------- inbound recording
function previewInbound(m) {
  if (m.text) return m.text;
  if (m.buttonTitle) return `🔘 ${m.buttonTitle}`;
  if (m.location) return `📍 Location ${m.location.name || ''} ${m.location.address || ''}`.trim();
  if (m.media) return ({ image: '📷 Photo', document: '📄 Document', audio: '🎙️ Voice note', video: '🎬 Video', sticker: '🙂 Sticker' })[m.type] || '📎 File';
  return `[${m.type}]`;
}

function recordInbound(m) {
  const contact0 = ensureContact(m.from, { profileName: m.profileName });
  const at = nowIso();
  const existing = m.wamid ? one("SELECT id FROM messages WHERE wamid=? AND direction='in'", m.wamid) : null;
  if (existing) { // retry of a partly processed event: do not log twice
    const contact = getContact(contact0.id);
    const staff = staffIdentity(contact);
    return { contact, msgId: existing.id, staff: staff.user, staffBlocked: staff.blocked, isNew: false, retry: true };
  }
  const patch = { last_inbound_at: at };
  if (m.text && isDevanagari(m.text) && contact0.language !== 'hi') patch.language = 'hi';
  run(`UPDATE contacts SET last_inbound_at=?, language=COALESCE(?, language), updated_at=? WHERE id=?`, at, patch.language || null, at, contact0.id);
  const msgId = insert('messages', { contact_id: contact0.id, direction: 'in', wamid: m.wamid, type: m.type, body: previewInbound(m), payload: JSON.stringify(m), sender: 'client', status: 'received', created_at: at, status_at: at });
  touchConversation(contact0.id, truncate(previewInbound(m), 80), true);
  const contact = getContact(contact0.id);
  const staff = staffIdentity(contact);
  const isNew = one('SELECT COUNT(*) n FROM messages WHERE contact_id=? AND direction=?', contact.id, 'in').n === 1;
  if (staff.user) run("UPDATE contacts SET kind='staff',user_id=? WHERE id=?", staff.user.id, contact.id);
  return { contact, msgId, staff: staff.user, staffBlocked: staff.blocked, isNew };
}

async function saveInboundMedia(m, rec) {
  let buffer = null; let mime = m.media.mime || 'application/octet-stream';
  try {
    if (m.media.simData) { if (m.media.simData.length > MAX_INBOUND_MEDIA * 1.4) throw new Error('Media too large to store'); buffer = Buffer.from(m.media.simData, 'base64'); }
    else if (m.media.id) { const r = await getProvider().downloadMedia(m.media.id); buffer = r.buffer; mime = r.mime || mime; }
  } catch (e) { console.error('media download failed', e.message); }
  tx(() => {
    const lead = openLeadFor(rec.contact.id);
    const proj = contactProjects(rec.contact)[0];
    // Staff attachments stay private until an assigned report/site update is
    // explicitly confirmed. A staff contact can also be a former client.
    const owner = rec.staff ? ['staff_message', rec.msgId] : lead ? ['lead', lead.id] : proj ? ['project', proj.id] : ['contact', rec.contact.id];
    let saved = null;
    if (buffer && buffer.length <= (rec.staff ? 8 * 1024 * 1024 : MAX_INBOUND_MEDIA)) saved = saveMediaBuffer(buffer, mime);
    const mediaId = insert('media', { provider_media_id: m.media.id || null, mime, file_path: saved?.filePath || null, size: saved?.size || null, sha256: saved?.sha256 || null, caption: m.media.caption || null, owner_type: owner[0], owner_id: owner[1], uploaded_by: rec.staff ? `user:${rec.staff.id}` : 'client', status: saved ? 'stored' : 'download_failed', created_at: nowIso() });
    run('UPDATE messages SET media_id=? WHERE id=?', mediaId, rec.msgId);
  });
}

// ---------------------------------------------------------------- messages
async function handleMessage(m) {
  const rec = tx(() => recordInbound(m));
  if (rec.contact.erased_at) return;
  if (rec.staffBlocked) {
    tx(() => enqueueWhatsApp({ to: rec.contact.wa_id, kind: 'staff.blocked', sender: 'bot', essential: true, dedupeKey: `staff-blocked:${rec.msgId}`, message: { type: 'text', text: rec.contact.language === 'hi' ? 'इस नंबर पर कर्मचारी की पहुँच उपलब्ध नहीं है। अपने मैनेजर से संपर्क करें।' : 'Staff access is unavailable for this number. Contact your manager.' } }));
    return;
  }
  if (m.media && !rec.retry) await saveInboundMedia(m, rec);
  getProvider().markRead?.(m.wamid);
  if (rec.staff) { await handleStaffMessage(m, rec, { onHumanInbound: humanInbound }); return; }
  await handleClient(m, rec);
}

async function handleClient(m, rec) {
  const contact = rec.contact;
  const text = (m.text || '').trim();
  const intents = text ? detectIntents(text) : new Set();
  let conv = getConversation(contact.id);
  let ctx = jparse(conv.ctx, {});

  if (conv.mode !== 'human' && text && words(text) <= 2 && (intents.has('hindi') || intents.has('english'))) {
    return tx(() => { const lang = intents.has('hindi') ? 'hi' : 'en'; run('UPDATE contacts SET language=? WHERE id=?', lang, contact.id); const c = getContact(contact.id); say(c, 'lang_set'); if (!conv.flow) mainMenu(c); else if (conv.flow === 'lead') askNext(c, ctx.leadId); });
  }
  if (intents.has('stop')) return tx(() => { run('UPDATE contacts SET opted_out=1, opted_out_at=? WHERE id=?', nowIso(), contact.id); audit('client', 'contact.opt_out', 'contact', contact.id); say(contact, 'opted_out'); });
  if (intents.has('start') && contact.opted_out) return tx(() => { run('UPDATE contacts SET opted_out=0 WHERE id=?', contact.id); say(contact, 'opted_in'); });
  if (intents.has('emergency')) return tx(() => emergency(contact, text));

  if (conv.mode === 'human') {
    if (setting('human_auto_resume') && !conv.human_requested_at && !conv.needs_attention && conv.owner_until && new Date(conv.owner_until) < now()) {
      tx(() => releaseToBot(conv.id, 'expired'));
      conv = getConversation(contact.id); ctx = jparse(conv.ctx, {});
    } else return tx(() => humanInbound(contact, conv));
  }
  if (intents.has('human')) return tx(() => handoff(contact, 'Client asked to talk to a person'));
  if (m.buttonId) {
    const handled = tx(() => handleButton(m.buttonId, rec, conv, ctx));
    if (handled !== false) return;
  }
  if (m.type === 'location' && m.location) return tx(() => handleLocation(m, rec, conv, ctx));
  if (m.media && !text) return tx(() => mediaAck(m, rec, conv, ctx));
  if (!text) return;

  switch (conv.flow) {
    case 'lead': return leadText(text, intents, rec, conv, ctx);
    case 'reslot':
      if (intents.has('human') || intents.has('skip') || /call/i.test(text)) return tx(() => { reofferAfterReslot(ctx.leadId, null); setFlow(contact.id, null); say(contact, 'reslot_call'); });
      return tx(() => { const lead = getLead(ctx.leadId); sendSlotList(contact, lead, 'pick_new_time'); });
    case 'await_visit_confirm':
      if (intents.has('yes')) return tx(() => visitConfirmAction(contact, ctx.offerId, ctx.rev, 'confirm'));
      if (intents.has('no')) return tx(() => visitConfirmAction(contact, ctx.offerId, ctx.rev, 'cancel'));
      break;
    case 'quote_change': return tx(() => { recordQuoteChangeNote(ctx.quoteId, text); setFlow(contact.id, null); say(contact, 'quote_change_ack'); });
    case 'ticket': return tx(() => { const tk = createTicket({ contactId: contact.id, projectId: ctx.projectId || null, category: ctx.category || 'issue', subject: truncate(text, 80), description: text, priority: ctx.category === 'complaint' ? 'high' : 'normal' }); setFlow(contact.id, null); say(contact, 'ticket_created', { ref: tk.ref, sla: contact.language === 'hi' ? (tk.priority === 'high' ? '2 घंटे' : '1 कार्य-दिवस') : (tk.priority === 'high' ? '2 hours' : '1 working day') }); });
    case 'ms_concern': return tx(() => { const tk = createTicket({ contactId: contact.id, projectId: ctx.projectId, category: 'milestone_concern', subject: `Concern on stage #${ctx.milestoneId}`, description: text, priority: 'high' }); setFlow(contact.id, null); say(contact, 'ticket_created', { ref: tk.ref, sla: contact.language === 'hi' ? '2 घंटे' : '2 hours' }); });
    case 'lead_info': return tx(() => { const lead = getLead(ctx.leadId); if (lead) { updateLead(lead.id, { requirements: [lead.requirements, `Client: ${text}`].filter(Boolean).join('\n').slice(0, 2000) }, 'client'); notify({ audience: 'managers', title: `Client replied · ${lead.ref}`, body: truncate(text, 160), link: '#/approvals' }); } setFlow(contact.id, null); say(contact, 'quote_change_ack'); });
    case 'verify_project': return tx(() => verifyProject(contact, text));
    default: break;
  }
  return idle(text, intents, rec, conv);
}

// ---------------------------------------------------------------- menus
function mainMenu(contact, prefix = null, forceNew = false) {
  if (!prefix) clearUnknown(contact.id);
  const lang = contact.language || 'en';
  const projects = forceNew ? [] : contactProjects(contact);
  if (projects.length) return clientMenu(contact, projects[0], prefix);
  const rows = SERVICES.map((s) => ({ id: `M:svc:${s.code}`, title: lang === 'hi' ? s.hi : s.en, description: lang === 'hi' ? s.dhi : s.den }));
  const more = [{ id: 'M:EXISTING', title: t('m_existing', lang), description: t('m_existing_d', lang) }, { id: 'M:HUMAN', title: t('m_human', lang), description: t('m_human_d', lang) }];
  const text = [prefix, t('welcome_new', lang, { name: firstName(contact) })].filter(Boolean).join('\n\n');
  return botSend(contact, { type: 'list', text, button: t('choose', lang), footer: t('menu_footer', lang), sections: [{ title: t('sec_services', lang), rows }, { title: t('sec_more', lang), rows: more }] }, { kind: 'menu.main' });
}
function clientMenu(contact, project, prefix = null) {
  const lang = contact.language || 'en';
  const rows = [
    { id: `M:STATUS:${project.id}`, title: t('m_status', lang) },
    { id: `M:SITE_TEAM:${project.id}`, title: t('m_site_team', lang) },
    { id: `M:PAYMENTS:${project.id}`, title: t('m_payments', lang) },
    { id: `M:ISSUE:${project.id}`, title: t('m_issue', lang) },
    { id: 'M:NEW', title: t('m_new', lang) },
    { id: 'M:HUMAN', title: t('m_human', lang) },
  ];
  for (const p of contactProjects(contact).filter((x) => x.id !== project.id).slice(0, 3)) rows.push({ id: `M:PROJ:${p.id}`, title: `↔ ${p.ref}`.slice(0, 24) });
  const text = [prefix, t('welcome_client', lang, { name: firstName(contact), project: project.ref })].filter(Boolean).join('\n\n');
  return botSend(contact, { type: 'list', text, button: t('choose', lang), footer: t('menu_footer', lang), sections: [{ title: project.ref, rows }] }, { kind: 'menu.client' });
}

function sendFaq(contact, faq) {
  const lang = contact.language || 'en';
  const answer = (lang === 'hi' && faq.answer_hi) ? faq.answer_hi : faq.answer_en;
  return mainMenu(contact, answer + t('faq_more', lang));
}

// ---------------------------------------------------------------- buttons
// Button and list replies carry record ids. A modified WhatsApp client can send any
// id, so every client action first checks that the record belongs to this contact.
const ownsLead = (c, leadId) => !!leadId && getLead(leadId)?.contact_id === c.id;
const ownsProject = (c, projectId) => !!projectId && one('SELECT client_contact_id FROM projects WHERE id=?', projectId)?.client_contact_id === c.id;
function ownsButtonTarget(c, p) {
  switch (p[0]) {
    case 'VC': return ownsLead(c, one('SELECT lead_id FROM visit_offers WHERE id=?', Number(p[2]))?.lead_id);
    case 'VN': return ownsLead(c, getVisit(Number(p[2]))?.lead_id);
    case 'Q': return ownsLead(c, one('SELECT lead_id FROM quotations WHERE id=?', Number(p[2]))?.lead_id);
    case 'MS': return ownsProject(c, one('SELECT project_id FROM milestones WHERE id=?', Number(p[2]))?.project_id);
    case 'CR': return ownsProject(c, one('SELECT project_id FROM change_requests WHERE id=?', Number(p[2]))?.project_id);
    default: return true;
  }
}

function handleButton(id, rec, conv, ctx) {
  const c = rec.contact;
  const p = String(id).split(':');
  if (!ownsButtonTarget(c, p)) {
    audit(`contact:${c.id}`, 'bot.foreign_button_rejected', 'contact', c.id, { button: String(id).slice(0, 80) });
    say(c, 'stale_action');
    return true;
  }
  switch (p[0]) {
    case 'M': return menuChoice(p, c);
    case 'F': return fieldChoice(p, c, conv, ctx);
    case 'VC': return visitConfirmAction(c, Number(p[2]), Number(p[3]), { Y: 'confirm', R: 'reslot', N: 'cancel' }[p[1]]);
    case 'VR': {
      const v = getVisit(Number(p[2]));
      if (!v || v.status !== 'confirmed' || getLead(v.lead_id)?.contact_id !== c.id) { say(c, 'stale_action'); return true; }
      if (p[1] === 'K') { say(c, 'visit_kept'); return true; }
      cancelVisit(v.id, { reason: p[1] === 'R' ? 'Client asked to reschedule' : 'Client cancelled', actor: 'client', reslot: p[1] === 'R', notifyClient: true });
      return true;
    }
    case 'VN': {
      const v = getVisit(Number(p[2]));
      if (!v) { say(c, 'stale_action'); return true; }
      if (p[1] === 'R') { updateLead(v.lead_id, { status: 'scheduling', preferred_slots: [] }, 'client'); setFlow(c.id, 'reslot', null, { leadId: v.lead_id }); sendSlotList(c, getLead(v.lead_id), 'pick_new_time'); }
      else handoff(c, `Client asked for a call after missed visit ${v.ref}`);
      return true;
    }
    case 'Q': {
      const r = clientQuoteAction(Number(p[2]), Number(p[3]), { A: 'accept', C: 'change', H: 'call' }[p[1]]);
      if (r.stale) say(c, 'quote_stale');
      return true;
    }
    case 'MS': {
      const r = clientMilestone(Number(p[2]), p[1] === 'A');
      if (r.stale) say(c, 'stale_action');
      else if (r.concern) say(c, 'ms_concern_ask');
      return true;
    }
    case 'CR': {
      const r = clientChangeDecision(Number(p[2]), p[1] === 'A');
      say(c, r.stale ? 'stale_action' : 'cr_ack');
      return true;
    }
    case 'NU': {
      const lead = getLead(Number(p[2]));
      if (!lead || lead.contact_id !== c.id || lead.status !== 'capturing') { mainMenu(c); return true; }
      if (p[1] === 'Y') { setFlow(c.id, 'lead', null, { leadId: lead.id }); askNext(c, lead.id); }
      else { markLost(lead.id, 'Client said not now', 'client'); setFlow(c.id, null); say(c, 'not_now_ack'); }
      return true;
    }
    case 'WEB': {
      const lead = getLead(Number(p[1]));
      if (!lead || lead.contact_id !== c.id) { mainMenu(c); return true; }
      if (lead.status !== 'capturing') { mainMenu(c); return true; }
      setFlow(c.id, 'lead', null, { leadId: lead.id, fromWebsite: true });
      askNext(c, lead.id);
      return true;
    }
    case 'L': run('UPDATE contacts SET language=? WHERE id=?', p[1] === 'hi' ? 'hi' : 'en', c.id); mainMenu(getContact(c.id)); return true;
    case 'OF': say(c, 'stale_action'); return true;
    default: return false;
  }
}

function visitConfirmAction(c, offerId, rev, action) {
  const r = clientRespond(offerId, rev, action);
  if (r.stale) { say(c, 'stale_action'); return true; }
  if (r.askSlots) sendSlotList(c, getLead(one('SELECT lead_id FROM visit_offers WHERE id=?', offerId).lead_id), 'pick_new_time');
  return true;
}

function menuChoice(p, c) {
  const lang = c.language || 'en';
  const pid = Number(p[2]);
  const ownProject = (id) => contactProjects(c).find((x) => x.id === id);
  switch (p[1]) {
    case 'svc': return startLead(c, { services: [p[2]] }), true;
    case 'FORCE_NEW': {
      const lead = createLead({ contactId: c.id, fields: p[2] ? { services: [p[2]] } : {} });
      setFlow(c.id, 'lead', null, { leadId: lead.id }); askNext(c, lead.id); return true;
    }
    case 'NEW': mainMenu(c, null, true); return true;
    case 'HUMAN': handoff(c, 'Client chose "Talk to our team"'); return true;
    case 'EXISTING': {
      const projects = contactProjects(c);
      if (projects.length) { clientMenu(c, projects[0]); return true; }
      setFlow(c.id, 'verify_project');
      return botSend(c, { type: 'buttons', text: t('no_project_found', lang), buttons: [{ id: 'M:HUMAN', title: t('btn_talk_team', lang) }, { id: 'M:NEW', title: t('btn_new_enquiry', lang) }] }, { kind: 'menu.verify' }), true;
    }
    case 'PROJ': { const pr = ownProject(pid); if (pr) clientMenu(c, pr); else mainMenu(c); return true; }
    case 'STATUS': { const pr = ownProject(pid); if (!pr) return mainMenu(c), true; botSend(c, { type: 'text', text: projectStatusText(pr, lang) }, { kind: 'project.status' }); return true; }
    case 'PAYMENTS': { const pr = ownProject(pid); if (!pr) return mainMenu(c), true; botSend(c, { type: 'text', text: paymentsText(pr, lang) }, { kind: 'project.payments' }); return true; }
    case 'SITE_TEAM': {
      const pr = ownProject(pid); if (!pr) return mainMenu(c), true;
      const tk = createTicket({ contactId: c.id, projectId: pr.id, category: 'contact_site_team', subject: `Client wants to talk to site team (${pr.ref})`, priority: 'high' });
      say(c, 'site_team_ack', { ref: tk.ref });
      return true;
    }
    case 'ISSUE': { const pr = ownProject(pid); setFlow(c.id, 'ticket', null, { projectId: pr?.id || null, category: 'issue' }); say(c, 'ticket_ask'); return true; }
    default: mainMenu(c); return true;
  }
}

// ---------------------------------------------------------------- lead capture
function leadStatusLabel(lead, lang) { const key = `ls_${lead.status}`; return t(key, lang) === key ? lead.status : t(key, lang); }

function startLead(c, fields = {}, prefix = null) {
  let lead = openLeadFor(c.id);
  if (lead && lead.status !== 'capturing') {
    const lang = c.language || 'en';
    const svc = (fields.services || [])[0] || '';
    return botSend(c, { type: 'buttons', text: t('existing_lead', lang, { ref: lead.ref, status: leadStatusLabel(lead, lang) }), buttons: [{ id: `M:FORCE_NEW:${svc}`, title: t('btn_new_enquiry', lang) }, { id: 'M:HUMAN', title: t('btn_talk_team', lang) }] }, { kind: 'lead.existing' });
  }
  if (!lead) lead = createLead({ contactId: c.id, fields });
  else if (Object.keys(fields).length) applyFields(lead, fields, null);
  setFlow(c.id, 'lead', null, { leadId: lead.id });
  return askNext(c, lead.id, prefix);
}

/** Fill fields without overwriting known values (except the one being asked). */
function applyFields(lead, found, step) {
  const patch = {};
  const svc = jparse(lead.services, []);
  if (found.services?.length && (!svc.length || step === 'services')) patch.services = found.services;
  const set = (col, stepName) => { if (found[col] !== undefined && found[col] !== null && (lead[col] === null || lead[col] === undefined || lead[col] === '' || step === stepName)) patch[col] = found[col]; };
  set('zone', 'zone'); set('locality', 'zone'); set('project_nature', 'nature'); set('area_sqft', 'area'); set('area_text', 'area'); set('execution_window', 'window'); set('name', 'name');
  set('requirements', 'requirements'); set('address', 'location'); set('location_source', 'location');
  if (step === 'zone_text') { if (found.zone) patch.zone = found.zone; if (found.locality) patch.locality = found.locality; }
  if (found.requirements_note) patch.requirements = [lead.requirements, found.requirements_note].filter(Boolean).join('\n').slice(0, 2000);
  if (found.ai_summary) patch.ai_summary = found.ai_summary;
  if (Object.keys(patch).length) return updateLead(lead.id, patch, 'bot');
  return lead;
}

function askNext(c, leadId, prefix = null) {
  const lead = getLead(leadId);
  if (!lead) return mainMenu(c);
  const conv = getConversation(c.id);
  const ctx = { ...jparse(conv.ctx, {}), leadId };
  const lang = c.language || 'en';
  const missing = missingFields(lead, ctx);
  if (!missing.length) return sendSummary(c, lead, ctx, prefix);
  const f = missing[0];
  setFlow(c.id, 'lead', f, ctx);
  const withPrefix = (s) => [prefix, s].filter(Boolean).join('\n\n');
  switch (f) {
    case 'services': {
      const rows = SERVICES.map((s) => ({ id: `F:svc:${s.code}`, title: lang === 'hi' ? s.hi : s.en, description: lang === 'hi' ? s.dhi : s.den }));
      return botSend(c, { type: 'list', text: withPrefix(t('ask_service', lang)), button: t('choose', lang), sections: [{ title: t('sec_services', lang), rows }] }, { kind: 'lead.ask_service' });
    }
    case 'zone': {
      const zones = activeZones().filter((z) => !['other_jaipur', 'outside'].includes(z.code)).slice(0, 9);
      const rows = zones.map((z) => ({ id: `F:zone:${z.code}`, title: lang === 'hi' && z.name_hi ? z.name_hi : z.name }));
      rows.push({ id: 'F:zone:other', title: t('zone_other_row', lang) });
      return botSend(c, { type: 'list', text: withPrefix(t('ask_zone', lang)), button: t('choose', lang), sections: [{ title: 'Jaipur', rows }] }, { kind: 'lead.ask_zone' });
    }
    case 'nature': {
      const rows = NATURES.map((n) => ({ id: `F:nature:${n.code}`, title: lang === 'hi' ? n.hi : n.en }));
      return botSend(c, { type: 'list', text: withPrefix(t('ask_nature', lang)), button: t('choose', lang), sections: [{ title: t('f_nature', lang), rows }] }, { kind: 'lead.ask_nature' });
    }
    case 'area': return botSend(c, { type: 'text', text: withPrefix(t('ask_area', lang)) }, { kind: 'lead.ask_area' });
    case 'window': return botSend(c, { type: 'buttons', text: withPrefix(t('ask_window', lang)), buttons: WINDOWS.map((w) => ({ id: `F:win:${w.code}`, title: lang === 'hi' ? w.hi : w.en })) }, { kind: 'lead.ask_window' });
    case 'name': return botSend(c, { type: 'text', text: withPrefix(t('ask_name', lang)) }, { kind: 'lead.ask_name' });
    case 'requirements': return botSend(c, { type: 'text', text: withPrefix(t('ask_requirements', lang)) }, { kind: 'lead.ask_requirements' });
    case 'location': return botSend(c, { type: 'location_request', text: withPrefix(t('ask_location', lang)) }, { kind: 'lead.ask_location' });
    case 'slot': {
      const slots = availableSlots(lead, 9);
      if (!slots.length) {
        setFlow(c.id, 'lead', 'slot', { ...ctx, slotOther: true });
        return sendSummary(c, lead, { ...ctx, slotOther: true }, [prefix, t('no_slots', lang)].filter(Boolean).join('\n\n'));
      }
      const rows = slots.map((s) => ({ id: `F:slot:${s.replace(/[-:]/g, '').slice(0, 13)}`, title: fmtSlot(s, lang).slice(0, 24) }));
      rows.push({ id: 'F:slot:other', title: t('slot_other', lang) });
      return botSend(c, { type: 'list', text: withPrefix(t('ask_slot', lang)), button: t('slot_button', lang), sections: [{ title: t('slot_section', lang), rows }] }, { kind: 'lead.ask_slot' });
    }
    default: return sendSummary(c, lead, ctx, prefix);
  }
}

function sendSummary(c, lead, ctx, prefix = null) {
  const lang = c.language || 'en';
  setFlow(c.id, 'lead', 'summary', ctx);
  const slots = jparse(lead.preferred_slots, []);
  const place = leadPlace(lead, lang) + (lead.site_lat !== null ? ` · ${t('pin_received', lang)}` : lead.address ? ` · ${truncate(lead.address, 60)}` : '');
  const services = jparse(lead.services, []);
  const materialsOnly = services.length && services.every((s) => s === 'materials');
  const text = materialsOnly
    ? t('summary_materials', lang, { name: lead.name || '—', requirements: lead.requirements || '—', place })
    : t('summary', lang, { name: lead.name || '—', services: servicesText(lead.services, lang), nature: natureText(lead, lang), area: areaText(lead, lang), place, window: windowText(lead, lang), slot: slots.length ? fmtSlot(slots[0], lang) : t('team_will_call', lang) });
  return botSend(c, { type: 'buttons', text: [prefix, text].filter(Boolean).join('\n\n'), buttons: [{ id: 'F:confirm:yes', title: t('btn_confirm', lang) }, { id: 'F:confirm:edit', title: t('btn_change', lang) }] }, { kind: 'lead.summary' });
}

function fieldChoice(p, c, conv, ctx) {
  const [, field, ...rest] = p;
  const value = rest.join(':');
  // Slot choice after "Another time" (lead already approved)
  if (conv.flow === 'reslot' && field === 'slot') {
    const iso = value === 'other' ? null : slotFromId(value);
    const r = reofferAfterReslot(ctx.leadId, iso);
    setFlow(c.id, null);
    say(c, iso && !r.error ? 'reslot_ack' : 'reslot_call');
    return true;
  }
  const lead = ctx.leadId ? getLead(ctx.leadId) : null;
  if (conv.flow !== 'lead' || !lead || lead.status !== 'capturing') { mainMenu(c, t('stale_action', c.language)); return true; }
  const lang = c.language || 'en';
  switch (field) {
    case 'svc': updateLead(lead.id, { services: [value] }, 'client'); break;
    case 'zone':
      if (value === 'other') { setFlow(c.id, 'lead', 'zone_text', ctx); return botSend(c, { type: 'text', text: t('ask_zone_text', lang) }, { kind: 'lead.ask_zone_text' }), true; }
      updateLead(lead.id, { zone: value, locality: null }, 'client'); break;
    case 'nature': updateLead(lead.id, { project_nature: value }, 'client'); break;
    case 'win': updateLead(lead.id, { execution_window: value }, 'client'); break;
    case 'slot': {
      if (value === 'other') { updateLead(lead.id, { preferred_slots: [] }, 'client'); setFlow(c.id, 'lead', 'slot', { ...ctx, slotOther: true }); break; }
      const iso = slotFromId(value);
      if (!iso || new Date(iso) < now()) { askNext(c, lead.id, t('not_understood', lang)); return true; }
      updateLead(lead.id, { preferred_slots: [iso] }, 'client');
      setFlow(c.id, 'lead', 'slot', { ...ctx, slotOther: false });
      break;
    }
    case 'confirm': {
      if (value === 'yes') {
        const fresh = getLead(lead.id); const cx = jparse(getConversation(c.id).ctx, {});
        if (missingFields(fresh, cx).length) { askNext(c, lead.id); return true; }
        submitLead(lead.id, { slotOther: !!cx.slotOther });
        return true;
      }
      const fields = requiredFields(getLead(lead.id));
      const rows = fields.map((f) => ({ id: `F:edit:${f}`, title: t(`f_${f}`, lang) }));
      return botSend(c, { type: 'list', text: t('change_what', lang), button: t('choose', lang), sections: [{ title: t('btn_change', lang), rows }] }, { kind: 'lead.change' }), true;
    }
    case 'edit': {
      const clear = { services: { services: [] }, zone: { zone: null, locality: null }, nature: { project_nature: null }, area: { area_sqft: null, area_text: null }, window: { execution_window: null }, name: { name: null }, location: { site_lat: null, site_lng: null, address: null, location_source: null }, slot: { preferred_slots: [] }, requirements: { requirements: null } }[value];
      if (clear) {
        const patch = { ...clear };
        if ('site_lat' in patch) { run('UPDATE leads SET site_lat=NULL, site_lng=NULL, address=NULL, location_source=NULL WHERE id=?', lead.id); delete patch.site_lat; delete patch.site_lng; delete patch.address; delete patch.location_source; }
        if (Object.keys(patch).length) updateLead(lead.id, patch, 'client');
        if (value === 'slot') setFlow(c.id, 'lead', null, { ...ctx, slotOther: false });
      }
      break;
    }
    default: return false;
  }
  askNext(c, lead.id);
  return true;
}

function extractAll(text, zones) {
  const found = {};
  const svc = extractServices(text); if (svc.length) found.services = svc;
  const z = extractZone(text, zones); if (z) { found.zone = z.zone; if (z.locality) found.locality = z.locality; }
  const nat = extractNature(text); if (nat) found.project_nature = nat;
  const ar = parseArea(text); if (ar) { found.area_sqft = ar.sqft; found.area_text = ar.text; }
  const win = extractWindow(text); if (win) found.execution_window = win;
  return found;
}
function mergeAi(found, ai) {
  if (!ai || ai.confidence < setting('ai_confidence_threshold')) return found;
  const out = { ...found };
  if (!out.services && ai.services.length) out.services = ai.services;
  if (!out.zone && ai.zone) out.zone = ai.zone;
  if (!out.locality && ai.locality) out.locality = ai.locality;
  if (!out.project_nature && ai.project_nature) out.project_nature = ai.project_nature;
  if (!out.area_sqft && ai.area_sqft) { out.area_sqft = ai.area_sqft; out.area_text = `${ai.area_sqft} sq ft`; }
  if (!out.execution_window && ai.execution_window) out.execution_window = ai.execution_window;
  if (!out.name && ai.name) out.name = ai.name;
  if (ai.requirements) out.requirements_note = ai.requirements;
  if (ai.summary) out.ai_summary = ai.summary;
  return out;
}
const stepColumn = { services: 'services', zone: 'zone', zone_text: 'zone', nature: 'project_nature', area: 'area_sqft', window: 'execution_window', name: 'name', requirements: 'requirements', location: 'address' };

async function leadText(text, intents, rec, conv, ctx) {
  const c = rec.contact;
  const lead0 = getLead(ctx.leadId);
  if (!lead0 || lead0.status !== 'capturing') { tx(() => setFlow(c.id, null)); return idle(text, intents, rec, getConversation(c.id)); }
  const step = conv.step;
  const zones = zonesWithKw();
  let found = extractAll(text, zones);
  if (step === 'name') { const n = cleanName(text); if (n) found.name = n; }
  if (step === 'requirements') found.requirements = truncate(text, 1000);
  if (step === 'zone_text') { const z = extractZone(text, zones); found.zone = z?.zone || (looksOutsideJaipur(text) ? 'outside' : 'other_jaipur'); found.locality = truncate(text, 120); }
  if (step === 'location') { if (intents.has('skip')) found.location_source = 'skipped'; else if (text.length >= 6) { found.address = truncate(text, 300); found.location_source = 'text'; } }
  if (step === 'area' && intents.has('skip')) found.area_text = 'not sure';
  if (step === 'summary') {
    if (intents.has('yes')) return tx(() => fieldChoice(['F', 'confirm', 'yes'], c, getConversation(c.id), ctx));
    if (intents.has('no')) return tx(() => fieldChoice(['F', 'confirm', 'edit'], c, getConversation(c.id), ctx));
  }
  if (step === 'slot' && (intents.has('skip') || /other|call|baad|बाद/i.test(text))) {
    return tx(() => { updateLead(lead0.id, { preferred_slots: [] }, 'client'); setFlow(c.id, 'lead', 'slot', { ...ctx, slotOther: true }); askNext(c, lead0.id); });
  }
  const col = stepColumn[step];
  let satisfied = col ? (col === 'services' ? !!found.services : found[col] !== undefined && found[col] !== null) || (step === 'area' && !!found.area_text) || (step === 'location' && !!found.location_source) : false;
  let ai = null;
  let faq = null;
  if (!satisfied) {
    faq = matchFaq(text, activeFaqs());
    if (!faq && aiEnabled() && words(text) >= 2) {
      ai = await understand({ text, step, known: { services: jparse(lead0.services, []), zone: lead0.zone, nature: lead0.project_nature, area: lead0.area_sqft, window: lead0.execution_window, name: lead0.name }, zones, faqs: activeFaqs() });
      if (ai && ai.confidence < setting('ai_confidence_threshold')) ai = null;
      if (ai) {
        found = mergeAi(found, ai);
        if (ai.faq_id) faq = activeFaqs().find((f) => f.id === ai.faq_id) || null;
        if (ai.intent === 'talk_to_human' && ai.confidence >= 0.6) return tx(() => handoff(c, 'AI: client wants a person'));
        if (step === 'name' && ai.name) satisfied = true;
      }
    }
  }
  return tx(() => {
    const latestConversation = getConversation(c.id);
    if (latestConversation.mode === 'human') return humanInbound(c, latestConversation);
    let lead = getLead(lead0.id);
    if (found.zone === 'outside' && step !== 'zone_text' && step !== 'zone') delete found.zone;
    lead = applyFields(lead, found, step);
    const conv2 = getConversation(c.id);
    const cx = jparse(conv2.ctx, {});
    let prefix = null;
    if (faq) prefix = (c.language === 'hi' && faq.answer_hi) ? faq.answer_hi : faq.answer_en;
    const stillMissing = missingFields(lead, cx);
    if (step && stillMissing[0] === step && !faq) {
      const retries = { ...(cx.retries || {}) }; retries[step] = (retries[step] || 0) + 1;
      if (retries[step] >= setting('bot_unknown_before_handoff') && !['area','name','location'].includes(step)) return handoff(c, `Repeated difficulty answering the ${step} question`);
      if (retries[step] >= 2 && ['area', 'name', 'location'].includes(step)) {
        if (step === 'area') lead = updateLead(lead.id, { area_text: truncate(text, 60) }, 'client');
        if (step === 'name') lead = updateLead(lead.id, { name: truncate(text, 60) }, 'client');
        if (step === 'location') lead = updateLead(lead.id, { address: truncate(text, 300), location_source: 'text' }, 'client');
      } else {
        setFlow(c.id, 'lead', step, { ...cx, retries });
        prefix = step === 'area' ? null : t('not_understood', c.language);
        if (step === 'area') return botSend(c, { type: 'text', text: t('ask_area_retry', c.language) }, { kind: 'lead.ask_area_retry' });
      }
    }
    return askNext(c, lead.id, prefix);
  });
}

function handleLocation(m, rec, conv, ctx) {
  const c = rec.contact; const loc = m.location;
  const lead = conv.flow === 'lead' && ctx.leadId ? getLead(ctx.leadId) : openLeadFor(c.id);
  if (lead && ['capturing', 'awaiting_approval', 'scheduling', 'visit_confirmed', 'needs_followup'].includes(lead.status)) {
    const addr = loc.address && loc.name && loc.address.toLowerCase().includes(loc.name.toLowerCase()) ? loc.address : [loc.name, loc.address].filter(Boolean).join(', ');
    run('UPDATE leads SET site_lat=?, site_lng=?, address=COALESCE(?, address), location_source=?, updated_at=? WHERE id=?', loc.lat, loc.lng, addr || null, 'pin', nowIso(), lead.id);
    audit('client', 'lead.location', 'lead', lead.id, loc);
    broadcast('leads');
    if (conv.flow === 'lead' && lead.status === 'capturing') return askNext(c, lead.id);
    return say(c, 'media_ack');
  }
  const proj = contactProjects(c)[0];
  if (proj && proj.site_lat === null) run('UPDATE projects SET site_lat=?, site_lng=? WHERE id=?', loc.lat, loc.lng, proj.id);
  return say(c, 'media_ack');
}

function mediaAck(m, rec, conv, ctx) {
  const c = rec.contact;
  if (m.type === 'audio') { run("UPDATE conversations SET needs_attention=1, attention_reason='Voice note — please listen' WHERE contact_id=?", c.id); notify({ audience: 'managers', title: `Voice note from ${displayName(c)}`, link: `#/inbox/${c.id}` }); return say(c, 'voice_ack'); }
  if (m.type === 'sticker') return null;
  const last = ctx.lastMediaAck;
  if (last && minutesBetween(last, nowIso()) < 3) return null;
  run('UPDATE conversations SET ctx=? WHERE contact_id=?', JSON.stringify({ ...ctx, lastMediaAck: nowIso() }), c.id);
  if (conv.flow === 'ticket' || conv.flow === 'ms_concern') return say(c, 'media_ack');
  if (conv.flow === 'lead' && ctx.leadId) return askNext(c, ctx.leadId, t('media_ack', c.language));
  return say(c, 'media_ack');
}

// ---------------------------------------------------------------- idle / free text
async function idle(text, intents, rec, conv) {
  const c = rec.contact;
  const projects = contactProjects(c);
  if (intents.has('complaint') && !projects.length) return tx(() => handoff(c, 'Customer complaint requires review'));
  if (intents.has('thanks') && words(text) <= 4) return tx(() => say(c, 'thanks_reply'));
  if (intents.has('menu') || (intents.has('greeting') && words(text) <= 4)) return tx(() => mainMenu(c));
  if (projects.length) {
    const pr = projects[0];
    if (intents.has('status')) return tx(() => botSend(c, { type: 'text', text: projectStatusText(pr, c.language) }, { kind: 'project.status' }));
    if (intents.has('payment')) return tx(() => botSend(c, { type: 'text', text: paymentsText(pr, c.language) }, { kind: 'project.payments' }));
    if (intents.has('complaint')) return tx(() => {
      if (words(text) >= 5) { const tk = createTicket({ contactId: c.id, projectId: pr.id, category: 'complaint', subject: truncate(text, 80), description: text, priority: 'high' }); return say(c, 'ticket_created', { ref: tk.ref, sla: c.language === 'hi' ? '2 घंटे' : '2 hours' }); }
      setFlow(c.id, 'ticket', null, { projectId: pr.id, category: 'complaint' }); return say(c, 'ticket_ask');
    });
  }
  const upcoming = upcomingVisitFor(c.id);
  if (upcoming && (intents.has('visit') || /reschedul|change.*time|postpone|cancel|samay|time badal|बदल|रद्द/i.test(text))) {
    return tx(() => botSend(c, { type: 'buttons', text: t('visit_manage', c.language, { ref: upcoming.ref, slot: fmtSlot(upcoming.start_at, c.language) }), buttons: [{ id: `VR:K:${upcoming.id}`, title: t('btn_keep', c.language) }, { id: `VR:R:${upcoming.id}`, title: t('btn_new_time', c.language) }, { id: `VR:C:${upcoming.id}`, title: t('btn_cancel_visit', c.language) }] }, { kind: 'visit.manage' }));
  }
  if (intents.has('job') || intents.has('vendor')) return tx(() => jobOrVendor(c, text, intents.has('job') ? 'job_seeker' : 'vendor'));
  if (intents.has('project_ref') && !projects.length) return tx(() => verifyProject(c, text));

  const zones = zonesWithKw();
  let found = extractAll(text, zones);
  const faqs = activeFaqs();
  let faq = matchFaq(text, faqs);
  let ai = null;
  if (!faq && aiEnabled() && words(text) >= 2) {
    ai = await understand({ text, step: null, known: {}, zones, faqs });
    if (ai && ai.confidence < setting('ai_confidence_threshold')) ai = null;
    if (ai) {
      found = mergeAi(found, ai);
      if (ai.faq_id) faq = faqs.find((f) => f.id === ai.faq_id) || null;
    }
  }
  return tx(() => {
    const latestConversation = getConversation(c.id);
    if (latestConversation.mode === 'human') return humanInbound(c, latestConversation);
    const intent = ai?.intent;
    if (intent === 'talk_to_human' && ai.confidence >= 0.6) return handoff(c, 'AI: client wants a person');
    if (intent === 'job_or_vendor' && ai.confidence >= 0.6) return jobOrVendor(c, text, 'vendor');
    if (intent === 'opt_out' && ai.confidence >= 0.8) { run('UPDATE contacts SET opted_out=1, opted_out_at=? WHERE id=?', nowIso(), c.id); return say(c, 'opted_out'); }
    if (projects.length && ['project_status', 'existing_project'].includes(intent)) return botSend(c, { type: 'text', text: projectStatusText(projects[0], c.language) }, { kind: 'project.status' });
    if (projects.length && intent === 'payment') return botSend(c, { type: 'text', text: paymentsText(projects[0], c.language) }, { kind: 'project.payments' });
    const hasLeadInfo = found.services || found.zone || found.area_sqft || found.project_nature || ['new_enquiry', 'provide_details'].includes(intent);
    if (hasLeadInfo && !(projects.length && !found.services)) {
      const fields = { ...found };
      delete fields.requirements_note;
      if (fields.zone === 'outside') delete fields.zone;
      if (found.requirements_note) fields.requirements = found.requirements_note;
      const prefix = faq ? ((c.language === 'hi' && faq.answer_hi) ? faq.answer_hi : faq.answer_en) : (rec.isNew ? t('welcome_short', c.language, { name: firstName(c) }) : null);
      return startLead(c, fields, prefix);
    }
    if (faq) { clearUnknown(c.id); return sendFaq(c, faq); }
    const lead = openLeadFor(c.id);
    if (lead && lead.status === 'capturing') { setFlow(c.id, 'lead', null, { leadId: lead.id }); return askNext(c, lead.id); }
    const current = getConversation(c.id), context = jparse(current.ctx, {});
    const unknownReplies = Number(context.unknownReplies || 0) + 1;
    run('UPDATE conversations SET ctx=? WHERE id=?', JSON.stringify({...context, unknownReplies}), current.id);
    if (unknownReplies >= setting('bot_unknown_before_handoff')) return handoff(c, 'Repeated question could not be answered confidently');
    return mainMenu(c, t('not_understood', c.language));
  });
}

function clearUnknown(contactId) {
  const conv = getConversation(contactId), ctx = jparse(conv?.ctx, {});
  if (ctx.unknownReplies) { delete ctx.unknownReplies; run('UPDATE conversations SET ctx=? WHERE id=?',JSON.stringify(ctx),conv.id); }
}

function jobOrVendor(c, text, kind) {
  run('UPDATE contacts SET kind=? WHERE id=? AND kind=?', kind, c.id, 'client');
  createTask({ title: `${kind === 'job_seeker' ? 'Job enquiry' : 'Vendor / supplier'}: ${displayName(c)}`, description: `${prettyPhone(c.wa_id)}\n${text}`, kind: 'follow_up', priority: 'low', entityType: 'contact', entityId: c.id, dedupeKey: `jobvendor:${c.id}` });
  return say(c, 'job_vendor');
}

function verifyProject(c, text) {
  const ref = extractProjectRef(text);
  if (!ref) { setFlow(c.id, null); return mainMenu(c); }
  const p = one('SELECT * FROM projects WHERE ref=?', ref);
  if (p && (p.client_phone === c.wa_id || jparse(p.authorized_phones, []).includes(c.wa_id))) { setFlow(c.id, null); return clientMenu(c, p); }
  createTicket({ contactId: c.id, projectId: null, category: 'verify_access', subject: `Verify number for ${ref}`, description: `${displayName(c)} (${prettyPhone(c.wa_id)}) asked about ${ref}. Do not share details until verified; add the number to the project's authorised phones.`, priority: 'normal' });
  setFlow(c.id, null);
  return say(c, 'verify_project');
}

// ---------------------------------------------------------------- hand-off to people
function handoff(c, reason) {
  const conv = getConversation(c.id);
  run("UPDATE conversations SET mode='human', owner_user_id=NULL, owner_until=?, human_requested_at=?, needs_attention=1, attention_reason=?, flow=NULL, step=NULL WHERE id=?", addMinIso(nowIso(), setting('human_release_min') * 3), nowIso(), reason, conv.id);
  notify({ audience: 'managers', title: `💬 ${displayName(c)} wants to talk`, body: reason, link: `#/inbox/${c.id}`, level: 'warn' });
  if (isBusinessHours()) {
    schedule('human_sla', { entityType: 'conversation', entityId: conv.id, dueAt: addMinIso(nowIso(), setting('human_sla_min')), dedupeKey: `human-sla:${conv.id}` });
    say(c, 'handoff');
  } else {
    say(c, 'handoff_closed', businessHoursText());
    createTask({ title: `Call back ${displayName(c)} in the morning`, description: reason, kind: 'call_client', priority: 'high', entityType: 'contact', entityId: c.id, dedupeKey: `callback:${c.id}:${new Date().toISOString().slice(0, 10)}` });
  }
  schedule('human_release', { entityType: 'conversation', entityId: conv.id, dueAt: addMinIso(nowIso(), setting('human_release_min') * 3), dedupeKey: `human-release:${conv.id}` });
  broadcast('inbox');
}

function humanInbound(c, conv) {
  run("UPDATE conversations SET needs_attention=1, attention_reason=COALESCE(attention_reason, 'New message') WHERE id=?", conv.id);
  if (conv.owner_user_id) notify({ userId: conv.owner_user_id, title: `New message from ${displayName(c)}`, link: `#/inbox/${c.id}` });
  else notify({ audience: 'managers', title: `New message from ${displayName(c)}`, link: `#/inbox/${c.id}` });
  const pending = one("SELECT 1 FROM timers WHERE dedupe_key=? AND status='pending'", `human-sla:${conv.id}`);
  if (!pending && isBusinessHours()) schedule('human_sla', { entityType: 'conversation', entityId: conv.id, dueAt: addMinIso(nowIso(), setting('human_sla_min')), dedupeKey: `human-sla:${conv.id}` });
  broadcast('inbox');
}

export function releaseToBot(convId, why = 'released') {
  run("UPDATE conversations SET mode='bot', owner_user_id=NULL, owner_until=NULL, human_requested_at=NULL, needs_attention=0, attention_reason=NULL, flow=NULL, step=NULL, ctx='{}' WHERE id=?", convId);
  cancelTimers('conversation', convId, ['human_sla', 'human_release']);
  audit('system', 'conversation.release', 'conversation', convId, { why });
  broadcast('inbox');
}

registerTimer('human_sla', (tm) => {
  const conv = one('SELECT * FROM conversations WHERE id=?', tm.entity_id);
  if (!conv || conv.mode !== 'human') return 'not human';
  const lastIn = one("SELECT created_at FROM messages WHERE contact_id=? AND direction='in' ORDER BY id DESC LIMIT 1", conv.contact_id);
  const lastStaff = one("SELECT created_at FROM messages WHERE contact_id=? AND direction='out' AND sender LIKE 'user:%' ORDER BY id DESC LIMIT 1", conv.contact_id);
  if (lastStaff && lastIn && lastStaff.created_at > lastIn.created_at) return 'answered';
  const c = getContact(conv.contact_id);
  notify({ audience: 'owner', title: `⏰ ${displayName(c)} waiting > ${setting('human_sla_min')} min`, body: conv.attention_reason || '', link: `#/inbox/${c.id}`, level: 'error' });
  enqueueWhatsApp({ to: c.wa_id, kind: 'bot.holding', sender: 'bot', essential: true, message: { type: 'text', text: t('holding', c.language) }, dedupeKey: `holding:${conv.id}:${(lastIn?.created_at || '').slice(0, 13)}` });
  return 'escalated';
});
registerTimer('human_release', (tm) => {
  const conv = one('SELECT * FROM conversations WHERE id=?', tm.entity_id);
  if (!conv || conv.mode !== 'human') return 'already bot';
  if (!setting('human_auto_resume') || conv.human_requested_at || conv.needs_attention) return 'waiting for explicit staff release';
  if (conv.owner_until && new Date(conv.owner_until) > now()) { schedule('human_release', { entityType: 'conversation', entityId: conv.id, dueAt: conv.owner_until, dedupeKey: `human-release:${conv.id}` }); return 'extended'; }
  releaseToBot(conv.id, 'inactivity');
  return 'released';
});

/** Staff reply from the dashboard inbox (takes ownership, extends it). */
export function staffReply(contactId, user, text) {
  return tx(() => {
    const c = getContact(contactId);
    if (!c) return { error: 'Contact not found' };
    const conv = getConversation(c.id);
    const until = addMinIso(nowIso(), setting('human_release_min'));
    run("UPDATE conversations SET mode='human', owner_user_id=?, owner_until=?, needs_attention=0, attention_reason=NULL, unread=0 WHERE id=?", user.id, until, conv.id);
    cancelTimers('conversation', conv.id, ['human_sla']);
    schedule('human_release', { entityType: 'conversation', entityId: conv.id, dueAt: until, dedupeKey: `human-release:${conv.id}` });
    const id = enqueueWhatsApp({ to: c.wa_id, kind: 'staff.reply', sender: `user:${user.id}`, essential: true, message: { type: 'text', text } });
    run("UPDATE tickets SET first_response_at=COALESCE(first_response_at, ?) WHERE contact_id=? AND status NOT IN ('resolved','closed')", nowIso(), c.id);
    audit(`user:${user.id}`, 'conversation.reply', 'contact', c.id);
    return { ok: true, outboxId: id };
  });
}
export function takeOver(contactId, user) {
  return tx(() => {
    const conv = getConversation(contactId);
    const until = addMinIso(nowIso(), setting('human_release_min'));
    run("UPDATE conversations SET mode='human', owner_user_id=?, owner_until=?, needs_attention=0, flow=NULL, step=NULL WHERE id=?", user.id, until, conv.id);
    cancelTimers('conversation', conv.id, ['human_sla']);
    schedule('human_release', { entityType: 'conversation', entityId: conv.id, dueAt: until, dedupeKey: `human-release:${conv.id}` });
    audit(`user:${user.id}`, 'conversation.takeover', 'contact', contactId);
    broadcast('inbox');
    return { ok: true };
  });
}

function emergency(c, text) {
  run("UPDATE conversations SET mode='human', human_requested_at=?, needs_attention=1, attention_reason='🚨 EMERGENCY', flow=NULL, step=NULL WHERE contact_id=?", nowIso(), c.id);
  notify({ audience: 'managers', title: `🚨 EMERGENCY from ${displayName(c)}`, body: `${prettyPhone(c.wa_id)}: ${truncate(text, 200)}`, link: `#/inbox/${c.id}`, level: 'error' });
  const uid = setting('emergency_user_id');
  const targets = uid ? all('SELECT * FROM users WHERE id=? AND phone IS NOT NULL', uid) : all("SELECT * FROM users WHERE role='owner' AND active=1 AND phone IS NOT NULL");
  for (const u of targets) enqueueWhatsApp({ to: u.phone, kind: 'staff.emergency', essential: true, message: { type: 'text', text: `🚨 EMERGENCY from ${displayName(c)} (${prettyPhone(c.wa_id)}): ${truncate(text, 300)}` }, template: { name: 'ns_staff_alert', params: [`EMERGENCY from ${displayName(c)} ${prettyPhone(c.wa_id)}: ${truncate(text, 200)}`] } });
  say(c, 'emergency_ack');
}

// ---------------------------------------------------------------- coexistence echoes & website form
function handleEcho(e) {
  const c = ensureContact(e.to);
  if (one('SELECT 1 FROM messages WHERE wamid=?', e.wamid)) return;
  const at = nowIso();
  insert('messages', { contact_id: c.id, direction: 'out', wamid: e.wamid, type: e.type, body: e.text || `[${e.type}]`, sender: 'app', status: 'sent', created_at: at, status_at: at });
  touchConversation(c.id, '↪ ' + truncate(e.text || e.type, 80), false);
  const conv = getConversation(c.id);
  const until = addMinIso(at, setting('human_release_min'));
  run("UPDATE conversations SET mode='human', owner_until=?, needs_attention=0 WHERE id=?", until, conv.id);
  cancelTimers('conversation', conv.id, ['human_sla']);
  schedule('human_release', { entityType: 'conversation', entityId: conv.id, dueAt: until, dedupeKey: `human-release:${conv.id}` });
}

function handleWebsiteForm(f) {
  const waId = normPhone(f.whatsapp || f.whatsapp_number || f.mobile || f.mobile_number);
  if (!waId || waId.length < 11) throw new Error('Website form without a valid phone number');
  const c = ensureContact(waId, { name: f.name || f.full_name });
  run('UPDATE contacts SET consent_at=COALESCE(consent_at, ?), name=COALESCE(name, ?) WHERE id=?', f.consent === false ? null : nowIso(), f.name || f.full_name || null, c.id);
  const zones = zonesWithKw();
  const svcText = Array.isArray(f.services) ? f.services.join(', ') : String(f.services || '');
  const fields = {
    name: f.name || f.full_name || null,
    services: extractServices(svcText),
    project_nature: extractNature(String(f.project_nature || '')),
    execution_window: extractWindow(String(f.execution_window || '')),
    requirements: f.requirements || f.notes || null,
    consent: f.consent !== false,
  };
  const z = extractZone(String(f.locality || ''), zones);
  if (z) { fields.zone = z.zone; fields.locality = z.locality; } else if (f.locality) { fields.zone = looksOutsideJaipur(f.locality) ? 'outside' : 'other_jaipur'; fields.locality = String(f.locality).slice(0, 120); }
  const ar = parseArea(String(f.area || f.area_sqft || ''));
  if (ar) { fields.area_sqft = ar.sqft; fields.area_text = ar.text; }
  const ref = /^NS-JPR-\d{4}-\d{3,6}$/.test(String(f.reference_id || '')) && !one('SELECT 1 FROM leads WHERE ref=?', f.reference_id) ? f.reference_id : undefined;
  const lead = createLead({ contactId: c.id, source: 'website', fields, ref, actor: 'website' });
  setFlow(c.id, 'lead', null, { leadId: lead.id, fromWebsite: true });
  const lang = c.language || 'en';
  enqueueWhatsApp({
    to: c.wa_id, kind: 'lead.website_ack', sender: 'bot', essential: true,
    message: { type: 'buttons', text: t('website_ack', lang, { name: firstName(getContact(c.id)), ref: lead.ref }), buttons: [{ id: `WEB:${lead.id}`, title: t('btn_continue', lang) }] },
    template: { name: 'ns_website_enquiry', params: [(f.name || 'there').split(' ')[0], lead.ref], buttons: [{ type: 'quick_reply', payload: `WEB:${lead.id}` }] },
  });
  notify({ audience: 'managers', title: `🌐 Website enquiry ${lead.ref}`, body: `${fields.name || ''} · ${servicesText(lead.services)} · ${f.locality || ''}`, link: `#/leads/${lead.id}` });
  createTask({ title: `Website enquiry ${lead.ref}: check WhatsApp reply`, description: 'If the client does not tap Continue within 2 hours, call them.', kind: 'follow_up', entityType: 'lead', entityId: lead.id, dueAt: addMinIso(nowIso(), 120), dedupeKey: `web-lead:${lead.id}` });
}

/** Routine: nudge clients who stopped mid-enquiry; close stale ones. */
registerGuard('lead_nudge', (guard) => {
  const lead = getLead(guard.leadId);
  const contact = lead && getContact(lead.contact_id);
  const conv = contact && getConversation(contact.id);
  return !!contact && lead.status === 'capturing' && conv?.mode !== 'human' &&
    (contact.last_inbound_at || lead.created_at) === guard.lastInboundAt;
});

export function nudgeStaleLeads() {
  let nudged = 0; let closed = 0;
  const nudgeH = setting('lead_nudge_after_h'); const staleH = setting('lead_stale_after_h');
  for (const lead of all("SELECT * FROM leads WHERE status='capturing'")) {
    const c = getContact(lead.contact_id); if (!c) continue;
    const conv = getConversation(c.id);
    // A human owns follow-up and closure until the conversation is released.
    if (conv?.mode === 'human') continue;
    const lastIn = c.last_inbound_at || lead.created_at;
    const age = minutesBetween(lastIn, nowIso()) / 60;
    if (age >= staleH) { markLost(lead.id, 'No response (stale)', 'system'); run("UPDATE leads SET status='stale' WHERE id=?", lead.id); if (conv?.flow === 'lead') setFlow(c.id, null); closed++; continue; }
    if (age >= nudgeH && (conv?.nudges || 0) < 1) {
      const lang = c.language || 'en';
      enqueueWhatsApp({ to: c.wa_id, kind: 'lead.nudge', sender: 'bot', guard: { type: 'lead_nudge', leadId: lead.id, lastInboundAt: lastIn }, dedupeKey: `nudge:${lead.id}`, message: { type: 'buttons', text: t('nudge_lead', lang, { name: firstName(c) }), buttons: [{ id: `NU:Y:${lead.id}`, title: t('btn_continue', lang) }, { id: `NU:N:${lead.id}`, title: t('btn_not_now', lang) }] }, template: { name: 'ns_followup_enquiry', params: [(c.name || c.profile_name || 'there').split(' ')[0], lead.ref], buttons: [{ type: 'quick_reply', payload: `NU:Y:${lead.id}` }, { type: 'quick_reply', payload: `NU:N:${lead.id}` }] } });
      run('UPDATE conversations SET nudges=nudges+1 WHERE contact_id=?', c.id);
      nudged++;
    }
  }
  return { nudged, closed };
}
