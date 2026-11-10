import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { boot } from './helpers.js';

let h, exports_, cookies, ownerId, projectId, sensitiveTaskId;
const absent = ['RAW_PROVIDER_SECRET','EXPORT_PASSWORD_HASH','EXPORT_PIN_HASH','EXPORT_SESSION_HASH','EXPORT_MFA_SECRET','EXPORT_RECOVERY_HASH','EXPORT_HOME_ADDRESS','12.1234567','45.9876543','PRIVATE_ACCESS_123456789','C:\\private-media-path','EMBEDDED_API_SECRET','QUERY_TOKEN_VALUE','BEARER_VALUE_SECRET','TRAVEL_POLICY_SECRET','MEDIA_ABSOLUTE_TOKEN','MEDIA_RELATIVE_TOKEN','VISIT_REPORT_SECRET'];
before(async()=>{
  h=await boot({AI_MODE:'off',N8N_BASE_URL:'http://127.0.0.1:1'});
  exports_=await import('../server/domain/exports.js');
  const {createSession}=await import('../server/lib/auth.js');
  const owner=h.db.one("SELECT * FROM users WHERE role='owner'");ownerId=owner.id;
  const manager=h.db.one("SELECT * FROM users WHERE role='manager'");const finance=h.db.one("SELECT * FROM users WHERE role='finance'");const employee=h.db.one("SELECT * FROM users WHERE role='architect'");
  cookies={owner:`ns_session=${createSession(owner.id,'dashboard')}`,manager:`ns_session=${createSession(manager.id,'dashboard')}`,finance:`ns_session=${createSession(finance.id,'dashboard')}`,employee:`ns_app=${createSession(employee.id,'app')}`};
  const project=h.db.one('SELECT * FROM projects LIMIT 1');projectId=project.id;
  const contact=h.db.one('SELECT * FROM contacts WHERE id=?',project.client_contact_id);const at=h.util.nowIso();
  h.db.tx(()=>{
    h.db.run("UPDATE users SET password_hash='EXPORT_PASSWORD_HASH',pin_hash='EXPORT_PIN_HASH',department='Design',work_mode='hybrid' WHERE id=?",owner.id);
    h.db.insert('sessions',{user_id:owner.id,token_hash:'EXPORT_SESSION_HASH',kind:'dashboard',expires_at:'2099-01-01T00:00:00.000Z'});
    h.db.insert('account_security',{user_id:owner.id,secret:'EXPORT_MFA_SECRET',recovery_hashes:'["EXPORT_RECOVERY_HASH"]',enabled_at:at});
    h.db.insert('architect_locations',{user_id:employee.id,home_lat:12.1234567,home_lng:45.9876543,home_label:'EXPORT_HOME_ADDRESS',default_origin:'home',updated_at:at});
    h.db.run("UPDATE projects SET public_token='PRIVATE_ACCESS_123456789' WHERE id=?",project.id);
    h.db.insert('messages',{contact_id:contact.id,direction:'in',type:'text',body:'हिंदी enquiry https://local.invalid/p/PRIVATE_ACCESS_123456789 https://api.invalid/check?token=QUERY_TOKEN_VALUE Authorization: Bearer BEARER_VALUE_SECRET',payload:'{"access_token":"RAW_PROVIDER_SECRET"}',status:'received',created_at:at});
    h.db.insert('inbound_events',{provider:'simulator',kind:'message',dedupe_key:'secret-fixture',wa_id:contact.wa_id,payload:'{"access_token":"RAW_PROVIDER_SECRET"}',status:'done',received_at:at});
    h.db.insert('outbox',{contact_id:contact.id,kind:'export.test',payload:'{"secret":"RAW_PROVIDER_SECRET"}',status:'sent',created_at:at});
    h.db.insert('audit_log',{at,actor:'test',action:'secret.fixture',data:'{"api_key":"EMBEDDED_API_SECRET"}'});
    const mediaId=h.db.insert('media',{mime:'audio/ogg',file_path:'C:\\private-media-path\\voice.ogg',caption:'Client voice note',owner_type:'project',owner_id:project.id,status:'stored',created_at:at});
    h.db.insert('media_transcripts',{media_id:mediaId,status:'reviewed',language:'hi',text:'साइट की प्रगति बताएं',original_text:'साइट प्रगति',started_at:at,completed_at:at,updated_at:at});
    h.db.run('UPDATE quotations SET items=? WHERE id=?',JSON.stringify([{desc:'Design work',qty:1,rate:123.45,amount:123.45,api_key:'EMBEDDED_API_SECRET'}]),project.quotation_id);
    h.db.insert('project_budgets',{project_id:project.id,amount_paise:123456789,updated_by:owner.id,updated_at:at});
    const visit=h.db.one('SELECT * FROM visits LIMIT 1');
    h.db.run('UPDATE visits SET report=? WHERE id=?',JSON.stringify({summary:'Retained visit findings',home_lat:12.1234567,origin_lng:45.9876543,home_label:'EXPORT_HOME_ADDRESS',nested:{token:'VISIT_REPORT_SECRET',photo:`https://local.invalid/media/${mediaId}?size=full&t=MEDIA_ABSOLUTE_TOKEN`,relative:`/media/${mediaId}?t=MEDIA_RELATIVE_TOKEN&size=full`}}),visit.id);
    h.db.insert('visit_travel',{visit_id:visit.id,user_id:employee.id,visit_revision:1,origin_type:'home',origin_lat:12.1234567,origin_lng:45.9876543,site_lat:26.9,site_lng:75.7,distance_km:12.25,distance_source:'manager_verified',amount:122.55,policy:JSON.stringify({rate_per_km:10,base_amount:0,secret:'TRAVEL_POLICY_SECRET'}),status:'approved',created_at:at,updated_at:at});
    for(let i=0;i<1203;i++)h.db.insert('tasks',{title:`Export row ${i}`,description:i===1100?'Hindi: निर्माण; quoted "value"\nsecond line':'Complete row',status:'todo',created_at:at});
    sensitiveTaskId=h.db.insert('tasks',{title:' \t=HYPERLINK("https://invalid.example")',status:'todo',created_at:at});
  });
});
after(async()=>{if(h)await h.close();});

