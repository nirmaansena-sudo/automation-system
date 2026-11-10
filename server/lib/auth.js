// Sessions for the dashboard (cookie) and the employee app (cookie or Bearer).
import { one, run, insert } from '../db/index.js';
import { randomToken, sha256, checkSecret, normPhone, hashSecret } from './util.js';

// Sessions use real wall-clock time (not the simulator's fast-forward clock).
const realNow = () => new Date().toISOString();
const realPlus = (min) => new Date(Date.now() + min * 60000).toISOString();
import { HttpError, forbidden } from './http.js';
import { config } from '../config.js';
import { verifyMfa } from './mfa.js';

export const DASHBOARD_ROLES = ['owner', 'manager', 'finance'];
const TTL = { dashboard: 12 * 60, app: 30 * 24 * 60 };
const attempts = new Map();

function throttle(key) {
  const now = Date.now();
  const a = attempts.get(key) || { n: 0, until: 0, first: now };
  if (a.until > now) throw new HttpError(429, 'Too many attempts. Please wait a few minutes.');
  if (now - a.first >= 5 * 60e3) { attempts.delete(key); return { n: 0, until: 0, first: now }; }
  return a;
}
function failed(key, limit = 6) {
  const now = Date.now();
  const a = throttle(key);
  a.n += 1;
  if (a.n >= limit) { a.until = now + 5 * 60e3; }
  if (attempts.size > 10000) for (const [k, v] of attempts) if (v.until <= now && now - v.first >= 5 * 60e3) attempts.delete(k);
  attempts.set(key, a);
}

// Unknown accounts are checked against a throwaway hash, so a login for a phone or
// email that does not exist takes as long as a wrong password for one that does.
let dummyHash = null;
const dummy = () => (dummyHash ||= hashSecret(randomToken(16)));

function credentials(ctx, kind, identifier, verify, user, mfaCode) {
  const accountKey = `${kind}:account:${user ? `id:${user.id}` : identifier}`;
  const ipKey = `${kind}:ip:${ctx.ip}`;
  throttle(accountKey); throttle(ipKey);
  try {
    const ok = verify(); // always runs the full password hash, even for unknown accounts
    if (!user || !ok) throw new HttpError(401, kind === 'app' ? 'Wrong phone number or PIN' : 'Wrong email/phone or password');
    verifyMfa(user.id, mfaCode);
  } catch (e) {
    // Requesting the second factor is not a failed code attempt.
    if (!(e.extra?.mfa_required && !mfaCode)) { failed(accountKey); failed(ipKey, 30); }
    throw e;
  }
  attempts.delete(accountKey);
}

export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) throw new HttpError(400, 'Password must be 8–128 characters');
}

export function reauthenticate(ctx, body = {}, { allowPin = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Provide your current credentials');
  const user = ctx.user;
  const pinAllowed = allowPin && !DASHBOARD_ROLES.includes(user.role);
  const secret = pinAllowed ? body.current_pin : body.current_password;
  if (typeof secret !== 'string' || secret.length > 128) throw new HttpError(400, pinAllowed ? 'Enter your current PIN' : 'Enter your current password');
  credentials(ctx, 'reauth', String(user.id), () => checkSecret(secret, pinAllowed ? user.pin_hash : user.password_hash), user, body.mfa_code);
}

export function revokeSessions(userId, ctx) {
  run('DELETE FROM sessions WHERE user_id=?', userId);
  ctx?.setHeader('Set-Cookie', ['ns_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0', 'ns_app=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0']);
}

export function createSession(userId, kind, ctx) {
  const token = randomToken(32);
  insert('sessions', { user_id: userId, token_hash: sha256(token), kind, expires_at: realPlus(TTL[kind]), created_at: realNow(), last_seen_at: realNow(), ip: ctx?.ip || null, ua: String(ctx?.req?.headers['user-agent'] || '').slice(0, 200) });
  const cookieName = kind === 'app' ? 'ns_app' : 'ns_session';
  const secure = config.cookieSecure ? '; Secure' : '';
  ctx?.setHeader?.('Set-Cookie', `${cookieName}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${TTL[kind] * 60}${secure}`);
  return token;
}

export function loginDashboard(ctx, login, password, mfaCode) {
  if (typeof login !== 'string' || login.length > 254 || typeof password !== 'string' || password.length > 128) throw new HttpError(400, 'Invalid login details');
  const l = login.trim().toLowerCase();
  const u = one('SELECT * FROM users WHERE active=1 AND (email=? OR phone=?)', l, normPhone(l) || '-');
  credentials(ctx, 'dashboard', l, () => checkSecret(password, u?.password_hash || dummy()), u, mfaCode);
  if (!DASHBOARD_ROLES.includes(u.role)) throw forbidden('This account uses the employee app. Open /app/ on your phone.');
  createSession(u.id, 'dashboard', ctx);
  return u;
}

export function loginApp(ctx, phone, pin, mfaCode) {
  if (typeof phone !== 'string' || phone.length > 32 || typeof pin !== 'string' || pin.length > 128) throw new HttpError(400, 'Invalid login details');
  const p = normPhone(phone);
  const u = one('SELECT * FROM users WHERE active=1 AND phone=?', p);
  credentials(ctx, 'app', p || '', () => checkSecret(pin, u?.pin_hash || dummy()), u, mfaCode);
  const token = createSession(u.id, 'app', ctx);
  return { user: u, token };
}

export function logout(ctx) {
  for (const name of ['ns_session', 'ns_app']) {
    const tok = ctx.cookies[name];
    if (tok) run('DELETE FROM sessions WHERE token_hash=?', sha256(tok));
  }
  const bearer = /^Bearer (.+)$/.exec(ctx.req.headers.authorization || '');
  if (bearer) run('DELETE FROM sessions WHERE token_hash=?', sha256(bearer[1]));
  ctx.setHeader('Set-Cookie', ['ns_session=; Path=/; Max-Age=0', 'ns_app=; Path=/; Max-Age=0']);
}

/** Resolve the user for a request. kind: 'dashboard' | 'app' | 'any' */
export function sessionUser(ctx, kind = 'any') {
  const tokens = [];
  if (kind !== 'app' && ctx.cookies.ns_session) tokens.push(ctx.cookies.ns_session);
  if (kind !== 'dashboard' && ctx.cookies.ns_app) tokens.push(ctx.cookies.ns_app);
  const bearer = /^Bearer (.+)$/.exec(ctx.req.headers.authorization || '');
  if (bearer && kind !== 'dashboard') tokens.push(bearer[1]);
  for (const tok of tokens) {
    const s = one('SELECT s.*, u.active FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?', sha256(tok));
    if (!s || !s.active || s.expires_at < realNow()) continue;
    if (kind === 'dashboard' && s.kind !== 'dashboard') continue;
    if (kind === 'app' && s.kind !== 'app') continue;
    if (Date.now() - Date.parse(s.last_seen_at || 0) > 5 * 60e3) run('UPDATE sessions SET last_seen_at=?, expires_at=? WHERE id=?', realNow(), realPlus(TTL[s.kind]), s.id);
    ctx.sessionKind = s.kind;
    return one('SELECT * FROM users WHERE id=?', s.user_id);
  }
  return null;
}

export function requireRoles(user, roles) {
  if (!user) throw new HttpError(401, 'Please log in');
  if (roles && roles.length && !roles.includes(user.role)) throw forbidden('Your role cannot do this');
}
