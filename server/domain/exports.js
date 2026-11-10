// Portable analysis exports. Explicit field lists are intentional: new/private
// columns never become downloadable merely because the database grows.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { backupTo, rawDb } from '../db/index.js';
import { config } from '../config.js';
import { HttpError } from '../lib/http.js';

const spec = (table, label, fields, json = '') => ({ table, label, fields: fields.split(' '), json: new Set(json ? json.split(' ') : []) });
export const BUSINESS_EXPORT_TABLES = [
  spec('users','Team','id name phone email role title department work_mode zones skills shift_start shift_end grace_min weekly_off daily_visit_cap active notes created_at updated_at','zones skills weekly_off'),
  spec('contacts','Contacts','id wa_id name profile_name email kind user_id language opted_out opted_out_at consent_at last_inbound_at last_outbound_at tags notes erased_at created_at updated_at','tags'),
  spec('leads','Leads','id ref contact_id source status name phone zone locality address site_lat site_lng location_source services project_nature area_sqft area_text execution_window preferred_slots requirements priority owner_id lost_reason project_id ai_summary consent created_at updated_at submitted_at qualified_at first_response_at','services preferred_slots'),
  spec('conversations','Conversation status','id contact_id mode owner_user_id owner_until human_requested_at flow step awaiting_since nudges unread needs_attention attention_reason last_message_at last_message_preview bot_window_start bot_window_count updated_at'),
  spec('messages','Messages','id contact_id direction wamid type body media_id sender status outbox_id category route created_at status_at'),
  spec('inbound_events','Incoming delivery status','id provider kind wa_id status attempts received_at locked_at processed_at'),
  spec('outbox','Outgoing delivery status','id channel to_wa_id contact_id kind essential sender status attempts max_attempts next_attempt_at lease_until wamid route error_code created_at sent_at updated_at'),
  spec('media','Media index (files excluded)','id mime size sha256 caption owner_type owner_id uploaded_by status created_at'),
  spec('media_transcripts','Voice transcripts','media_id status language text original_text requested_by reviewed_by reviewed_at started_at completed_at updated_at'),
  spec('approvals','Approvals','id kind entity_type entity_id title summary status requested_by decided_by decision decision_note due_at escalated created_at decided_at'),
  spec('visit_offers','Visit offers','id lead_id architect_id revision attempt slot_start slot_end status expires_at responded_at decline_reason client_deadline hold_id created_by created_at updated_at'),
  spec('calendar_holds','Calendar reservations','id user_id start_at end_at kind ref_type ref_id status expires_at created_at'),
  spec('visits','Site visits','id ref lead_id project_id architect_id offer_id hold_id revision start_at end_at status checkin_at checkin_distance_m checkout_at report report_at review_status review_note cancel_reason created_at updated_at','report'),
  spec('quotations','Quotation versions','id ref lead_id project_id version service_type commercial_model items subtotal gst_pct total payment_schedule notes valid_until status client_note created_by approved_by created_at sent_at decided_at updated_at','items payment_schedule'),
  spec('projects','Projects','id ref name lead_id client_contact_id client_name client_phone zone address site_lat site_lng geofence_m service_type commercial_model area_sqft contract_value quotation_id baseline_version status manager_id architect_id supervisor_id engineer_id start_date target_end handover_at warranty_until portfolio_consent digest_enabled authorized_phones notes created_at updated_at require_payment_before_handover','authorized_phones'),
  spec('milestones','Project stages','id project_id seq name baseline_version planned_start planned_end pay_pct amount needs_site_work status progress review_note reviewed_by client_signoff_at client_note completed_at created_at updated_at'),
  spec('site_logs','Daily site logs','id project_id user_id log_date work_done labour materials issues milestone_id progress distance_m client_visible digest_sent_at device_time created_at','labour'),
  spec('invoices','Invoices','id ref project_id milestone_id title amount original_amount due_date status paid_amount reminders last_reminder_at issued_at paid_at created_at'),
  spec('payments','Payments','id invoice_id project_id amount method reference normalized_reference received_at recorded_by created_at'),
  spec('credit_notes','Credit notes','id ref project_id change_request_id amount reason allocations created_at','allocations'),
  spec('refunds','Refunds','id project_id amount method reference recorded_by created_at'),
  spec('reconciliations','Payment reconciliation','id payment_id statement_reference note reconciled_by reconciled_at'),
  spec('change_requests','Scope changes','id ref project_id title description requested_by cost_impact days_impact status new_baseline_version created_at decided_at'),
  spec('tickets','Support tickets','id ref contact_id project_id category subject description priority status assignee_id due_at first_response_at resolved_at created_at updated_at'),
  spec('tasks','Tasks','id title description assignee_id created_by entity_type entity_id kind priority status due_at completed_at evidence created_at updated_at'),
  spec('attendance_events','Attendance evidence (GPS excluded)','id user_id kind device_time server_time effective_time accuracy_m place_type place_id place_name distance_m photo_media_id offline validation reasons review_status reviewed_by review_note reviewed_at note auto','reasons'),
  spec('attendance_days','Attendance register','user_id day status first_in last_out minutes flags updated_at','flags'),
  spec('leave_requests','Leave requests','id user_id type from_date to_date reason status decided_by decision_note created_at decided_at'),
  spec('expense_claims','Expense claims','id user_id category amount claim_date project_id description receipt_media_id status manager_id manager_at finance_id finance_at note created_at'),
  spec('visit_travel','Travel allowances (route coordinates excluded)','visit_id user_id visit_revision origin_type distance_km distance_source duration_min amount policy status revision approved_by approved_at expense_id created_at updated_at','policy'),
  spec('purchase_orders','Material orders','id ref project_id material unit supplier quantity_milli unit_cost_paise received_milli consumed_milli status expense_id note created_by created_at updated_at'),
  spec('stock_movements','Material receipts and use','id order_id kind quantity_milli cost_paise reference note actor_id created_at'),
  spec('project_budgets','Cost budgets','project_id amount_paise revision note updated_by updated_at'),
  spec('project_external_costs','External project costs','id project_id category amount_paise reference note cost_date created_by created_at'),
  spec('notifications','Notifications','id user_id audience title body link level read_at created_at'),
  spec('audit_log','Audit index (payload excluded)','id at actor action entity_type entity_id'),
  spec('timers','Scheduled deadlines','id kind entity_type entity_id revision due_at status created_at fired_at attempts next_attempt_at'),
  spec('routine_runs','Automation run history','id routine run_key trigger status started_at finished_at attempts next_attempt_at'),
  spec('compute_usage','AI and transcription usage','id kind day status provider media_id duration_ms created_at completed_at'),
  spec('zones','Service zones','code name name_hi lat lng active sort'),
  spec('holidays','Holidays','day name'),
  spec('faqs','FAQ content','id question answer_en answer_hi keywords active updated_at'),
  spec('wa_templates','WhatsApp template catalogue','name language category body status updated_at'),
];

