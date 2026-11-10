// Upgrade a populated v1 database, not a freshly migrated empty database.
// All data is synthetic and stored in a new temporary directory. No sockets.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-upgrade-'));
const file = path.join(temp, 'nirmaan.db');
const at = '2026-11-03T09:00:00.000Z';
let db, snapshots, migrations, backups, preupgrade;

before(async () => {
  Object.assign(process.env, { DATA_DIR: temp, DB_FILE: 'nirmaan.db', NS_TEST: 'true', NS_DISABLE_WORKERS: 'true', WHATSAPP_PROVIDER: 'simulator', AI_MODE: 'off', N8N_BASE_URL: 'http://127.0.0.1:1' });
  const legacy = new DatabaseSync(file);
  legacy.exec('PRAGMA foreign_keys=ON');
  legacy.exec(fs.readFileSync(path.join(root, 'server/db/001_init.sql'), 'utf8'));
  legacy.exec('CREATE TABLE schema_migrations(name TEXT PRIMARY KEY,applied_at TEXT)');
  legacy.prepare('INSERT INTO schema_migrations VALUES (?,?)').run('001_init.sql', at);
  const insert = (table, values) => { const names = Object.keys(values); return Number(legacy.prepare(`INSERT INTO ${table}(${names.join(',')}) VALUES(${names.map(() => '?').join(',')})`).run(...Object.values(values)).lastInsertRowid); };
  insert('users', { id:1, name:'Legacy owner', role:'owner', phone:'919900000001', created_at:at, updated_at:at });
  insert('contacts', { id:1, wa_id:'919900000002', name:'Legacy client', consent_at:at, created_at:at, updated_at:at });
  insert('leads', { id:1, ref:'LEGACY-LEAD', contact_id:1, name:'Legacy client', phone:'919900000002', status:'won', created_at:at, updated_at:at });
  insert('projects', { id:1, ref:'LEGACY-PROJECT', name:'Existing project', lead_id:1, client_contact_id:1, contract_value:1000, status:'active', created_at:at, updated_at:at });
  insert('milestones', { id:1, project_id:1, seq:1, name:'Existing stage', amount:1000, status:'invoiced', created_at:at, updated_at:at });
  insert('invoices', { id:1, ref:'LEGACY-INVOICE', project_id:1, milestone_id:1, title:'Existing invoice', amount:1000, paid_amount:450, status:'partially_paid', due_date:'2026-11-15', created_at:at });
  // Old versions allowed duplicate references. Migration must preserve their
  // recorded amounts; it must not silently "repair" historical accounts.
  insert('payments', { id:1, invoice_id:1, project_id:1, amount:200, method:'bank', reference:' legacy-duplicate ', received_at:at, recorded_by:1, created_at:at });
  insert('payments', { id:2, invoice_id:1, project_id:1, amount:200, method:'bank', reference:'LEGACY-DUPLICATE', received_at:at, recorded_by:1, created_at:at });
  insert('payments', { id:3, invoice_id:1, project_id:1, amount:50, method:'cash', reference:'Legacy receipt', received_at:at, recorded_by:1, created_at:at });
  insert('attendance_events', { id:1, user_id:1, kind:'in', server_time:at, effective_time:at, device_time:at, validation:'accepted', client_event_id:'legacy-checkin', lat:26.9, lng:75.7 });
  insert('attendance_days', { user_id:1, day:'2026-11-03', status:'present', first_in:at, minutes:480, updated_at:at });
  insert('outbox', { id:1, channel:'whatsapp', contact_id:1, to_wa_id:'919900000002', kind:'legacy.send', payload:'{"type":"text","text":"Existing queued message"}', status:'queued', created_at:at, updated_at:at });
  insert('outbox', { id:2, channel:'whatsapp', contact_id:1, to_wa_id:'919900000002', kind:'legacy.timeout', payload:'{"type":"text","text":"Delivery uncertain"}', status:'unknown', attempts:1, next_attempt_at:at, created_at:at, updated_at:at });
  insert('routine_runs', { id:1, routine:'manager-morning-brief', run_key:'manager-morning-brief:2026-11-03', status:'running', trigger:'internal', started_at:at });
  insert('routine_runs', { id:2, routine:'backup', run_key:'backup:2026-11-03', status:'failed', trigger:'internal', started_at:at, finished_at:at, result:'{"error":"old disk error"}' });
  insert('timers', { id:1, kind:'approval_sla', entity_type:'project', entity_id:1, due_at:at, status:'pending', data:'{}', created_at:at });
  insert('timers', { id:2, kind:'legacy_failed', due_at:at, status:'failed', data:'{}', result:'Legacy error', created_at:at });
  insert('settings', { key:'business_name', value:'"Legacy business"', updated_at:at });
  assert.deepEqual(legacy.prepare('PRAGMA foreign_key_check').all(), []);
  const tables = legacy.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='schema_migrations' ORDER BY name").all();
  snapshots = tables.map(({ name }) => ({ name, columns:legacy.prepare(`PRAGMA table_info(${name})`).all().map(c => c.name), rows:legacy.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all().map(r => ({...r})) }));
  legacy.close();
  migrations = fs.readdirSync(path.join(root,'server/db')).filter(f => /^\d+_.*\.sql$/.test(f)).sort();
  backups = await import('../server/lib/backups.js');
  preupgrade = backups.backupBeforeUpgrade();
  db = await import('../server/db/index.js');
  db.openDb(file);
});
after(() => { db?.closeDb(); });

