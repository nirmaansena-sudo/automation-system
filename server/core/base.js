// Settings, audit log, reference numbers, in-app notifications, system state.
import { all, one, run, insert, onCommit } from '../db/index.js';
import { now, nowIso, istParts, jparse, istTime, hmToMin } from '../lib/util.js';
import { broadcast } from '../lib/http.js';

export const DEFAULT_SETTINGS = {
  business_name: 'Nirmaan Sena',
  business_hours: { open: '08:00', close: '18:00', days: [0, 1, 2, 3, 4, 5, 6] },
  office: { name: 'Head office, Govind Nagar Vistar, Jhotwara', lat: 26.9497, lng: 75.738, radius_m: 200 },
  visit_slots: ['10:00', '12:00', '15:00', '17:00'],
  visit_duration_min: 60,
  visit_buffer_min: 45,
  slot_days_ahead: 3,
  min_lead_time_min: 180,
  offer_timeout_min: 30,
  client_confirm_timeout_min: 240,
  max_offer_attempts: 3,
  auto_approve_leads: false,
  approval_sla_min: 30,
  human_sla_min: 15,
  human_release_min: 120,
  bot_max_per_hour: 40,
  bot_unknown_before_handoff: 2,
  ai_confidence_threshold: 0.75,
  human_auto_resume: false,
  lead_nudge_after_h: 24,
  lead_stale_after_h: 72,
  report_due_h: 6,
  quote_validity_days: 15,
  payment_terms_days: 7,
  gst_pct: 18,
  warranty_years: 10,
  digest_time: '19:00',
  services_requiring_visit: ['turnkey', 'architecture', 'interiors', 'renovation', 'pmc', 'specialized', 'labour'],
  emergency_user_id: null,
  owner_whatsapp_alerts: false,
  payment_instructions: 'Bank transfer / UPI details will be shared by our accounts team.',
  attendance: { accuracy_limit_m: 150, skew_limit_min: 10, offline_max_h: 48, half_day_min: 240, morning_check_after_min: 30 },
  sim_fail_rate: 0,
  dispatch: { enabled: true, center_lat: 26.9124, center_lng: 75.7873, radius_km: 25, resolution: 7, workload_km: 1.5, territory_bonus_km: 1, max_distance_km: 80, road_factor: 1.3, speed_kmh: 25 },
  travel: { rate_per_km: null, base_amount: 0, minimum_amount: 0, maximum_amount: null, round_trip: false, rounding_rupees: 1, require_manager_approval: true },
  default_payment_schedules: {
    turnkey: [
      { name: 'Booking advance', pct: 10, site: false }, { name: 'Foundation & plinth (DPC)', pct: 15 },
      { name: 'Ground floor slab', pct: 20 }, { name: 'Brickwork & lintel', pct: 15 },
      { name: 'Roof slab', pct: 15 }, { name: 'Plaster, flooring & finishes', pct: 15 }, { name: 'Handover', pct: 10 },
    ],
    with_material: [
      { name: 'Booking advance', pct: 20, site: false }, { name: 'Work stage 1', pct: 30 }, { name: 'Work stage 2', pct: 30 }, { name: 'Completion & handover', pct: 20 },
    ],
    labour_only: [
      { name: 'Mobilisation advance', pct: 10, site: false }, { name: 'Stage 1', pct: 30 }, { name: 'Stage 2', pct: 30 }, { name: 'Completion', pct: 30 },
    ],
    design_only: [
      { name: 'Design advance', pct: 40, site: false }, { name: 'Concept & 3D approval', pct: 30, site: false }, { name: 'Final drawings', pct: 30, site: false },
    ],
    pmc: [
      { name: 'Engagement advance', pct: 30, site: false }, { name: 'Mid-project audits', pct: 40 }, { name: 'Final audit report', pct: 30 },
    ],
  },
};

let cache = null;
export function getSettings() {
  if (!cache) {
    cache = { ...DEFAULT_SETTINGS };
    for (const r of all('SELECT key, value FROM settings')) cache[r.key] = jparse(r.value, r.value);
  }
  return cache;
}
export function setting(key) { return getSettings()[key]; }
export function saveSettings(patch, actor) {
  for (const [k, v] of Object.entries(patch)) {
    if (!Object.hasOwn(DEFAULT_SETTINGS, k)) continue;
    run('INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at', k, JSON.stringify(v), nowIso());
  }
  cache = null;
  audit(actor, 'settings.update', 'settings', null, patch);
  onCommit(() => broadcast('settings'));
}
export function resetSettingsCache() { cache = null; }