const OMITTED_TABLES = {
  users: 'Password and PIN hashes are excluded.',
  sessions: 'Authentication tokens, session details and IP addresses are excluded.',
  account_security: 'MFA secrets, counters and recovery hashes are excluded.',
  architect_locations: 'Staff home coordinates, addresses and private location profiles are excluded.',
  route_cache: 'Cached routes and location-derived keys are excluded.',
  settings: 'Runtime configuration is in the encrypted full backup, not analysis files.',
  system_state: 'Internal runtime state can contain sensitive provider/configuration details.',
  counters: 'Internal ID allocation state is not analysis data.',
  operation_events: 'Internal request deduplication records are excluded.',
  schema_migrations: 'Migration names are included in the manifest instead.',
};
const OMISSIONS = [
  'Passwords/PIN hashes, session tokens, MFA material, API credentials, environment files and configuration secrets.',
  'Private staff home profiles, route endpoints and raw employee/media GPS coordinates. Client site coordinates remain in projects/leads.',
  'Raw provider/webhook/job payloads, arbitrary audit/approval/state JSON and diagnostic errors that may contain access data.',
  'Private quotation/project/visit access tokens and payment links. Recognizable private links and credential-like URL parameters in text are redacted.',
  'Photo, audio and other original media files. The media index and transcripts are included; original files are in the encrypted full backup.',
];
const README = `Nirmaan Sena — portable business analysis export

This package contains EVERY ROW of each table listed in manifest.json. There is
no date filter, pagination cutoff, or dashboard row limit. Empty tables retain
their column headers. All tables come from one consistent database snapshot.

CSV ZIP: each table is a separate UTF-8 CSV with a BOM for Excel, plus manifest.json,
schema.json and this README. Extract the ZIP before opening/importing CSV files.
JSON: manifest, schema and tables are in one JSON file; structured business JSON
columns are decoded to arrays/objects. Invalid stored JSON remains text.

Numbers are exported as stored, without currency symbols or display rounding.
Ordinary monetary columns are INR rupees; *_paise columns are integer paise
(divide by 100); *_milli quantity columns are thousandths of the stated unit
(divide by 1000). Datetimes/dates retain their stored values/time zones.
Use table IDs and *_id columns to join records. JSON preserves SQL NULL as null;
CSV represents NULL as an empty cell. CSV text beginning with formula characters
is prefixed with an apostrophe for safety. Import phone/reference columns as Text
in Excel to avoid automatic number/date conversion. JSON keeps their exact types.

See the manifest for omitted tables/columns and security redactions. This is an
analysis package, NOT a restore backup. Business names, phone numbers, messages,
notes and financial data are included: share only with intended recipients.

For a complete recovery copy including database, media and configuration, the
owner should use Database > Backups. Keep the encrypted .nsbackup file AND its
separate key/password. Analysis ZIP/JSON files are not encrypted.

Save the browser download wherever you choose: local/external drive, a synced
folder, or manually upload to your preferred storage account. This application
does not upload exports to any external service automatically.
`;

