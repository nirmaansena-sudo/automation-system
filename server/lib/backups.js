// Encrypted, streaming backup bundles. No third-party archive dependencies.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';
import { backupTo } from '../db/index.js';

const MAGIC = Buffer.from('NSBACK02');
const CHUNK = 1024 * 1024;
const hash = (b) => crypto.createHash('sha256').update(b).digest('hex');
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
function secret(options = {}, create = false) {
  const password = options.password || config.backupPassword || process.env.BACKUP_PASSWORD;
  if (password) {
    if (String(password).length < 16) throw new Error('BACKUP_PASSWORD must contain at least 16 characters');
    return String(password);
  }
  const keyFile = options.keyFile || path.join(config.dataDir, 'backup.key');
  if (!fs.existsSync(keyFile) && create) fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('base64url'), { mode: 0o600, flag: 'wx' });
  if (!fs.existsSync(keyFile)) throw new Error('Backup key missing. Supply --key-file or BACKUP_PASSWORD from the original installation');
  return fs.readFileSync(keyFile, 'utf8').trim();
}
function chunks(file, fn, start = 0, length = fs.statSync(file).size - start) {
  const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(CHUNK);
  try { for (let done = 0; done < length;) { const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, length - done), start + done); if (!n) throw new Error('Backup file was truncated'); fn(buf.subarray(0, n)); done += n; } }
  finally { fs.closeSync(fd); }
}
function fileHash(file, start, size) { const h = crypto.createHash('sha256'); chunks(file, (b) => h.update(b), start, size); return h.digest('hex'); }
function safeName(name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.includes(':') || name.startsWith('/') || name.split('/').some((p) => !p || p === '.' || p === '..')) throw new Error('Unsafe path in backup manifest');
  if (!['nirmaan.db', 'secrets.json'].includes(name) && !name.startsWith('media/') && !name.startsWith('configuration/')) throw new Error('Unexpected path in backup manifest');
  return name;
}
function mediaFiles(root, rel = '') {
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, e.name); const name = rel ? `${rel}/${e.name}` : e.name;
    if (e.isSymbolicLink()) throw new Error('Media symlinks are not supported in backups');
    if (e.isDirectory()) out.push(...mediaFiles(full, name));
    else if (e.isFile()) out.push({ path: `media/${name}`, source: full });
  }
  return out;
}