function assertSecretsAbsent(serialized){for(const sentinel of absent)assert.equal(serialized.includes(sentinel),false,`Leaked ${sentinel}`);}
function crc32Slow(bytes){let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let i=0;i<8;i++)crc=(crc&1)?(crc>>>1)^0xedb88320:crc>>>1;}return(crc^0xffffffff)>>>0;}
// Independent central-directory reader: checks every stored entry and CRC.
function readZip(buffer){
  const end=buffer.length-22;assert.equal(buffer.readUInt32LE(end),0x06054b50);
  const count=buffer.readUInt16LE(end+10),centralSize=buffer.readUInt32LE(end+12),centralStart=buffer.readUInt32LE(end+16);assert.equal(centralStart+centralSize,end);
  const entries=new Map();let p=centralStart;
  for(let i=0;i<count;i++){
    assert.equal(buffer.readUInt32LE(p),0x02014b50);assert.equal(buffer.readUInt16LE(p+10),0,'stored ZIP method');
    const crc=buffer.readUInt32LE(p+16),size=buffer.readUInt32LE(p+24),n=buffer.readUInt16LE(p+28),extra=buffer.readUInt16LE(p+30),comment=buffer.readUInt16LE(p+32),local=buffer.readUInt32LE(p+42);
    const name=buffer.subarray(p+46,p+46+n).toString('utf8');assert.equal(buffer.readUInt32LE(local),0x04034b50);
    const start=local+30+buffer.readUInt16LE(local+26)+buffer.readUInt16LE(local+28);const bytes=buffer.subarray(start,start+size);
    assert.equal(bytes.length,size);assert.equal(crc32Slow(bytes),crc,`${name} CRC`);assert.equal(buffer.readUInt32LE(start+size),0x08074b50);
    entries.set(name,bytes);p+=46+n+extra+comment;
  }
  assert.equal(p,end);return entries;
}
function parseCsv(text){
  const rows=[];let row=[],cell='',quoted=false;text=text.replace(/^\uFEFF/,'');
  for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}else if(c===','&&!quoted){row.push(cell);cell='';}else if((c==='\r'||c==='\n')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(cell);rows.push(row);row=[];cell='';}else cell+=c;}
  if(cell||row.length){row.push(cell);rows.push(row);}assert.equal(quoted,false);return rows;
}