function version() { try { return JSON.parse(fs.readFileSync(path.join(config.root, 'package.json'), 'utf8')).version; } catch { return 'unknown'; } }
function describe(db, createdAt = new Date().toISOString()) {
  const actual = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
  const tables = BUSINESS_EXPORT_TABLES.filter((s) => actual.includes(s.table)).map((s) => {
    const cols = db.prepare(`PRAGMA table_info(${s.table})`).all();
    const known = new Map(cols.map((c) => [c.name, c]));
    const missing = s.fields.filter((f) => !known.has(f));
    if (missing.length) throw new Error(`Export schema mismatch for ${s.table}: ${missing.join(', ')}`);
    return { name: s.table, label: s.label, rows: Number(db.prepare(`SELECT COUNT(*) n FROM ${s.table}`).get().n), file: `${s.table}.csv`, columns: s.fields.map((name) => ({ name, sqliteType: known.get(name).type, nullable: !known.get(name).notnull, primaryKey: !!known.get(name).pk, structuredJson: s.json.has(name), ...(name.endsWith('_paise') ? { unit: 'INR paise' } : name.endsWith('_milli') ? { unit: 'thousandths of material unit' } : {}) })), omittedColumns: cols.map((c) => c.name).filter((c) => !s.fields.includes(c)) };
  });
  const included = new Set(tables.map((t) => t.name));
  return { format: 'nirmaan-business-analysis', formatVersion: 1, applicationVersion: version(), snapshotAt: createdAt, scope: 'All rows; all dates; explicitly allowlisted business fields', completeForListedTables: true, rowLimit: null, mediaFilesIncluded: false, encrypted: false, tables, totalRows: tables.reduce((n,t) => n+t.rows,0), omittedTables: actual.filter((t) => !included.has(t)).map((name) => ({ name, reason: OMITTED_TABLES[name] || 'Not in the reviewed business-data allowlist; retained only in full backup.' })), omissions: OMISSIONS, migrations: actual.includes('schema_migrations') ? db.prepare('SELECT name FROM schema_migrations ORDER BY name').all().map((r) => r.name) : [], csv: { encoding: 'UTF-8 with BOM', separator: ',', nullValue: 'empty cell', textFormulaProtection: 'Leading apostrophe on text beginning with = + - @ or control/whitespace followed by these characters', zipCompression: 'stored (no compression)', zipMaximumBytes: 4294967295, identifiers: 'Import phone numbers and reference columns as Text; JSON preserves types.' }, units: { money: 'INR rupees unless column ends _paise (integer paise)', quantity: 'Columns ending _milli contain thousandths of the stated unit', dates: 'Original stored ISO values; UTC timestamps and date-only business dates are not converted' }, fullBackup: 'Owner: Database > Backups; encrypted .nsbackup includes database, original media and configuration. Keep its separate key/password.' };
}

export function exportInventory() { return describe(rawDb()); }