export function isBusinessHours(d = now()) {
  const bh = setting('business_hours');
  const p = istParts(d);
  if (!bh.days.includes(p.dow)) return false;
  const m = p.hh * 60 + p.mm;
  return m >= hmToMin(bh.open) && m < hmToMin(bh.close);
}
export function businessHoursText() { const bh = setting('business_hours'); return { open: fmt12(bh.open), close: fmt12(bh.close) }; }
function fmt12(hm) { const [h, m] = hm.split(':').map(Number); const ap = h >= 12 ? 'PM' : 'AM'; const h12 = ((h + 11) % 12) + 1; return m ? `${h12}:${String(m).padStart(2, '0')} ${ap}` : `${h12} ${ap}`; }

export function audit(actor, action, entityType, entityId, data) {
  insert('audit_log', { at: nowIso(), actor: actor || 'system', action, entity_type: entityType || null, entity_id: entityId ?? null, data: data === undefined ? null : JSON.stringify(data) });
}

/** NS-JPR-2026-0001 style references (website uses NS-JPR-YYYY-XXXX for enquiries). */
export function nextRef(prefix, width = 4) {
  const year = istParts().y;
  const name = `${prefix}-${year}`;
  run('INSERT INTO counters(name, value) VALUES (?, 0) ON CONFLICT(name) DO NOTHING', name);
  run('UPDATE counters SET value = value + 1 WHERE name = ?', name);
  const v = one('SELECT value FROM counters WHERE name = ?', name).value;
  return `${prefix}-${year}-${String(v).padStart(width, '0')}`;
}

/** In-app notifications. audience: 'managers' | 'owner' | 'finance' | role name; or userId. */
export function notify({ userId, audience, title, body, link, level = 'info' }) {
  let users = [];
  if (userId) users = [userId];
  else if (audience === 'managers') users = all("SELECT id FROM users WHERE active=1 AND role IN ('owner','manager')").map((r) => r.id);
  else if (audience === 'owner') users = all("SELECT id FROM users WHERE active=1 AND role='owner'").map((r) => r.id);
  else if (audience) users = all('SELECT id FROM users WHERE active=1 AND role = ?', audience).map((r) => r.id);
  const at = nowIso();
  for (const u of users) insert('notifications', { user_id: u, audience: audience || null, title, body: body || null, link: link || null, level, created_at: at });
  onCommit(() => broadcast('notifications'));
  return users.length;
}

export function setState(key, value) {
  run('INSERT INTO system_state(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at', key, typeof value === 'string' ? value : JSON.stringify(value), nowIso());
}
export function getState(key) { const r = one('SELECT value, updated_at FROM system_state WHERE key = ?', key); return r ? { value: jparse(r.value, r.value), updated_at: r.updated_at } : null; }

/** Create a task unless one with the same dedupe key exists. */
export function createTask({ title, description, assigneeId, kind = 'general', priority = 'normal', entityType, entityId, dueAt, createdBy = 'system', dedupeKey }) {
  if (dedupeKey) {
    const ex = one('SELECT id FROM tasks WHERE dedupe_key = ?', dedupeKey);
    if (ex) return ex.id;
  }
  if (!assigneeId) {
    const mgr = one("SELECT id FROM users WHERE active=1 AND role='manager' ORDER BY id LIMIT 1") || one("SELECT id FROM users WHERE active=1 AND role='owner' ORDER BY id LIMIT 1");
    assigneeId = mgr ? mgr.id : null;
  }
  const at = nowIso();
  const id = insert('tasks', { title, description: description || null, assignee_id: assigneeId, kind, priority, entity_type: entityType || null, entity_id: entityId ?? null, due_at: dueAt || null, created_by: createdBy, dedupe_key: dedupeKey || null, status: 'todo', created_at: at, updated_at: at });
  if (assigneeId) notify({ userId: assigneeId, title: `New task: ${title}`, body: description, link: `#/tasks?id=${id}`, level: priority === 'high' ? 'warn' : 'info' });
  onCommit(() => broadcast('tasks'));
  return id;
}

export function currentIstMinute() { return istTime(); }
