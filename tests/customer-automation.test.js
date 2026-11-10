import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {boot} from './helpers.js';
import http from 'node:http';
let h;
before(async()=>{h=await boot({AI_MODE:'off'});});
after(async()=>{h.util.resetClock();await h.close();});
const contact=phone=>h.db.one('SELECT * FROM contacts WHERE wa_id=?',phone);
const conversation=phone=>h.db.one('SELECT * FROM conversations WHERE contact_id=?',contact(phone).id);

test('Clients defaults to customers and linked staff stay separate even with a legacy category',async()=>{
  const staff=h.db.one("SELECT * FROM contacts WHERE user_id IS NOT NULL LIMIT 1");
  h.db.run("UPDATE contacts SET kind='client' WHERE id=?",staff.id);
  const clients=await h.api('GET','/api/contacts');
  assert.equal(clients.status,200);assert.ok(clients.body.length>0);
  assert.ok(clients.body.every(c=>c.kind==='client'&&!c.user_id));
  assert.ok(!(await h.api('GET','/api/contacts?kind=client')).body.some(c=>c.id===staff.id));
  const directory=(await h.api('GET','/api/contacts?kind=all')).body;
  assert.equal(directory.find(c=>c.id===staff.id).kind,'staff');
  assert.ok((await h.api('GET','/api/contacts?kind=staff')).body.some(c=>c.id===staff.id));
  assert.equal((await h.api('PATCH',`/api/contacts/${staff.id}`,{kind:'client'})).status,400);
  h.db.run("UPDATE contacts SET kind='staff' WHERE id=?",staff.id);
  assert.equal((await h.api('GET','/api/contacts?kind=bogus')).status,400);
  const c=clients.body[0];
  assert.equal((await h.api('PATCH',`/api/contacts/${c.id}`,{tags:{bad:true}})).status,400);
  assert.equal((await h.api('PATCH',`/api/contacts/${c.id}`,{kind:'staff'})).status,400);
});

test('Automatic approved FAQ replies work with AI off; a dry run sends nothing',async()=>{
  const p='919855550101';await h.say(p,'What are your office hours?','Test Client');
  assert.match(h.last(p).body,/8:00 AM to 6:00 PM/);
  const before=h.db.one('SELECT COUNT(*) n FROM outbox').n;
  const result=await h.api('POST','/api/whatsapp/automation/check-answer',{text:'What are your office hours?',language:'en'});
  assert.equal(result.status,200);assert.equal(result.body.action,'approved_answer');assert.match(result.body.answer,/8:00/);
  assert.equal(h.db.one('SELECT COUNT(*) n FROM outbox').n,before);
  const status=await h.api('GET','/api/whatsapp/automation');
  assert.equal(status.body.provider.provider,'simulator');assert.equal(status.body.ai.enabled,false);
  assert.equal(status.body.providerCredentialsConfigured,false);
});

test('Repeated unknown questions hand over and old buttons cannot restart an enquiry',async()=>{
  const p='919855550102';
  await h.say(p,'zqxv one mystery request','Unclear Client');
  assert.equal(conversation(p).mode,'bot');
  await h.say(p,'zqxv two mystery request');
  assert.equal(conversation(p).mode,'human');assert.equal(conversation(p).needs_attention,1);
  const n=h.db.one('SELECT COUNT(*) n FROM leads WHERE contact_id=?',contact(p).id).n;
  await h.pick(p,'M:svc:turnkey');
  assert.equal(h.db.one('SELECT COUNT(*) n FROM leads WHERE contact_id=?',contact(p).id).n,n);
  assert.equal(conversation(p).mode,'human');
  assert.equal((await h.api('PATCH','/api/whatsapp/automation',{human_auto_resume:true})).status,200);
  h.util.advanceClock(7*60*60*1000);await h.drain();
  assert.equal(conversation(p).mode,'human','explicitly escalated chat never silently returns to bot');
  h.util.resetClock();
  assert.equal((await h.api('POST',`/api/inbox/${contact(p).id}/release`,{})).status,200);
  assert.equal(conversation(p).human_requested_at,null);
  await h.say(p,'menu');assert.equal(h.last(p).payload.type,'list');
  await h.api('PATCH','/api/whatsapp/automation',{human_auto_resume:false});
});

test('Reply quota creates one visible handover and manager notification',async()=>{
  await h.api('PATCH','/api/whatsapp/automation',{bot_max_per_hour:1});
  const p='919855550103';await h.say(p,'hi','Quota Client');await h.say(p,'menu');
  assert.equal(conversation(p).mode,'human');assert.equal(conversation(p).needs_attention,1);
  assert.equal(h.db.one("SELECT COUNT(*) n FROM outbox WHERE contact_id=? AND kind='bot.limit_handoff'",contact(p).id).n,1);
  await h.say(p,'menu');
  assert.equal(h.db.one("SELECT COUNT(*) n FROM outbox WHERE contact_id=? AND kind='bot.limit_handoff'",contact(p).id).n,1);
  assert.ok(h.db.one("SELECT COUNT(*) n FROM notifications WHERE title LIKE 'Reply limit reached%'").n>0);
  await h.api('PATCH','/api/whatsapp/automation',{bot_max_per_hour:40});
});