test('JSON exports every row from one snapshot with exact numeric values and sensitive fields removed',async()=>{
  const before=h.db.one('SELECT COUNT(*) n FROM tasks').n;
  const pending=exports_.prepareBusinessExport('json');
  h.db.insert('tasks',{title:'Added after snapshot',status:'todo',created_at:h.util.nowIso()});
  const report=await pending;
  try{
    const bytes=fs.readFileSync(report.file);const pack=JSON.parse(bytes);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),report.sha256);
    assert.equal(pack.tables.tasks.length,before);assert.ok(pack.tables.tasks.length>1200);
    assert.equal(pack.tables.tasks.some(r=>r.title==='Added after snapshot'),false);
    for(const t of pack.manifest.tables){assert.equal(pack.tables[t.name].length,t.rows);assert.deepEqual(Object.keys(pack.tables[t.name][0]||Object.fromEntries(t.columns.map(c=>[c.name,null]))),t.columns.map(c=>c.name));}
    assert.equal(pack.tables.project_budgets[0].amount_paise,123456789);
    assert.equal(pack.tables.visit_travel[0].amount,122.55);assert.equal(pack.tables.visit_travel[0].distance_km,12.25);
    assert.equal(pack.tables.payments.reduce((n,p)=>n+p.amount,0),h.db.one('SELECT SUM(amount) n FROM payments').n);
    assert.equal(pack.tables.users.find(u=>u.id===ownerId).department,'Design');assert.equal(pack.tables.users.find(u=>u.id===ownerId).work_mode,'hybrid');
    assert.equal(pack.tables.project_external_costs.length,0);assert.ok(pack.schema.project_external_costs.length>0);
    assert.equal(pack.tables.tasks.find(t=>t.id===sensitiveTaskId).title,' \t=HYPERLINK("https://invalid.example")','JSON does not alter spreadsheet-like business text');
    assert.ok(pack.tables.media_transcripts[0].text.includes('साइट'));
    const visitReport=pack.tables.visits.find(v=>v.report?.summary==='Retained visit findings').report;
    assert.equal(visitReport.home_lat,undefined);assert.equal(visitReport.origin_lng,undefined);assert.equal(visitReport.home_label,undefined);assert.equal(visitReport.nested.token,undefined);
    assert.match(visitReport.nested.photo,/size=full/);assert.match(visitReport.nested.relative,/size=full/);
    assertSecretsAbsent(bytes.toString('utf8'));
    assert.equal(pack.tables.sessions,undefined);assert.equal(pack.tables.account_security,undefined);assert.equal(pack.tables.architect_locations,undefined);
    assert.ok(pack.manifest.omittedTables.some(t=>t.name==='account_security'));
    assert.ok(pack.manifest.tables.find(t=>t.name==='projects').omittedColumns.includes('public_token'));
    assert.equal(fs.existsSync(path.join(path.dirname(report.file),'snapshot.db')),false);
    await assert.rejects(exports_.prepareBusinessExport('json'),e=>e.status===429);
  }finally{const dir=path.dirname(report.file);report.cleanup();assert.equal(fs.existsSync(dir),false);}
});

