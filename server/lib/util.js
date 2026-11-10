// Small shared helpers: time (IST), phone numbers, geo, crypto, JSON.
import crypto from 'node:crypto';

export const IST_OFFSET_MIN = 330; // India has no daylight saving time
const MIN = 60_000;

let clockOffsetMs = 0; // tests can move time forward
export function now() { return new Date(Date.now() + clockOffsetMs); }
export function nowIso() { return now().toISOString(); }
export function advanceClock(ms) { clockOffsetMs += ms; }
export function resetClock() { clockOffsetMs = 0; }

export function iso(d) { return (d instanceof Date ? d : new Date(d)).toISOString(); }
export function addMin(d, minutes) { return new Date((d instanceof Date ? d : new Date(d)).getTime() + minutes * MIN); }
export function addMinIso(d, minutes) { return addMin(d, minutes).toISOString(); }
export function minutesBetween(a, b) { return (new Date(b).getTime() - new Date(a).getTime()) / MIN; }

/** Parts of a date as seen in India. */
export function istParts(d = now()) {
  const t = new Date((d instanceof Date ? d : new Date(d)).getTime() + IST_OFFSET_MIN * MIN);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), hh: t.getUTCHours(), mm: t.getUTCMinutes(), dow: t.getUTCDay() };
}
const pad = (n) => String(n).padStart(2, '0');
/** 'YYYY-MM-DD' in IST. */
export function istDate(d = now()) { const p = istParts(d); return `${p.y}-${pad(p.m)}-${pad(p.d)}`; }
/** 'HH:MM' in IST. */
export function istTime(d = now()) { const p = istParts(d); return `${pad(p.hh)}:${pad(p.mm)}`; }
/** Convert an IST local date + 'HH:MM' into a UTC Date. */
export function fromIst(dateStr, timeStr = '00:00') {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = timeStr.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh, mm) - IST_OFFSET_MIN * MIN);
}
export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}
export function dayOfWeek(dateStr) { const [y, m, d] = dateStr.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }
export function daysInclusive(from, to) {
  const out = []; let cur = from; let guard = 0;
  while (cur <= to && guard++ < 400) { out.push(cur); cur = addDays(cur, 1); }
  return out;
}
export function hmToMin(hm) { const [h, m] = String(hm || '0:0').split(':').map(Number); return h * 60 + (m || 0); }

const fmtCache = new Map();
function fmt(locale, opts) {
  const key = locale + JSON.stringify(opts);
  if (!fmtCache.has(key)) fmtCache.set(key, new Intl.DateTimeFormat(locale, { timeZone: 'Asia/Kolkata', ...opts }));
  return fmtCache.get(key);
}
/** "Sat, 8 Nov, 11:00 am" (en) or Hindi equivalent. */
export function fmtSlot(d, lang = 'en') {
  const loc = lang === 'hi' ? 'hi-IN' : 'en-IN';
  return fmt(loc, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(d));
}
export function fmtDay(d, lang = 'en') {
  const loc = lang === 'hi' ? 'hi-IN' : 'en-IN';
  return fmt(loc, { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(d));
}
export function fmtTime(d, lang = 'en') {
  const loc = lang === 'hi' ? 'hi-IN' : 'en-IN';
  return fmt(loc, { hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(d));
}
export function fmtDateLong(d) { return fmt('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(d)); }
export function inr(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
  return '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

/** Normalise Indian / international numbers to WhatsApp format (digits, country code, no +). */
export function normPhone(input) {
  if (input === null || input === undefined) return '';
  let s = String(input).replace(/[^\d]/g, '');
  if (s.startsWith('00')) s = s.slice(2);
  if (s.length === 11 && s.startsWith('0')) s = '91' + s.slice(1);
  if (s.length === 10) s = '91' + s;
  return s;
}
export function prettyPhone(waId) {
  const s = String(waId || '');
  if (s.length === 12 && s.startsWith('91')) return `+91 ${s.slice(2, 7)} ${s.slice(7)}`;
  return s ? '+' + s : '';
}

/** Distance in metres between two lat/lng points. */
export function haversineM(lat1, lng1, lat2, lng2) {
  if ([lat1, lng1, lat2, lng2].some((v) => v === null || v === undefined || Number.isNaN(Number(v)))) return null;
  const R = 6371000; const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1); const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}
export function mapsLink(lat, lng, address) {
  if (lat !== null && lat !== undefined && lng !== null && lng !== undefined) return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
  if (address) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address + ', Jaipur')}`;
  return '';
}

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');
export function hmacHex(secret, data) { return crypto.createHmac('sha256', secret).update(data).digest('hex'); }
export function safeEqual(a, b) {
  const ba = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/** Signed, expiring token for links (e.g. architect visit details page). */
export function signToken(secret, payload, ttlMin) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlMin * MIN })).toString('base64url');
  return `${body}.${hmacHex(secret, body).slice(0, 32)}`;
}
export function verifyToken(secret, token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  if (!safeEqual(sig, hmacHex(secret, body).slice(0, 32))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!p.exp || p.exp < Date.now()) return null;
    return p;
  } catch { return null; }
}

/** scrypt password / PIN hashing (built into Node). */
export function hashSecret(plain) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(plain), salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}
export function checkSecret(plain, stored) {
  if (!stored || !String(stored).startsWith('scrypt$')) return false;
  const [, saltB64, keyB64] = String(stored).split('$');
  const key = crypto.scryptSync(String(plain), Buffer.from(saltB64, 'base64'), 32, { N: 16384, r: 8, p: 1 });
  const expected = Buffer.from(keyB64, 'base64');
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

export function jparse(v, fallback = null) {
  if (v === null || v === undefined || v === '') return fallback;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return fallback; }
}
export function truncate(s, n) { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
export function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export function titleCase(s) { return String(s || '').replace(/\b\w/g, (c) => c.toUpperCase()); }
export function pick(obj, keys) { const o = {}; for (const k of keys) if (obj[k] !== undefined) o[k] = obj[k]; return o; }
export function isDevanagari(s) { return /[ऀ-ॿ]/.test(String(s || '')); }