/** Called synchronously while the backend cannot mutate the DB/media snapshot. */
export function createFullBackup(options = {}, snapshotDatabase = backupTo) {
  fs.mkdirSync(config.backupDir, { recursive: true, mode: 0o700 });
  const key = secret(options, true);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = `nirmaan-${stamp}-${crypto.randomBytes(3).toString('hex')}.nsbackup`;
  const target = path.join(config.backupDir, name); const partial = `${target}.partial`;
  const snapshot = path.join(config.backupDir, `.snapshot-${crypto.randomUUID()}.db`);
  try {
    snapshotDatabase(snapshot);
    const { backupPassword, ...runtime } = config;
    const entries = [{ path: 'nirmaan.db', source: snapshot }, ...mediaFiles(config.mediaDir), { path: 'configuration/runtime.json', bytes: Buffer.from(JSON.stringify(runtime, null, 2)) }];
    for (const [relative, source] of [['secrets.json', path.join(config.dataDir, 'secrets.json')], ['configuration/.env', path.join(config.root, '.env')]]) if (fs.existsSync(source)) entries.push({ path: relative, source });
    for (const e of entries) { safeName(e.path); e.size = e.bytes ? e.bytes.length : fs.statSync(e.source).size; e.sha256 = e.bytes ? hash(e.bytes) : fileHash(e.source); }
    const manifest = { format: 2, createdAt: new Date().toISOString(), purpose: options.purpose || 'scheduled-or-manual', pendingMigrations: options.pendingMigrations || [], files: entries.map(({ path, size, sha256 }) => ({ path, size, sha256 })) };
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    const salt = crypto.randomBytes(16); const iv = crypto.randomBytes(12);
    const header = Buffer.from(JSON.stringify({ cipher: 'aes-256-gcm', kdf: 'scrypt', salt: salt.toString('hex'), iv: iv.toString('hex') }));
    const cipher = crypto.createCipheriv('aes-256-gcm', crypto.scryptSync(key, salt, 32), iv);
    cipher.setAAD(Buffer.concat([MAGIC, header]));
    const fd = fs.openSync(partial, 'wx', 0o600);
    try {
      fs.writeSync(fd, Buffer.concat([MAGIC, u32(header.length), header]));
      const write = (b) => { const c = cipher.update(b); if (c.length) fs.writeSync(fd, c); };
      write(u32(manifestBytes.length)); write(manifestBytes);
      for (const e of entries) if (e.bytes) write(e.bytes); else chunks(e.source, write);
      fs.writeSync(fd, cipher.final()); fs.writeSync(fd, cipher.getAuthTag()); fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    validateBackup(partial, options);
    fs.renameSync(partial, target);
    // Bound local storage even while an unavailable offsite destination causes
    // scheduled retries. Only verified, completed bundles participate.
    for (const old of listFullBackups().slice(14)) fs.unlinkSync(path.join(config.backupDir, old.file));
    const offsite = options.offsiteDir || config.backupOffsiteDir || process.env.BACKUP_OFFSITE_DIR;
    if (offsite) {
      const destination = path.resolve(offsite);
      if (destination === path.resolve(config.backupDir)) throw new Error('BACKUP_OFFSITE_DIR must differ from the local backup directory');
      fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
      const copy = path.join(destination, name);
      try {
        fs.copyFileSync(target, `${copy}.partial`, fs.constants.COPYFILE_EXCL);
        if (fileHash(target) !== fileHash(`${copy}.partial`)) throw new Error('Offsite backup checksum mismatch');
        fs.renameSync(`${copy}.partial`, copy);
      } finally { if (fs.existsSync(`${copy}.partial`)) fs.unlinkSync(`${copy}.partial`); }
    }
    return { file: name, size: fs.statSync(target).size, files: entries.length, encrypted: true, offsite: !!offsite, keyMode: options.password || config.backupPassword || process.env.BACKUP_PASSWORD ? 'password' : 'key-file' };
  } finally { if (fs.existsSync(snapshot)) fs.unlinkSync(snapshot); if (fs.existsSync(partial)) fs.unlinkSync(partial); }
}

export function listFullBackups() { return fs.readdirSync(config.backupDir).filter((f) => /^nirmaan-.*\.nsbackup$/.test(f)).sort().reverse().map((file) => ({ file, size: fs.statSync(path.join(config.backupDir, file)).size, encrypted: true })); }

/** Snapshot existing data BEFORE openDb() applies any pending schema migration.
 * Uses a separate read-only connection; never initializes or migrates the source.
 * Throws on backup failure so the caller cannot continue an unprotected upgrade.
 */
export function backupBeforeUpgrade(options = {}) {
  if (!fs.existsSync(config.dbFile) || fs.statSync(config.dbFile).size === 0) return null;
  const source = new DatabaseSync(config.dbFile, { readOnly: true });
  try {
    if (!source.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'").get()) return null;
    const tracked = source.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
    const applied = new Set(tracked ? source.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name) : []);
    const pending = fs.readdirSync(path.join(config.root, 'server', 'db')).filter((f) => /^\d+_.*\.sql$/.test(f) && !applied.has(f)).sort();
    if (!pending.length) return null;
    const result = createFullBackup({ ...options, purpose: 'pre-upgrade', pendingMigrations: pending }, (target) => source.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`));
    return { ...result, pendingMigrations: pending };
  } finally { source.close(); }
}

function unpack(file, options, consume) {
  const size = fs.statSync(file).size; if (size < 40) throw new Error('Invalid backup');
  const fd = fs.openSync(file, 'r'); const prefix = Buffer.alloc(12); fs.readSync(fd, prefix, 0, 12, 0);
  if (!prefix.subarray(0, 8).equals(MAGIC)) { fs.closeSync(fd); throw new Error('Unsupported backup format'); }
  const headerSize = prefix.readUInt32BE(8);
  if (headerSize > 4096 || headerSize + 28 >= size) { fs.closeSync(fd); throw new Error('Invalid backup header'); }
  const headerBytes = Buffer.alloc(headerSize); const tag = Buffer.alloc(16);
  fs.readSync(fd, headerBytes, 0, headerSize, 12); fs.readSync(fd, tag, 0, 16, size - 16); fs.closeSync(fd);
  const header = JSON.parse(headerBytes);
  if (header.cipher !== 'aes-256-gcm' || header.kdf !== 'scrypt' || !/^[a-f0-9]{32}$/.test(header.salt) || !/^[a-f0-9]{24}$/.test(header.iv)) throw new Error('Invalid encryption header');
  const temp = path.join(os.tmpdir(), `ns-restore-${crypto.randomUUID()}.tmp`);
  const out = fs.openSync(temp, 'wx', 0o600);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', crypto.scryptSync(secret(options), Buffer.from(header.salt, 'hex'), 32), Buffer.from(header.iv, 'hex'));
    decipher.setAAD(Buffer.concat([MAGIC, headerBytes])); decipher.setAuthTag(tag);
    chunks(file, (b) => fs.writeSync(out, decipher.update(b)), 12 + headerSize, size - 28 - headerSize);
    fs.writeSync(out, decipher.final());
  } catch (e) { fs.closeSync(out); fs.unlinkSync(temp); throw new Error(`Backup authentication failed: ${e.message}`); }
  fs.closeSync(out);
  try {
    const plainSize = fs.statSync(temp).size;
    const d = fs.openSync(temp, 'r'); const msize = Buffer.alloc(4); fs.readSync(d, msize, 0, 4, 0);
    const n = msize.readUInt32BE(); if (n > 16 * 1024 * 1024 || n + 4 > plainSize) { fs.closeSync(d); throw new Error('Invalid manifest size'); }
    const mbytes = Buffer.alloc(n); fs.readSync(d, mbytes, 0, n, 4); fs.closeSync(d);
    const manifest = JSON.parse(mbytes); const seen = new Set(); let offset = n + 4;
    if (manifest.format !== 2 || !Array.isArray(manifest.files)) throw new Error('Invalid manifest');
    for (const e of manifest.files) {
      safeName(e.path); if (seen.has(e.path) || !Number.isSafeInteger(e.size) || e.size < 0 || offset + e.size > plainSize) throw new Error('Invalid manifest entry');
      seen.add(e.path); e.offset = offset;
      if (fileHash(temp, offset, e.size) !== e.sha256) throw new Error(`Checksum mismatch: ${e.path}`);
      offset += e.size;
    }
    if (offset !== plainSize || !seen.has('nirmaan.db') || !seen.has('secrets.json')) throw new Error('Backup is incomplete');
    return consume(temp, manifest);
  } finally { fs.unlinkSync(temp); }
}
export function validateBackup(file, options = {}) {
  return unpack(file, options, (_, manifest) => ({ ok: true, createdAt: manifest.createdAt, purpose: manifest.purpose || null, pendingMigrations: manifest.pendingMigrations || [], files: manifest.files.map(({ path, size, sha256 }) => ({ path, size, sha256 })) }));
}

/** Restore only into a NEW directory; never overwrite a running installation. */
export function restoreBackup(file, destination, options = {}) {
  const target = path.resolve(destination);
  if (fs.existsSync(target)) throw new Error('Restore destination must be a new directory; existing/live data will not be overwritten');
  return unpack(file, options, (temp, manifest) => {
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    try {
      for (const e of manifest.files) {
        const out = path.resolve(target, ...e.path.split('/'));
        if (!out.startsWith(target + path.sep)) throw new Error('Unsafe restore destination');
        fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 }); const fd = fs.openSync(out, 'wx', 0o600);
        try { chunks(temp, (b) => fs.writeSync(fd, b), e.offset, e.size); } finally { fs.closeSync(fd); }
      }
      const db = new DatabaseSync(path.join(target, 'nirmaan.db'), { readOnly: true });
      try { if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Restored database integrity check failed'); } finally { db.close(); }
      return { ok: true, directory: target, files: manifest.files.length, configuration: path.join(target, 'configuration') };
    } catch (e) { throw new Error(`Restore incomplete at ${target}; do not use this directory: ${e.message}`); }
  });
}
