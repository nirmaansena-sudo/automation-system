// Database layer on Node's built-in SQLite (node:sqlite). Synchronous and
// single-process: a transaction can never interleave with another one, which
// makes atomic "check + reserve" operations (slot holds, outbox claims) simple.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
let db = null;
let depth = 0;
let afterCommit = [];
const cache = new Map();

function clean(p) {
  if (p === undefined) return null;
  if (p === null) return null;
  if (typeof p === 'boolean') return p ? 1 : 0;
  if (p instanceof Date) return p.toISOString();
  if (typeof p === 'object' && !(p instanceof Uint8Array)) return JSON.stringify(p);
  return p;
}
function stmt(sql) {
  let s = cache.get(sql);
  if (!s) { s = db.prepare(sql); cache.set(sql, s); }
  return s;
}
const plain = (row) => (row ? { ...row } : row);

export function openDb(file) {
  if (db) return db;
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;');
  migrate();
  return db;
}
export function closeDb() { if (db) { db.close(); db = null; cache.clear(); } }
/** Fast structural check of the database file: 'ok' or the first problems found. */
export function quickCheck() {
  try { const rows = db.prepare('PRAGMA quick_check(5)').all(); return rows.map((r) => Object.values(r)[0]).join('; ') || 'ok'; }
  catch (e) { return String(e.message); }
}
export function rawDb() { return db; }

function migrate() {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT)');
  const files = fs.readdirSync(here).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  for (const f of files) {
    const done = db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get(f);
    if (done) continue;
    const sql = fs.readFileSync(path.join(here, f), 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations(name, applied_at) VALUES (?, ?)').run(f, new Date().toISOString());
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${f} failed: ${e.message}`);
    }
  }
}

/** All rows. */
export function all(sql, ...params) { return stmt(sql).all(...params.map(clean)).map(plain); }
/** First row or undefined. */
export function one(sql, ...params) { return plain(stmt(sql).get(...params.map(clean))); }
/** Single value of the first column. */
export function val(sql, ...params) { const r = stmt(sql).get(...params.map(clean)); return r ? Object.values(r)[0] : undefined; }
/** Execute; returns { changes, id }. */
export function run(sql, ...params) {
  const r = stmt(sql).run(...params.map(clean));
  return { changes: Number(r.changes), id: Number(r.lastInsertRowid) };
}
/** Insert an object into a table; returns new id. */
export function insert(table, obj) {
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined);
  const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
  return run(sql, ...keys.map((k) => obj[k])).id;
}
/** Update columns of a row by id. */
export function update(table, id, obj) {
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined);
  if (!keys.length) return 0;
  const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`;
  return run(sql, ...keys.map((k) => obj[k]), id).changes;
}

/**
 * Run fn inside a transaction. fn MUST be synchronous (no awaits): network
 * calls happen outside transactions, results are written in a new one.
 * Nested calls join the outer transaction.
 */
export function tx(fn) {
  if (depth > 0) {
    const sp = `sp${depth}`;
    const hookCount = afterCommit.length;
    db.exec(`SAVEPOINT ${sp}`);
    depth++;
    try {
      const r = fn();
      if (r && typeof r.then === 'function') throw new Error('tx() callback must be synchronous');
      db.exec(`RELEASE ${sp}`);
      return r;
    } catch (e) {
      try { db.exec(`ROLLBACK TO ${sp}`); db.exec(`RELEASE ${sp}`); } catch { /* ignore */ }
      afterCommit.length = hookCount;
      throw e;
    } finally { depth--; }
  }
  db.exec('BEGIN IMMEDIATE');
  depth = 1;
  let result;
  try {
    result = fn();
    if (result && typeof result.then === 'function') throw new Error('tx() callback must be synchronous');
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    afterCommit = [];
    depth = 0;
    throw e;
  }
  depth = 0;
  const hooks = afterCommit; afterCommit = [];
  for (const h of hooks) { try { h(); } catch (e) { console.error('afterCommit hook failed', e); } }
  return result;
}
/** Run a callback after the current transaction commits (or now if none). */
export function onCommit(fn) { if (depth > 0) afterCommit.push(fn); else fn(); }
export function inTx() { return depth > 0; }

export function tableNames() {
  return all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations' ORDER BY name").map((r) => r.name);
}
export function columns(table) { return all(`PRAGMA table_info(${table})`).map((c) => c.name); }
export function backupTo(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.unlinkSync(file);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
}
