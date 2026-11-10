import { bad } from './http.js';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const time = (value) => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
const numeric = (value, min, max, integer = false) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isInteger(value));
const text = (value, min, max) => typeof value === 'string' && value.trim().length >= min && value.length <= max;
const ranges = {
  visit_duration_min: [5, 1440], visit_buffer_min: [0, 1440], slot_days_ahead: [1, 90], min_lead_time_min: [0, 43200],
  offer_timeout_min: [1, 10080], client_confirm_timeout_min: [1, 43200], max_offer_attempts: [1, 100],
  approval_sla_min: [1, 43200], human_sla_min: [1, 43200], human_release_min: [1, 43200], bot_max_per_hour: [1, 100],
  bot_unknown_before_handoff: [1, 5],
  lead_nudge_after_h: [1, 8760], lead_stale_after_h: [1, 8760], report_due_h: [1, 8760], quote_validity_days: [1, 3650],
  payment_terms_days: [0, 3650], warranty_years: [0, 100],
};
const attendanceRanges = { accuracy_limit_m: [1, 10000], skew_limit_min: [0, 1440], offline_max_h: [1, 720], half_day_min: [1, 1440], morning_check_after_min: [0, 1440] };
export function validateSettings(patch) {
  if (!object(patch)) throw bad('Settings must be an object');
  for (const [key, value] of Object.entries(patch)) {
    if (Object.hasOwn(Object.prototype, key) || key === '__proto__') throw bad('Invalid settings key');
    if (key in ranges && !numeric(value, ...ranges[key], true)) throw bad(`Invalid ${key}`);
    if (['auto_approve_leads', 'owner_whatsapp_alerts', 'human_auto_resume'].includes(key) && typeof value !== 'boolean') throw bad(`${key} must be true or false`);
    if (key === 'ai_confidence_threshold' && !numeric(value, 0.5, 1)) throw bad('AI confidence threshold must be between 0.5 and 1');
    if (key === 'gst_pct' && !numeric(value, 0, 100)) throw bad('GST must be 0–100%');
    if (key === 'sim_fail_rate' && !numeric(value, 0, 0.5)) throw bad('Simulator failure rate must be 0–0.5');
    if (key === 'business_name' && !text(value, 1, 200)) throw bad('Enter a business name of 1–200 characters');
    if (key === 'payment_instructions' && !text(value, 0, 4000)) throw bad('Payment instructions must be text of at most 4,000 characters');
    if (key === 'digest_time' && !time(value)) throw bad('Digest time must use HH:MM');
    if (key === 'emergency_user_id' && value !== null && !numeric(value, 1, Number.MAX_SAFE_INTEGER, true)) throw bad('Invalid emergency user');
    if (key === 'visit_slots' && (!Array.isArray(value) || !value.length || value.length > 48 || value.some((x) => !time(x)) || new Set(value).size !== value.length)) throw bad('Visit slots must be distinct HH:MM times');
    if (key === 'services_requiring_visit' && (!Array.isArray(value) || value.length > 50 || value.some((x) => !text(x, 1, 100)))) throw bad('Services requiring a visit must be a list of service codes');
    if (key === 'business_hours' && (!object(value) || !time(value.open) || !time(value.close) || value.open >= value.close || !Array.isArray(value.days) || !value.days.length || value.days.some((x) => !numeric(x, 0, 6, true)))) throw bad('Business hours need opening/closing times and valid weekdays');
    if (key === 'office' && (!object(value) || !text(value.name, 1, 300) || !numeric(value.lat, -90, 90) || !numeric(value.lng, -180, 180) || !numeric(value.radius_m, 1, 10000))) throw bad('Office needs a name, valid coordinates and a radius from 1 to 10,000 metres');
    if (key === 'attendance' && (!object(value) || Object.entries(attendanceRanges).some(([k, bounds]) => !numeric(value[k], ...bounds, true)))) throw bad('Attendance settings are incomplete or outside permitted ranges');
    if (key === 'default_payment_schedules') {
      if (!object(value) || !Object.keys(value).length || Object.keys(value).length > 50) throw bad('Provide payment schedules keyed by service');
      for (const [service, stages] of Object.entries(value)) {
        if (!text(service, 1, 100) || !Array.isArray(stages) || !stages.length || stages.length > 50 || stages.some((s) => !object(s) || !text(s.name, 1, 200) || !numeric(s.pct, 0, 100) || (s.site !== undefined && typeof s.site !== 'boolean')) || Math.abs(stages.reduce((sum, s) => sum + s.pct, 0) - 100) > 0.001) throw bad(`Payment schedule ${service} must have named stages totalling 100%`);
      }
    }
  }
  return patch;
}