const sensitiveKey = /(?:password|passwd|pin_hash|token|secret|credential|authorization|api.?key|private.?key|recovery.?code)/i;
function cleanText(value) {
  let out = value.replace(/((?:https?:\/\/[^\s<>"']+)?\/(?:q|p|v)\/)[A-Za-z0-9_-]{8,}/g, '$1[redacted]');
  // Media links use the short query key `t`; redact it only on the known
  // private-media route, including relative links in notes/report objects.
  out = out.replace(/\/media\/[A-Za-z0-9_-]+\?[^#\s<>"']+/gi, (candidate) => {
    const split = candidate.indexOf('?'); const params = new URLSearchParams(candidate.slice(split + 1));
    for (const name of params.keys()) if (name.toLowerCase() === 't') params.set(name, '[redacted]');
    return candidate.slice(0, split + 1) + params.toString();
  });
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+\/=\-]+/gi, 'Bearer [redacted]');
  out = out.replace(/https?:\/\/[^\s<>"']+/g, (candidate) => {
    try { const url = new URL(candidate); let changed = false; if (url.username || url.password) { url.username = ''; url.password = ''; changed = true; } for (const name of url.searchParams.keys()) if (sensitiveKey.test(name) || /^(key|signature|sig)$/i.test(name)) { url.searchParams.set(name, '[redacted]'); changed = true; } return changed ? url.toString() : candidate; } catch { return candidate; }
  });
  return out;
}
function cleanValue(v) {
  if (typeof v === 'string') return cleanText(v);
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return v.map(cleanValue);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !sensitiveKey.test(k) && !/^(home_lat|home_lng|home_label|home_address|origin_lat|origin_lng)$/i.test(k)).map(([k,val]) => [k,cleanValue(val)]));
  return v;
}
function cleanRow(row, s) {
  const result = {};
  for (const key of s.fields) {
    let val = row[key];
    if (s.json.has(key) && typeof val === 'string') { try { val = JSON.parse(val); } catch { /* preserve readable malformed historical data */ } }
    if (s.table === 'visit_travel' && key === 'policy' && val && typeof val === 'object' && !Array.isArray(val)) val = Object.fromEntries(['rate_per_km','base_amount','minimum_amount','maximum_amount','round_trip','rounding_rupees','require_manager_approval'].filter(k => Object.hasOwn(val,k)).map(k => [k,val[k]]));
    result[key] = cleanValue(val);
  }
  return result;
}
export function exportCsvCell(value) {
  let text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (typeof value !== 'number' && /^[\s\u0000-\u001f\uFEFF]*[=+\-@]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g,'""') + '"';
}

