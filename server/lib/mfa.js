// RFC 6238 TOTP with encrypted secrets and single-use recovery codes.
import crypto from 'node:crypto';
import { one, run } from '../db/index.js';
import { config } from '../config.js';
import { safeEqual, sha256 } from './util.js';
import { bad, HttpError } from './http.js';

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const pending = new Map();
const key = () => crypto.createHash('sha256').update(`nirmaan-mfa:${config.sessionSecret}`).digest();
function encode(buffer) {
  let value = 0; let bits = 0; let result = '';
  for (const byte of buffer) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { bits -= 5; result += alphabet[(value >>> bits) & 31]; } }
  if (bits) result += alphabet[(value << (5 - bits)) & 31];
  return result;
}
function decode(secret) {
  let value = 0; let bits = 0; const bytes = [];
  for (const char of secret) { const n = alphabet.indexOf(char); if (n < 0) throw new Error('Invalid TOTP secret'); value = (value << 5) | n; bits += 5; if (bits >= 8) { bits -= 8; bytes.push((value >>> bits) & 255); } }
  return Buffer.from(bytes);
}
function encrypt(secret) {
  const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
}
function decrypt(secret) {
  const [iv, tag, data] = secret.split('.').map((s) => Buffer.from(s, 'base64url'));
  const cipher = crypto.createDecipheriv('aes-256-gcm', key(), iv); cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(data), cipher.final()]).toString('utf8');
}
export function totpCode(secret, timestamp = Date.now()) {
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(timestamp / 30000)));
  const digest = crypto.createHmac('sha1', decode(secret)).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}
function matchingCounter(secret, code, lastCounter = -1) {
  if (!/^\d{6}$/.test(code)) return null;
  const counter = Math.floor(Date.now() / 30000);
  for (const offset of [0, -1, 1]) {
    const candidate = counter + offset;
    if (candidate > lastCounter && safeEqual(totpCode(secret, candidate * 30000), code)) return candidate;
  }
  return null;
}
export function mfaStatus(userId) {
  const row = one('SELECT enabled_at, recovery_hashes FROM account_security WHERE user_id=?', userId);
  return { enabled: !!row, enabled_at: row?.enabled_at || null, recovery_codes_remaining: row ? JSON.parse(row.recovery_hashes).length : 0 };
}
export function verifyMfa(userId, supplied) {
  const row = one('SELECT * FROM account_security WHERE user_id=?', userId);
  if (!row) return true;
  const code = String(supplied || '').trim().replace(/[\s-]/g, '').toUpperCase();
  if (!code) throw new HttpError(401, 'Enter your authenticator code or a recovery code', { mfa_required: true });
  const counter = matchingCounter(decrypt(row.secret), code, row.last_counter);
  if (counter !== null) { run('UPDATE account_security SET last_counter=? WHERE user_id=?', counter, userId); return true; }
  const recovery = JSON.parse(row.recovery_hashes); const hash = sha256(code);
  const at = recovery.findIndex((x) => safeEqual(x, hash));
  if (at >= 0) { recovery.splice(at, 1); run('UPDATE account_security SET recovery_hashes=? WHERE user_id=?', JSON.stringify(recovery), userId); return true; }
  throw new HttpError(401, 'Invalid or already used authenticator/recovery code', { mfa_required: true });
}
export function beginMfa(user) {
  if (mfaStatus(user.id).enabled) throw bad('Two-step verification is already enabled');
  for (const [id, entry] of pending) if (entry.expires < Date.now()) pending.delete(id);
  const secret = encode(crypto.randomBytes(20));
  pending.set(user.id, { secret, expires: Date.now() + 10 * 60000 });
  return { secret, expires_in_seconds: 600, uri: `otpauth://totp/${encodeURIComponent(`Nirmaan Sena:${user.email || user.phone || user.id}`)}?secret=${secret}&issuer=Nirmaan%20Sena&algorithm=SHA1&digits=6&period=30` };
}
export function enableMfa(userId, code) {
  const entry = pending.get(userId);
  if (!entry || entry.expires < Date.now()) throw bad('Setup expired. Start again.');
  const counter = matchingCounter(entry.secret, String(code || '').trim());
  if (counter === null) throw bad('The authenticator code did not match');
  const codes = Array.from({ length: 8 }, () => crypto.randomBytes(8).toString('hex').toUpperCase());
  run('INSERT INTO account_security(user_id, secret, last_counter, recovery_hashes, enabled_at) VALUES (?,?,?,?,?)', userId, encrypt(entry.secret), counter, JSON.stringify(codes.map(sha256)), new Date().toISOString());
  pending.delete(userId);
  return { recovery_codes: codes.map((c) => `${c.slice(0, 8)}-${c.slice(8)}`) };
}
export function disableMfa(userId) { run('DELETE FROM account_security WHERE user_id=?', userId); pending.delete(userId); }