test('CSV ZIP contains valid complete table files, empty headers, metadata, Hindi and safe spreadsheet cells',async()=>{
  const report=await exports_.prepareBusinessExport('zip');
  try{
    const entries=readZip(fs.readFileSync(report.file));const manifest=JSON.parse(entries.get('manifest.json'));
    assert.equal(entries.size,manifest.tables.length+3);assert.ok(entries.has('schema.json'));assert.ok(entries.get('README.txt').toString().includes('NOT a restore backup'));
    for(const t of manifest.tables){const bytes=entries.get(t.file);assert.deepEqual([...bytes.subarray(0,3)],[239,187,191]);const rows=parseCsv(bytes.toString('utf8'));assert.deepEqual(rows[0],t.columns.map(c=>c.name));assert.equal(rows.length-1,t.rows,`${t.name} completeness`);assertSecretsAbsent(bytes.toString('utf8'));}
    const taskRows=parseCsv(entries.get('tasks.csv').toString('utf8'));const header=taskRows.shift();const title=header.indexOf('title');
    assert.ok(taskRows.length>1200);assert.ok(taskRows.some(r=>r[title].startsWith("' \t=HYPERLINK")));
    assert.ok(taskRows.some(r=>r[header.indexOf('description')]==='Hindi: निर्माण; quoted "value"\nsecond line'));
    const empty=parseCsv(entries.get('project_external_costs.csv').toString('utf8'));assert.equal(empty.length,1);
    if(process.platform==='win32'){
      const script=path.join(h.dir,'verify-export-zip.ps1');
      fs.writeFileSync(script,`param([string]$Archive)\nAdd-Type -AssemblyName System.IO.Compression.FileSystem\n$z=[System.IO.Compression.ZipFile]::OpenRead($Archive)\ntry {\n  $total=0\n  foreach($entry in $z.Entries){$stream=$entry.Open();try{$stream.CopyTo([System.IO.Stream]::Null);$total++}finally{$stream.Dispose()}}\n  @{entries=$total;tasks=$z.GetEntry('tasks.csv').Length;manifest=$z.GetEntry('manifest.json').Length}|ConvertTo-Json -Compress\n}finally{$z.Dispose()}\n`);
      const powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
      const checked=JSON.parse(execFileSync(powershell,['-NoProfile','-NonInteractive','-File',script,report.file],{encoding:'utf8',timeout:20000}));
      assert.equal(checked.entries,entries.size);assert.ok(checked.tasks>10000);assert.ok(checked.manifest>1000);
    }
  }finally{report.cleanup();}
});

test('abort removes raw snapshots and incomplete reports without leaving the export locked',async()=>{
  const ac=new AbortController();const report=exports_.prepareBusinessExport('json',{signal:ac.signal});ac.abort();
  await assert.rejects(report,/cancelled/);
  const root=path.join(h.dir,'export-tmp');assert.deepEqual(fs.readdirSync(root),[]);
  const next=await exports_.prepareBusinessExport('json');next.cleanup();assert.deepEqual(fs.readdirSync(root),[]);
});

test('report endpoints allow owner/manager, reject finance/employees and stream valid download bytes',async()=>{
  for(const role of ['owner','manager']){const r=await fetch(h.base+'/api/exports/inventory',{headers:{cookie:cookies[role]}});assert.equal(r.status,200);assert.ok((await r.json()).tables.some(t=>t.name==='payments'));}
  for(const role of ['finance','employee'])for(const suffix of ['inventory','business.json','business.zip']){const r=await fetch(h.base+'/api/exports/'+suffix,{headers:{cookie:cookies[role]}});assert.equal(r.status,role==='employee'?401:403,`${role} ${suffix}`);await r.arrayBuffer();}
  assert.equal((await fetch(h.base+'/api/exports/inventory')).status,401);
  const r=await fetch(h.base+'/api/exports/business.zip',{headers:{cookie:cookies.owner}});assert.equal(r.status,200);assert.equal(r.headers.get('content-type'),'application/zip');assert.match(r.headers.get('content-disposition'),/attachment; filename="nirmaan-business-/);
  const bytes=Buffer.from(await r.arrayBuffer());assert.equal(Number(r.headers.get('content-length')),bytes.length);assert.equal(r.headers.get('x-export-sha256'),crypto.createHash('sha256').update(bytes).digest('hex'));assert.ok(readZip(bytes).has('payments.csv'));
  for(let i=0;i<30&&fs.readdirSync(path.join(h.dir,'export-tmp')).length;i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.deepEqual(fs.readdirSync(path.join(h.dir,'export-tmp')),[]);
  assert.ok(h.db.one("SELECT id FROM audit_log WHERE action='data.business_export_requested'"));
});
