// Shared domain helpers: contacts, staff lookups, messaging shortcuts, labels.
import { all, one, run, insert } from '../db/index.js';
import { nowIso, jparse, prettyPhone, fmtSlot, inr, mapsLink, signToken } from '../lib/util.js';
import { enqueueWhatsApp } from '../core/outbox.js';
import { t } from '../bot/i18n.js';
import { serviceLabel, natureLabel, windowLabel } from '../bot/catalog.js';
import { config } from '../config.js';

export function getContactByWa(waId) { return one('SELECT * FROM contacts WHERE wa_id = ?', waId); }
export function getContact(id) { return one('SELECT * FROM contacts WHERE id = ?', id); }
export function getUser(id) { return id ? one('SELECT * FROM users WHERE id = ?', id) : null; }
export function userByPhone(waId) { return one('SELECT * FROM users WHERE phone = ? AND active = 1', waId); }

export function ensureContact(waId, { name, profileName, kind, userId } = {}) {
  let c = getContactByWa(waId);
  const at = nowIso();
  if (!c) {
    const staff = userId ? getUser(userId) : userByPhone(waId);
    const id = insert('contacts', {
      wa_id: waId, name: name || (staff ? staff.name : null), profile_name: profileName || null,
      kind: staff ? 'staff' : (kind || 'client'), user_id: staff ? staff.id : null, created_at: at, updated_at: at,
    });
    c = getContact(id);
  } else {
    const patch = {};
    if (profileName && profileName !== c.profile_name) patch.profile_name = profileName;
    if (!c.user_id) { const staff = userByPhone(waId); if (staff) { patch.user_id = staff.id; patch.kind = 'staff'; if (!c.name) patch.name = staff.name; } }
    if (name && !c.name) patch.name = name;
    if (Object.keys(patch).length) {
      const keys = Object.keys(patch);
      run(`UPDATE contacts SET ${keys.map((k) => `${k}=?`).join(', ')}, updated_at=? WHERE id=?`, ...keys.map((k) => patch[k]), at, c.id);
      c = getContact(c.id);
    }
  }
  if (!one('SELECT id FROM conversations WHERE contact_id = ?', c.id)) insert('conversations', { contact_id: c.id, updated_at: at });
  return c;
}
export function getConversation(contactId) { return one('SELECT * FROM conversations WHERE contact_id = ?', contactId); }
export function setFlow(contactId, flow, step = null, ctx = {}) {
  run('UPDATE conversations SET flow=?, step=?, ctx=?, awaiting_since=?, nudges=0, updated_at=? WHERE contact_id=?', flow, step, JSON.stringify(ctx), flow ? nowIso() : null, nowIso(), contactId);
}
export function displayName(c) { return (c && (c.name || c.profile_name)) || (c ? prettyPhone(c.wa_id) : ''); }
export function firstName(c) { const n = c && (c.name || c.profile_name); return n ? ' ' + String(n).split(' ')[0] : ''; }

/** Projects a contact may see: they are the client, or their number is authorised on it. */
export function contactProjects(contact) {
  if (!contact) return [];
  return all(`SELECT * FROM projects WHERE status NOT IN ('closed','cancelled') AND (client_contact_id = ? OR client_phone = ? OR EXISTS (SELECT 1 FROM json_each(projects.authorized_phones) WHERE value = ?)) ORDER BY id DESC`, contact.id, contact.wa_id, contact.wa_id);
}

/** Send helpers. `to` is a contact row or wa_id. */
function resolve(to) { const c = typeof to === 'string' ? getContactByWa(to) : to; return { c, waId: c ? c.wa_id : to, lang: (c && c.language) || 'en' }; }
export function sendText(to, key, vars = {}, opts = {}) {
  const { waId, lang } = resolve(to);
  return enqueueWhatsApp({ to: waId, kind: opts.kind || key, message: { type: 'text', text: t(key, lang, vars) }, ...opts });
}
export function sendRawText(to, text, opts = {}) {
  const { waId } = resolve(to);
  return enqueueWhatsApp({ to: waId, kind: opts.kind || 'text', message: { type: 'text', text }, ...opts });
}
export function sendButtons(to, key, vars, buttons, opts = {}) {
  const { waId, lang } = resolve(to);
  return enqueueWhatsApp({
    to: waId, kind: opts.kind || key,
    message: { type: 'buttons', text: opts.text || t(key, lang, vars), header: opts.header, footer: opts.footer, buttons: buttons.map((b) => ({ id: b.id, title: b.title || t(b.key, lang) })) },
    ...opts,
  });
}
export function langOf(to) { return resolve(to).lang; }

export function servicesText(services, lang = 'en') { return (jparse(services, []) || []).map((s) => serviceLabel(s, lang)).join(', ') || '—'; }
export function leadPlace(lead, lang = 'en') {
  const z = lead.zone ? one('SELECT * FROM zones WHERE code = ?', lead.zone) : null;
  const zn = z ? (lang === 'hi' && z.name_hi ? z.name_hi : z.name) : '';
  if (lead.locality && zn && zn.toLowerCase().includes(String(lead.locality).toLowerCase())) return zn;
  return [lead.locality, zn].filter(Boolean).join(', ') || (lang === 'hi' ? 'जयपुर' : 'Jaipur');
}
/** Address parts without repeats ("Plot 4, Vaishali Nagar" + "Vaishali Nagar" → once). */
export function fullAddress(lead, lang = 'en') {
  const parts = [];
  for (const p of [lead.address, leadPlace(lead, lang)]) {
    for (const piece of String(p || '').split(',').map((x) => x.trim()).filter(Boolean)) {
      if (!parts.some((q) => q.toLowerCase() === piece.toLowerCase())) parts.push(piece);
    }
  }
  return parts.join(', ');
}
export function areaText(lead, lang = 'en') {
  if (lead.area_sqft) return `${Number(lead.area_sqft).toLocaleString('en-IN')} sq ft${lead.area_text && !/sq ft$/.test(lead.area_text) ? ` (${lead.area_text})` : ''}`;
  if (lead.area_text) return lead.area_text === 'not sure' ? t('not_sure', lang) : lead.area_text;
  return t('not_given', lang);
}
export const natureText = (lead, lang = 'en') => (lead.project_nature ? natureLabel(lead.project_nature, lang) : '—');
export const windowText = (lead, lang = 'en') => (lead.execution_window ? windowLabel(lead.execution_window, lang) : '—');
export { fmtSlot, inr, mapsLink, prettyPhone };

export function appLink(path = '') { return `${config.publicUrl}/app/${path}`; }
export function visitLink(visitId) { return `${config.publicUrl}/v/${signToken(config.sessionSecret, { v: visitId }, 60 * 24 * 14)}`; }
export function projectLink(project) { return `${config.publicUrl}/p/${project.public_token}`; }
export function quoteLink(q) { return `${config.publicUrl}/q/${q.public_token}`; }