test('pre-upgrade backup preserves a restorable encrypted v1 snapshot before any migration', () => {
  assert.ok(preupgrade?.encrypted);
  assert.deepEqual(preupgrade.pendingMigrations,migrations.filter(f=>f!=='001_init.sql'));
  const archive=path.join(temp,'backups',preupgrade.file);
  const manifest=backups.validateBackup(archive);
  assert.equal(manifest.purpose,'pre-upgrade');
  const destination=path.join(temp,'restore-original-v1');
  assert.equal(backups.restoreBackup(archive,destination).ok,true);
  const original=new DatabaseSync(path.join(destination,'nirmaan.db'),{readOnly:true});
  try {
    assert.deepEqual(original.prepare('SELECT name FROM schema_migrations').all().map(r=>r.name),['001_init.sql']);
    assert.equal(original.prepare('SELECT SUM(amount) n FROM payments').get().n,450);
    assert.equal(original.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='purchase_orders'").get().n,0);
  } finally {original.close();}
  assert.equal(backups.backupBeforeUpgrade(),null,'up-to-date databases do not get a redundant startup backup');
  assert.equal(fs.readdirSync(path.join(temp,'backups')).some(f=>f.endsWith('.db')||f.endsWith('.partial')),false,'no plaintext snapshot left in backup directory');
});

test('populated v1 upgrade preserves every original column, historical duplicate payment and financial total', () => {
  for (const s of snapshots) assert.deepEqual(db.all(`SELECT ${s.columns.join(',')} FROM ${s.name} ORDER BY rowid`),s.rows,`Legacy data changed in ${s.name}`);
  assert.equal(db.one('SELECT SUM(amount) n FROM payments').n,450);
  assert.equal(db.one('SELECT paid_amount FROM invoices WHERE id=1').paid_amount,450);
  assert.equal(db.one("SELECT COUNT(*) n FROM payments WHERE UPPER(TRIM(reference))='LEGACY-DUPLICATE'").n,2);
  assert.deepEqual(db.all('SELECT name FROM schema_migrations ORDER BY name').map(r=>r.name),migrations);
});

test('new defaults and foreign keys are valid; reopening applies no migration twice', () => {
  assert.equal(db.one('SELECT require_payment_before_handover FROM projects WHERE id=1').require_payment_before_handover,0);
  assert.equal(db.one('SELECT original_amount FROM invoices WHERE id=1').original_amount,null);
  assert.deepEqual(db.one('SELECT normalized_reference,client_event_id FROM payments WHERE id=1'),{normalized_reference:null,client_event_id:null});
  assert.deepEqual(db.all('SELECT attempts,next_attempt_at FROM routine_runs ORDER BY id'),[{attempts:0,next_attempt_at:null},{attempts:0,next_attempt_at:null}]);
  assert.deepEqual(db.all('SELECT attempts,next_attempt_at FROM timers ORDER BY id'),[{attempts:0,next_attempt_at:null},{attempts:0,next_attempt_at:null}]);
  for(const table of ['refunds','credit_notes','account_security','architect_locations','visit_travel','purchase_orders','stock_movements','project_budgets','media_transcripts','compute_usage']) assert.ok(db.tableNames().includes(table),`Missing ${table}`);
  const applied=db.all('SELECT * FROM schema_migrations ORDER BY name');
  db.closeDb();db.openDb(file);db.closeDb();db.openDb(file);
  assert.deepEqual(db.all('SELECT * FROM schema_migrations ORDER BY name'),applied);
  assert.deepEqual(db.all('PRAGMA foreign_key_check'),[]);
  assert.equal(db.one('PRAGMA integrity_check').integrity_check,'ok');
  for (const s of snapshots) assert.deepEqual(db.all(`SELECT ${s.columns.join(',')} FROM ${s.name} ORDER BY rowid`),s.rows);
});

test('payment replay checks recognize legacy references without rewriting historical duplicates', async () => {
  const { recordPayment } = await import('../server/domain/projects.js');
  const actor=db.one('SELECT * FROM users WHERE id=1');
  const replay=db.tx(()=>recordPayment(1,{amount:200,method:'bank',reference:'legacy-duplicate',client_event_id:'post-upgrade-replay'},actor));
  assert.equal(replay.duplicate,true);
  const conflict=db.tx(()=>recordPayment(1,{amount:25,method:'bank',reference:'LEGACY-DUPLICATE',client_event_id:'post-upgrade-conflict'},actor));
  assert.ok(conflict.error);
  assert.equal(db.one('SELECT COUNT(*) n FROM payments').n,3);
  assert.equal(db.one('SELECT SUM(amount) n FROM payments').n,450);
  assert.deepEqual(db.all('PRAGMA foreign_key_check'),[]);
});
