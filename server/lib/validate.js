// Small input checks shared by the API handlers. Each returns the cleaned value
// or throws a 400 with a message a manager can act on.
import { bad } from './http.js';

export const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Optional text: undefined stays undefined (field not sent); '' and null become null. */
export function optText(v, label, max = 500) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (typeof v !== 'string') throw bad(`${label} must be text`);
  return v.trim().slice(0, max) || null;
}
export function reqText(v, label, max = 500) {
  const out = optText(v, label, max);
  if (!out) throw bad(`${label} is required`);
  return out;
}
/** Optional choice from a fixed list ('' and null clear it). */
export function optChoice(v, list, label) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (typeof v !== 'string' || !list.includes(v)) throw bad(`Choose ${label} from the list`);
  return v;
}
/** Optional date-time → ISO string ('' and null clear it). */
export function optDateTime(v, label) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  if (!Number.isFinite(t)) throw bad(`${label} is not a valid date and time`);
  return new Date(t).toISOString();
}
/** 'YYYY-MM-DD' that is a real calendar day. */
export function isDay(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);
}
/** Positive whole number from a route parameter or field, else null. */
export function posInt(v) {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : NaN);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