test('Only managers can control automation and browse the combined directory',async()=>{
  for(const policy of [{bot_unknown_before_handoff:0},{ai_confidence_threshold:0.2},{human_auto_resume:'yes'},{whatsapp_token:'x'}]) assert.equal((await h.api('PATCH','/api/whatsapp/automation',policy)).status,400);
  const logged=await h.api('POST','/api/auth/app-login',{phone:'9800000101',pin:'1234'},{noCookie:true});
  const employee={noCookie:true,headers:{authorization:`Bearer ${logged.body.token}`}};
  assert.ok([401,403].includes((await h.api('GET','/api/contacts',undefined,employee)).status));
  assert.ok([401,403].includes((await h.api('GET','/api/whatsapp/automation',undefined,employee)).status));
  await h.api('POST','/api/auth/login',{login:'neha@demo.local',password:'demo1234'});
  assert.equal((await h.api('GET','/api/contacts')).status,200);
  assert.equal((await h.api('GET','/api/contacts?kind=all')).status,403);
  assert.equal((await h.api('GET','/api/whatsapp/automation')).status,403);
  await h.api('POST','/api/auth/login',{login:'owner@test.local',password:'password123'});
});

test('Low-confidence AI cannot invent enquiry fields; a takeover during AI processing wins',async()=>{
  const {config}=await import('../server/config.js');
  const saved={...config.ai};let confidence=0.2,paused=false,release,seen;
  const mock=http.createServer(async(req,res)=>{
    req.resume();
    if(paused) {seen();await new Promise(resolve=>{release=resolve;});}
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({intent:'new_enquiry',services:['turnkey'],zone:'vaishali',confidence})}}]}));
  });
  await new Promise(resolve=>mock.listen(0,'127.0.0.1',resolve));
  Object.assign(config.ai,{mode:'openai',model:'local-mock',apiKey:'fixture-only',baseUrl:`http://127.0.0.1:${mock.address().port}`,timeoutMs:5000});
  try {
    const p='919855550104';await h.say(p,'zqxv unclear wording here','AI test');
    assert.equal(h.db.one('SELECT COUNT(*) n FROM leads WHERE contact_id=?',contact(p).id).n,0);
    assert.equal(conversation(p).mode,'bot');
    const p2='919855550105';confidence=0.99;paused=true;
    const requested=new Promise(resolve=>{seen=resolve;});
    const pending=h.say(p2,'zqxv another wording here','Takeover test');
    await requested;
    const takeover=await h.api('POST',`/api/inbox/${contact(p2).id}/takeover`,{});
    assert.equal(takeover.status,200);release();await pending;
    assert.equal(conversation(p2).mode,'human');
    assert.equal(h.db.one('SELECT COUNT(*) n FROM leads WHERE contact_id=?',contact(p2).id).n,0);
  } finally {release?.();Object.assign(config.ai,saved);await new Promise(resolve=>mock.close(resolve));}
});

test('Human-owned enquiries are neither nudged nor auto-closed, and takeover cancels queued nudges',async()=>{
  const {ensureContact,setFlow}=await import('../server/domain/common.js');
  const {createLead}=await import('../server/domain/leads.js');
  const {nudgeStaleLeads,takeOver,releaseToBot}=await import('../server/bot/engine.js');
  const {setting}=await import('../server/core/base.js');
  const owner=h.db.one("SELECT * FROM users WHERE role='owner'");
  function fixture(phone,hours,mode='bot') {
    return h.db.tx(()=>{
      const c=ensureContact(phone,{name:'Follow-up test'});
      const lead=createLead({contactId:c.id});
      setFlow(c.id,'lead','zone',{leadId:lead.id});
      h.db.run('UPDATE contacts SET last_inbound_at=? WHERE id=?',h.util.addMinIso(h.util.nowIso(),-hours*60),c.id);
      if(mode==='human')takeOver(c.id,owner);
      return {c,lead};
    });
  }
  const nudgeAge=setting('lead_nudge_after_h')+0.1;
  const staleAge=setting('lead_stale_after_h')+1;
  const held=fixture('919855550106',nudgeAge,'human');
  const staleHeld=fixture('919855550107',staleAge,'human');
  const normal=fixture('919855550108',staleAge);
  h.db.tx(()=>nudgeStaleLeads());
  for(const f of [held,staleHeld]){
    assert.equal(h.db.one('SELECT status FROM leads WHERE id=?',f.lead.id).status,'capturing');
    assert.equal(h.db.one("SELECT COUNT(*) n FROM outbox WHERE contact_id=? AND kind='lead.nudge'",f.c.id).n,0);
    assert.equal(h.db.one('SELECT nudges FROM conversations WHERE contact_id=?',f.c.id).nudges,0);
  }
  assert.equal(h.db.one('SELECT status FROM leads WHERE id=?',normal.lead.id).status,'stale','normal bot-owned stale handling still works');
  const queued=fixture('919855550109',nudgeAge);
  h.db.tx(()=>nudgeStaleLeads());
  const job=h.db.one("SELECT * FROM outbox WHERE contact_id=? AND kind='lead.nudge'",queued.c.id);
  assert.equal(job.status,'queued');
  h.db.tx(()=>takeOver(queued.c.id,owner));
  await h.drain();
  assert.equal(h.db.one('SELECT status FROM outbox WHERE id=?',job.id).status,'cancelled','delivery rechecks human ownership');
  assert.equal(h.db.one('SELECT status FROM leads WHERE id=?',queued.lead.id).status,'capturing');
  h.db.tx(()=>releaseToBot(conversation('919855550107').id));
  h.db.tx(()=>nudgeStaleLeads());
  assert.equal(h.db.one('SELECT status FROM leads WHERE id=?',staleHeld.lead.id).status,'stale','explicit release resumes normal stale handling');
});
