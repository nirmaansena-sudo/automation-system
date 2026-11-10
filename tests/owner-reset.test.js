// Emergency owner access (scripts/reset-owner-password.js): a locked-out owner can
// get back in from the machine that holds the data, and nothing else changes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot } from './helpers.js';

const script = fileURLToPath(new URL('../scripts/reset-owner-password.js', import.meta.url));
const cli = (args, env = {}) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', script, ...args], { env: { ...process.env, ...env }, encoding: 'utf8' });
let h;

async function login(login, password) {
  const r = await fetch(`${h.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ns': '1' }, body: JSON.stringify({ login, password }) });
  return { status: r.status, cookie: r.headers.get('set-cookie')?.split(';')[0] || '' };
}
const me = async (cookie) => (await fetch(`${h.base}/api/me`, { headers: { cookie } })).status;
const addMfa = (userId) => h.db.run("INSERT INTO account_security(user_id, secret, last_counter, recovery_hashes, enabled_at) VALUES (?, 'x', -1, '[]', ?)", userId, new Date().toISOString());

before(async () => { h = await boot(); });
after(() => h.close());

test('owner gets a temporary password; old password and sessions stop working', async () => {
  const owner = h.db.one("SELECT * FROM users WHERE role='owner'");
  const before = await login('owner@test.local', 'password123');
  assert.equal(before.status, 200);
  assert.equal(await me(before.cookie), 200);

  const r = cli(['OWNER@test.local']);
  assert.equal(r.status, 0, r.stderr);
  const temporary = /Temporary password for .+: (\S+)/.exec(r.stdout)?.[1];
  assert.ok(temporary && temporary.length >= 16, r.stdout);

  assert.equal(await me(before.cookie), 401, 'existing sessions are signed out');
  assert.equal((await login('owner@test.local', 'password123')).status, 401, 'old password no longer works');
  assert.equal((await login('owner@test.local', temporary)).status, 200, 'temporary password works');
  const entry = h.db.one("SELECT * FROM audit_log WHERE action='user.owner_password_reset_cli' ORDER BY id DESC LIMIT 1");
  assert.equal(entry.entity_id, owner.id);
  assert.equal(JSON.parse(entry.data).mfa_disabled, false);
});

test('two-step verification stays on unless --disable-mfa is given', () => {
  const owner = h.db.one("SELECT * FROM users WHERE role='owner'");
  addMfa(owner.id);
  assert.equal(cli(['owner@test.local']).status, 0);
  assert.ok(h.db.one('SELECT 1 FROM account_security WHERE user_id=?', owner.id), 'MFA kept');
  const r = cli(['owner@test.local', '--disable-mfa']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Two-step verification is off/);
  assert.equal(h.db.one('SELECT 1 FROM account_security WHERE user_id=?', owner.id), undefined, 'MFA removed');
});

test('refuses anyone who is not the owner and changes nothing', () => {
  const manager = h.db.one("SELECT * FROM users WHERE email='priya@demo.local'");
  const r = cli(['priya@demo.local']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /No owner account has that email/);
  assert.equal(h.db.one('SELECT password_hash FROM users WHERE id=?', manager.id).password_hash, manager.password_hash);
  assert.equal(cli(['nobody@test.local']).status, 1);
});

test('wrong data folder or bad arguments: clear error, nothing created', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'nsreset-'));
  const r = cli(['owner@test.local'], { DATA_DIR: empty });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /No database found/);
  assert.deepEqual(fs.readdirSync(empty), [], 'no database or secrets file created');
  assert.equal(cli([]).status, 1);
  assert.equal(cli(['owner@test.local', '--force']).status, 1);
  assert.equal(cli(['owner@test.local', 'second@test.local']).status, 1);
});