class Output {
  constructor(file) { this.fd=fs.openSync(file,'wx',0o600); this.offset=0; this.parts=[]; this.buffered=0; this.sha=crypto.createHash('sha256'); }
  write(value) { const b=Buffer.isBuffer(value)?value:Buffer.from(value); this.offset+=b.length; this.sha.update(b); this.parts.push(b); this.buffered+=b.length; if(this.buffered>=262144) this.flush(); }
  flush() { if(!this.buffered)return; const b=Buffer.concat(this.parts,this.buffered); for(let n=0;n<b.length;) n+=fs.writeSync(this.fd,b,n,b.length-n); this.parts=[];this.buffered=0; }
  close() { if(this.fd===null)return;this.flush();fs.fsyncSync(this.fd);fs.closeSync(this.fd);this.fd=null;return this.sha.digest('hex'); }
  abort() { if(this.fd!==null){fs.closeSync(this.fd);this.fd=null;} }
}
const CRC_TABLE = Uint32Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
const crcUpdate = (crc,b) => {for(const byte of b)crc=CRC_TABLE[(crc^byte)&255]^(crc>>>8);return crc>>>0;};
const ZIP_MAX=0xffffffff;
class StoredZip {
  constructor(out, at) {this.out=out;this.entries=[];const d=new Date(at);this.time=(d.getUTCHours()<<11)|(d.getUTCMinutes()<<5)|(d.getUTCSeconds()>>1);this.date=((Math.max(1980,d.getUTCFullYear())-1980)<<9)|((d.getUTCMonth()+1)<<5)|d.getUTCDate();}
  add(name,writeContents) {
    const filename=Buffer.from(name);const offset=this.out.offset;const header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50,0);header.writeUInt16LE(20,4);header.writeUInt16LE(0x0808,6);header.writeUInt16LE(this.time,10);header.writeUInt16LE(this.date,12);header.writeUInt16LE(filename.length,26);this.out.write(header);this.out.write(filename);
    let crc=0xffffffff,size=0;
    writeContents((value)=>{const b=Buffer.isBuffer(value)?value:Buffer.from(value);size+=b.length;if(size>ZIP_MAX||this.out.offset+b.length>ZIP_MAX)throw new Error('CSV ZIP exceeds the 4 GiB ZIP limit. Download the complete JSON export instead.');crc=crcUpdate(crc,b);this.out.write(b);});
    crc=(crc^0xffffffff)>>>0;const descriptor=Buffer.alloc(16);descriptor.writeUInt32LE(0x08074b50,0);descriptor.writeUInt32LE(crc,4);descriptor.writeUInt32LE(size,8);descriptor.writeUInt32LE(size,12);this.out.write(descriptor);this.entries.push({filename,offset,crc,size});
  }
  finish() {
    const start=this.out.offset;
    for(const e of this.entries){const h=Buffer.alloc(46);h.writeUInt32LE(0x02014b50,0);h.writeUInt16LE(20,4);h.writeUInt16LE(20,6);h.writeUInt16LE(0x0808,8);h.writeUInt16LE(this.time,12);h.writeUInt16LE(this.date,14);h.writeUInt32LE(e.crc,16);h.writeUInt32LE(e.size,20);h.writeUInt32LE(e.size,24);h.writeUInt16LE(e.filename.length,28);h.writeUInt32LE(e.offset,42);this.out.write(h);this.out.write(e.filename);}
    const length=this.out.offset-start;if(this.out.offset+22>ZIP_MAX)throw new Error('CSV ZIP exceeds 4 GiB. Use the complete JSON export.');const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(this.entries.length,8);end.writeUInt16LE(this.entries.length,10);end.writeUInt32LE(length,12);end.writeUInt32LE(start,16);this.out.write(end);
  }
}

function buildFile(snapshot,file,format,snapshotAt) {
  const db=new DatabaseSync(snapshot,{readOnly:true});const out=new Output(file);
  try {
    const manifest=describe(db,snapshotAt);const schema=Object.fromEntries(manifest.tables.map(t=>[t.name,t.columns]));
    const readTable=(table,writeRow)=>{const s=BUSINESS_EXPORT_TABLES.find(s=>s.table===table.name);let count=0;for(const row of db.prepare(`SELECT ${s.fields.join(',')} FROM ${s.table} ORDER BY rowid`).iterate()){writeRow(cleanRow(row,s));count++;}if(count!==table.rows)throw new Error(`Export row count mismatch for ${table.name}`);};
    if(format==='json'){
      out.write('{"manifest":'+JSON.stringify(manifest)+',"schema":'+JSON.stringify(schema)+',"readme":'+JSON.stringify(README)+',"tables":{');
      manifest.tables.forEach((table,i)=>{if(i)out.write(',');out.write(JSON.stringify(table.name)+':[');let first=true;readTable(table,row=>{if(!first)out.write(',');out.write(JSON.stringify(row));first=false;});out.write(']');});out.write('}}\n');
    }else{
      const zip=new StoredZip(out,snapshotAt);
      zip.add('manifest.json',write=>write(JSON.stringify(manifest,null,2)+'\n'));
      zip.add('schema.json',write=>write(JSON.stringify(schema,null,2)+'\n'));
      zip.add('README.txt',write=>write(README));
      for(const table of manifest.tables)zip.add(table.file,write=>{write('\uFEFF'+table.columns.map(c=>exportCsvCell(c.name)).join(',')+'\r\n');readTable(table,row=>write(table.columns.map(c=>exportCsvCell(row[c.name])).join(',')+'\r\n'));});
      zip.finish();
    }
    const sha256=out.close();return {manifest,size:out.offset,sha256};
  }catch(e){out.abort();throw e;}finally{db.close();}
}

const exportRoot=()=>path.join(config.dataDir,'export-tmp');
const active=new Set();
function removeJob(dir) {
  const base=path.resolve(exportRoot()),target=path.resolve(dir),rel=path.relative(base,target);
  if(!/^job-[A-Za-z0-9_-]+$/.test(rel)||path.dirname(target)!==base)throw new Error('Refusing unsafe export cleanup path');
  if(!fs.existsSync(target))return;
  const dirStat=fs.lstatSync(target);
  if(!dirStat.isDirectory()||dirStat.isSymbolicLink()||path.dirname(fs.realpathSync(target))!==fs.realpathSync(base))throw new Error('Refusing export cleanup through a symbolic link');
  for(const name of fs.readdirSync(target)){if(!/^(snapshot\.db(?:-wal|-shm)?|business\.(json|zip))$/.test(name))throw new Error('Unexpected file in export temp area');const f=path.join(target,name);const stat=fs.lstatSync(f);if(stat.isDirectory())throw new Error('Unexpected subdirectory in export temp area');fs.unlinkSync(f);}
  fs.rmdirSync(target);
}
export function cleanupStaleExports() {
  const base=exportRoot();if(!fs.existsSync(base))return;
  for(const name of fs.readdirSync(base)){if(!/^job-[A-Za-z0-9_-]+$/.test(name))continue;const dir=path.join(base,name);const st=fs.lstatSync(dir);if(!st.isDirectory()||st.isSymbolicLink()||active.has(dir))continue;if(Date.now()-st.mtimeMs>24*3600000)removeJob(dir);}
}
/** Returns a protected temporary download. Caller MUST cleanup after streaming. */
export async function prepareBusinessExport(format,{signal}={}) {
  if(!['json','zip'].includes(format))throw new HttpError(400,'Choose JSON or CSV ZIP');
  if(active.size)throw new HttpError(429,'Another report is being prepared or downloaded. Please try again when it finishes.');
  if(signal?.aborted)throw new Error('Export cancelled');
  fs.mkdirSync(exportRoot(),{recursive:true,mode:0o700});cleanupStaleExports();
  const dir=fs.mkdtempSync(path.join(exportRoot(),'job-'));active.add(dir);let worker;let released=false;
  const cleanup=()=>{if(released)return;released=true;try{removeJob(dir);}finally{active.delete(dir);}};
  const snapshot=path.join(dir,'snapshot.db');const file=path.join(dir,`business.${format}`);const snapshotAt=new Date().toISOString();
  try {
    // VACUUM INTO produces a consistent snapshot without holding a long-lived
    // read transaction on the live database while the worker writes reports.
    backupTo(snapshot);fs.chmodSync(snapshot,0o600);
    const result=await new Promise((resolve,reject)=>{
      worker=new Worker(new URL(import.meta.url),{workerData:{kind:'business-export',snapshot,file,format,snapshotAt}});
      let settled=false;
      const finish=(error,result)=>{if(settled)return;settled=true;signal?.removeEventListener('abort',abort);error?reject(error):resolve(result);};
      const abort=()=>{worker.terminate().then(()=>finish(new Error('Export cancelled')),finish);};
      signal?.addEventListener('abort',abort,{once:true});
      worker.on('message',m=>{if(m.ok)finish(null,m.result);else finish(/^CSV ZIP exceeds/.test(m.error)?new HttpError(413,m.error):new Error(m.error));});worker.on('error',e=>finish(e));worker.on('exit',code=>{if(!settled)finish(new Error(signal?.aborted?'Export cancelled':`Export worker stopped before completion (${code})`));});
      if(signal?.aborted)abort();
    });
    // The worker closes SQLite before posting completion; delete the raw
    // snapshot immediately, leaving only the sanitized report during download.
    for(const suffix of ['','-wal','-shm'])if(fs.existsSync(snapshot+suffix))fs.unlinkSync(snapshot+suffix);
    if(signal?.aborted)throw new Error('Export cancelled');
    const filename=`nirmaan-business-${snapshotAt.replace(/[:.]/g,'-')}.${format}`;
    return {file,filename,format,...result,cleanup};
  }catch(e){if(worker)await worker.terminate();cleanup();throw e;}
}

if(!isMainThread&&workerData?.kind==='business-export'){
  try{const {snapshot,file,format,snapshotAt}=workerData;const result=buildFile(snapshot,file,format,snapshotAt);parentPort.postMessage({ok:true,result});}
  catch(e){parentPort.postMessage({ok:false,error:e.message});}
}
