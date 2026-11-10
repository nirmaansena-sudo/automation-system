// End-to-end business flows through the real webhook → bot → outbox pipeline.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.js';

let h;
before(async () => { h = await boot(); });
after(async () => { await h.close(); });

const C = '919876500001';
const RAHUL = '919800000101';

test('new WhatsApp enquiry → one approval → architect offer → client confirms → architect gets details + location pin', async () => {
  await h.say(C, 'Hi', 'Deepak Saini');
  let m = h.last(C);
  assert.equal(m.payload.type, 'list', 'welcome is a list menu');
  assert.ok(h.listRows(m).some((r) => r.id === 'M:svc:turnkey'));

  await h.pick(C, 'M:svc:turnkey');
  m = h.last(C); assert.ok(h.listRows(m).some((r) => r.id === 'F:zone:vaishali'), 'asks area');
  await h.pick(C, 'F:zone:vaishali');
  m = h.last(C); assert.ok(h.listRows(m).some((r) => r.id === 'F:nature:new_build'), 'asks project type');
  await h.pick(C, 'F:nature:new_build');
  m = h.last(C); assert.match(m.body, /area/i, 'asks plot area');
  await h.say(C, 'around 30 x 50 feet');
  m = h.last(C); assert.equal(m.payload.type, 'buttons'); assert.ok(h.findButton(m, 'F:win:'));
  await h.press(C, 'F:win:immediate');
  m = h.last(C); assert.equal(m.payload.type, 'location_request', 'asks for a location pin (name came from WhatsApp profile)');
  await h.location(C, 26.9131, 75.7425, 'My plot', 'Gandhi Path, Vaishali Nagar');
  m = h.last(C); const slots = h.listRows(m); assert.ok(slots.length >= 2, 'offers visit slots');
  await h.pick(C, slots[0].id);
  m = h.last(C); assert.match(m.body, /1,500 sq ft/); assert.ok(h.findButton(m, 'F:confirm:yes'));
  await h.press(C, 'F:confirm:yes');
  m = h.last(C); assert.match(m.body, /NS-JPR-\d{4}-\d{4}/, 'client gets the Lead ID');

  const lead = h.db.one("SELECT * FROM leads WHERE phone=?", C);
  assert.equal(lead.status, 'awaiting_approval');
  assert.equal(lead.area_sqft, 1500);
  const appr = (await h.api('GET', '/api/approvals')).body.find((a) => a.entity_id === lead.id && a.kind === 'lead_assignment');
  assert.ok(appr, 'exactly one approval gate'); assert.ok(appr.data.suggestion, 'suggested architect + slot');
  assert.equal(h.db.one("SELECT COUNT(*) n FROM approvals WHERE entity_type='lead' AND entity_id=? AND status='pending'", lead.id).n, 1);

  const dec = await h.api('POST', `/api/approvals/${appr.id}/decide`, { decision: 'approve' });
  assert.equal(dec.status, 200, JSON.stringify(dec.body));
  await h.drain();
  const archPhone = h.db.one('SELECT phone FROM users WHERE id=?', dec.body.architect.id).phone;
  const offerMsg = h.last(archPhone);
  assert.equal(offerMsg.route, 'template', 'architect has not written in 24 h → template');
  const offer = h.db.one("SELECT * FROM visit_offers WHERE lead_id=? AND status='pending'", lead.id);
  assert.ok(h.db.one("SELECT 1 FROM calendar_holds WHERE id=? AND kind='hold' AND status='active'", offer.hold_id), 'slot held in the same transaction');

  await h.tplPress(archPhone, `OF:A:${offer.id}:${offer.revision}`);
  m = h.last(C); const yes = h.findButton(m, 'VC:Y'); assert.ok(yes, 'client asked to confirm');
  await h.press(C, yes.id);
  const visit = h.db.one('SELECT * FROM visits WHERE lead_id=?', lead.id);
  assert.equal(visit.status, 'confirmed');
  assert.equal(h.db.one('SELECT status FROM leads WHERE id=?', lead.id).status, 'visit_confirmed');
  const archMsgs = h.outbound(archPhone);
  const details = archMsgs.find((x) => x.body?.includes('Visit confirmed'));
  assert.ok(details, 'architect received the details');
  assert.match(details.body, /98765 00001/, 'with the client phone');
  const pin = archMsgs.find((x) => x.type === 'location');
  assert.ok(pin, 'architect received a WhatsApp location pin');
  assert.equal(pin.payload.lat, 26.9131);
  assert.ok(h.db.one("SELECT 1 FROM calendar_holds WHERE id=? AND kind='visit'", visit.hold_id), 'hold became a booking');
  assert.ok(h.db.one("SELECT COUNT(*) n FROM timers WHERE entity_type='visit' AND entity_id=? AND status='pending'", visit.id).n >= 2, 'reminders + no-show + report timers');
});

test('decline and expiry move to the next architect; when nobody is left the manager is asked', async () => {
  const lead = h.db.one("SELECT * FROM leads WHERE name='Sunita Agarwal'");
  const appr = (await h.api('GET', '/api/approvals')).body.find((a) => a.entity_id === lead.id);
  const dec = await h.api('POST', `/api/approvals/${appr.id}/decide`, { decision: 'approve' });
  assert.equal(dec.status, 200, JSON.stringify(dec.body));
  await h.drain();
  const o1 = h.db.one("SELECT * FROM visit_offers WHERE lead_id=? AND status='pending'", lead.id);
  const p1 = h.db.one('SELECT phone FROM users WHERE id=?', o1.architect_id).phone;
  await h.tplPress(p1, `OF:D:${o1.id}:${o1.revision}`);
  assert.equal(h.db.one('SELECT status FROM visit_offers WHERE id=?', o1.id).status, 'declined');
  assert.equal(h.db.one('SELECT status FROM calendar_holds WHERE id=?', o1.hold_id).status, 'released', 'hold released on decline');
  const o2 = h.db.one("SELECT * FROM visit_offers WHERE lead_id=? AND status='pending'", lead.id);
  assert.ok(o2 && o2.architect_id !== o1.architect_id, 'offered to another architect');
  // stale button from the old offer must not do anything
  await h.tplPress(p1, `OF:A:${o1.id}:${o1.revision}`);
  assert.match(h.last(p1).body, /no longer active/);
  // expiry
  h.util.advanceClock(31 * 60e3);
  await h.drain();
  assert.equal(h.db.one('SELECT status FROM visit_offers WHERE id=?', o2.id).status, 'expired');
  const pending = h.db.one("SELECT COUNT(*) n FROM visit_offers WHERE lead_id=? AND status='pending'", lead.id).n;
  if (pending === 0) {
    const a = h.db.one("SELECT * FROM approvals WHERE entity_type='lead' AND entity_id=? AND status='pending'", lead.id);
    assert.ok(a && /No architect/.test(a.title), 'manager decides when no architect is left');
  }
  h.util.resetClock();
});

test('client asks for another time → slot list → new offer revision; old revision is invalid', async () => {
  const C2 = '919876500002';
  await h.say(C2, 'I need interior design for my flat in Malviya Nagar, 1200 sqft, immediately', 'Meera');
  let m = h.last(C2);
  // remaining questions: nature, location, slot (name from profile)
  for (let i = 0; i < 6 && !h.findButton(m, 'F:confirm:yes'); i++) {
    if (m.payload.type === 'list' && h.listRows(m)[0].id.startsWith('F:nature')) await h.pick(C2, 'F:nature:apartment_interior');
    else if (m.payload.type === 'location_request') await h.location(C2, 26.8562, 75.8221);
    else if (m.payload.type === 'list' && h.listRows(m)[0].id.startsWith('F:slot')) await h.pick(C2, h.listRows(m)[1].id);
    else if (m.payload.type === 'buttons' && h.findButton(m, 'F:win:')) await h.press(C2, 'F:win:immediate');
    else break;
    m = h.last(C2);
  }
  await h.press(C2, 'F:confirm:yes');
  const lead = h.db.one('SELECT * FROM leads WHERE phone=?', C2);
  assert.deepEqual(JSON.parse(lead.services), ['interiors']);
  assert.equal(lead.zone, 'malviya');
  const appr = h.db.one("SELECT * FROM approvals WHERE entity_type='lead' AND entity_id=? AND status='pending'", lead.id);
  const r = await h.api('POST', `/api/approvals/${appr.id}/decide`, { decision: 'approve' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await h.drain();
  const o = h.db.one("SELECT * FROM visit_offers WHERE lead_id=? AND status='pending'", lead.id);
  const ph = h.db.one('SELECT phone FROM users WHERE id=?', o.architect_id).phone;
  await h.tplPress(ph, `OF:A:${o.id}:${o.revision}`);
  m = h.last(C2);
  await h.press(C2, h.findButton(m, 'VC:R').id);
  m = h.last(C2); const rows = h.listRows(m); assert.ok(rows.length > 1, 'new slot list');
  await h.pick(C2, rows[rows.length - 2].id);
  const o2 = h.db.one("SELECT * FROM visit_offers WHERE lead_id=? AND status='pending'", lead.id);
  assert.ok(o2.revision > o.revision, 'new revision');
  await h.press(C2, `VC:Y:${o.id}:${o.revision}`);
  assert.match(h.last(C2).body, /no longer active/, 'old confirm button is ignored');
});

test('hand-off to a person, SLA escalation, staff reply takes ownership, release back to bot', async () => {
  const C3 = '919876500003';
  await h.say(C3, 'Hello', 'Arjun');
  await h.say(C3, 'I want to talk to someone please');
  const conv = h.db.one('SELECT c.* FROM conversations c JOIN contacts k ON k.id=c.contact_id WHERE k.wa_id=?', C3);
  assert.equal(conv.mode, 'human'); assert.equal(conv.needs_attention, 1);
  const n = h.outbound(C3).length;
  await h.say(C3, 'are you there?');
  assert.equal(h.outbound(C3).length, n, 'bot stays quiet in human mode');
  h.util.advanceClock(16 * 60e3); await h.drain();
  assert.match(h.last(C3).body, /patience/, 'holding message after SLA');
  const contact = h.db.one('SELECT id FROM contacts WHERE wa_id=?', C3);
  const rep = await h.api('POST', `/api/inbox/${contact.id}/reply`, { text: 'Hi Arjun, Priya here. How can I help?' });
  assert.equal(rep.status, 200); await h.drain();
  const conv2 = h.db.one('SELECT * FROM conversations WHERE contact_id=?', contact.id);
  assert.ok(conv2.owner_user_id, 'staff owns the chat');
  h.util.advanceClock(125 * 60e3); await h.drain();
  assert.equal(h.db.one('SELECT mode FROM conversations WHERE contact_id=?', contact.id).mode, 'human', 'requested human support waits for explicit release');
  assert.equal((await h.api('POST', `/api/inbox/${contact.id}/release`, {})).status, 200);
  assert.equal(h.db.one('SELECT mode FROM conversations WHERE contact_id=?', contact.id).mode, 'bot');
  h.util.resetClock();
});

test('STOP opt-out, FAQ answer, Hindi detection, job seeker routing', async () => {
  const C4 = '919876500004';
  await h.say(C4, 'what are your working hours?', 'Ravi');
  assert.match(h.last(C4).body, /8:00 AM to 6:00 PM/, 'approved FAQ answer');
  await h.say(C4, 'STOP');
  assert.equal(h.db.one('SELECT opted_out FROM contacts WHERE wa_id=?', C4).opted_out, 1);
  await h.say(C4, 'START');
  assert.equal(h.db.one('SELECT opted_out FROM contacts WHERE wa_id=?', C4).opted_out, 0);
  const C5 = '919876500005';
  await h.say(C5, 'नमस्ते, मुझे घर बनवाना है', 'Suresh ji');
  assert.equal(h.db.one('SELECT language FROM contacts WHERE wa_id=?', C5).language, 'hi');
  assert.match(h.last(C5).body, /[ऀ-ॿ]/, 'replies in Hindi');
  const C6 = '919876500006';
  await h.say(C6, 'Sir mujhe naukri chahiye, mistri ka kaam aata hai', 'Raju');
  assert.equal(h.db.one('SELECT kind FROM contacts WHERE wa_id=?', C6).kind, 'job_seeker');
  assert.ok(!h.db.one('SELECT 1 FROM leads WHERE phone=?', C6), 'job seekers do not become leads');
});

test('website form (OTP verified) keeps its reference and asks only what is missing', async () => {
  const r = await h.api('POST', '/api/public/website-enquiry', { name: 'Neeraj Gupta', mobile: '9876509999', locality: 'Jagatpura', services: ['Full Turnkey'], project_nature: 'New villa', area: '2400', execution_window: 'Within 15 days', reference_id: 'NS-JPR-2026-7777', consent: true }, { headers: { 'x-website-secret': 'wrong' } });
  assert.equal(r.status, 401, 'secret required');
  const { config } = await import('../server/config.js');
  const ok = await h.api('POST', '/api/public/website-enquiry', { name: 'Neeraj Gupta', mobile: '9876509999', locality: 'Jagatpura', services: ['Full Turnkey'], project_nature: 'New villa', area: '2400', execution_window: 'Within 15 days', reference_id: 'NS-JPR-2026-7777', consent: true }, { headers: { 'x-website-secret': config.websiteSecret } });
  assert.equal(ok.status, 200);
  await h.drain();
  const lead = h.db.one("SELECT * FROM leads WHERE ref='NS-JPR-2026-7777'");
  assert.ok(lead, 'website reference becomes the Lead ID');
  assert.equal(lead.zone, 'jagatpura'); assert.equal(lead.area_sqft, 2400);
  const W = '919876509999';
  const greet = h.last(W);
  assert.equal(greet.route, 'template', 'first message outside window is a template');
  await h.tplPress(W, `WEB:${lead.id}`);
  assert.equal(h.last(W).payload.type, 'location_request', 'only missing items are asked');
});

test('quotation → acceptance → project → milestone loop → handover → warranty', async () => {
  const lead = h.db.one('SELECT * FROM leads WHERE phone=?', C);
  const visit = h.db.one('SELECT * FROM visits WHERE lead_id=?', lead.id);
  const arch = h.db.one('SELECT * FROM users WHERE id=?', visit.architect_id);
  const login = await h.api('POST', '/api/auth/app-login', { phone: arch.phone, pin: '1234' }, { noCookie: true });
  const bearer = { headers: { authorization: `Bearer ${login.body.token}` }, noCookie: true };
  assert.equal((await h.api('POST', `/api/app/visits/${visit.id}/checkin`, { lat: 26.9132, lng: 75.7426 }, bearer)).status, 200);
  assert.equal((await h.api('POST', `/api/app/visits/${visit.id}/report`, { measurements: '30x50', scope: 'G+1', recommendation: 'Turnkey', budget_range: '45 L', interest: 'high' }, bearer)).status, 200);
  const ra = h.db.one("SELECT * FROM approvals WHERE kind='visit_report' AND entity_id=? AND status='pending'", visit.id);
  assert.equal((await h.api('POST', `/api/approvals/${ra.id}/decide`, { decision: 'approve' })).status, 200);
  const q = await h.api('POST', `/api/leads/${lead.id}/quotations`, { service_type: 'construction', commercial_model: 'turnkey', items: [{ desc: 'Turnkey G+1', qty: 1500, unit: 'sq ft', rate: 1600 }], gst_pct: 18, submit: true });
  assert.equal(q.status, 200, JSON.stringify(q.body));
  const qa = h.db.one("SELECT * FROM approvals WHERE kind='quotation' AND entity_id=? AND status='pending'", q.body.id);
  assert.equal((await h.api('POST', `/api/approvals/${qa.id}/decide`, { decision: 'approve' })).status, 200);
  await h.drain();
  const qmsg = h.last(C);
  await h.press(C, h.findButton(qmsg, 'Q:A').id);
  const p = h.db.one('SELECT * FROM projects WHERE lead_id=?', lead.id);
  assert.ok(p, 'project created'); assert.equal(p.status, 'awaiting_advance'); assert.equal(p.contract_value, Math.round(1500 * 1600 * 1.18));
  const booking = h.db.one('SELECT * FROM invoices WHERE project_id=? ORDER BY id LIMIT 1', p.id);
  assert.equal((await h.api('POST', `/api/invoices/${booking.id}/payments`, { amount: booking.amount, method: 'upi', reference: 'UTR1' })).status, 200);
  assert.equal(h.db.one('SELECT status FROM projects WHERE id=?', p.id).status, 'active', 'active after advance');
  let guard = 0;
  while (guard++ < 20) {
    const ms = h.db.one("SELECT * FROM milestones WHERE project_id=? AND status='in_progress' ORDER BY seq LIMIT 1", p.id);
    if (!ms) break;
    assert.equal((await h.api('POST', `/api/milestones/${ms.id}/submit`, { note: 'done' })).status, 200);
    const mq = h.db.one("SELECT * FROM approvals WHERE kind='milestone' AND entity_id=? AND status='pending'", ms.id);
    if (guard === 1) { // first stage: test the rework loop once
      await h.api('POST', `/api/approvals/${mq.id}/decide`, { decision: 'rework', note: 'fix level' });
      assert.equal(h.db.one('SELECT status FROM milestones WHERE id=?', ms.id).status, 'rework');
      await h.api('POST', `/api/milestones/${ms.id}/submit`, { note: 'fixed' });
      const mq2 = h.db.one("SELECT * FROM approvals WHERE kind='milestone' AND entity_id=? AND status='pending'", ms.id);
      await h.api('POST', `/api/approvals/${mq2.id}/decide`, { decision: 'pass' });
    } else await h.api('POST', `/api/approvals/${mq.id}/decide`, { decision: 'pass' });
    await h.drain();
    await h.press(C, `MS:A:${ms.id}`);
    const after = h.db.one('SELECT * FROM milestones WHERE id=?', ms.id);
    assert.equal(after.status, 'invoiced', 'accepted stage is invoiced');
  }
  assert.equal(h.db.one('SELECT status FROM projects WHERE id=?', p.id).status, 'handover', 'last stage → handover');
  const ha = h.db.one("SELECT * FROM approvals WHERE kind='handover' AND entity_id=? AND status='pending'", p.id);
  assert.equal((await h.api('POST', `/api/approvals/${ha.id}/decide`, { decision: 'approve' })).status, 200);
  const done = h.db.one('SELECT * FROM projects WHERE id=?', p.id);
  assert.equal(done.status, 'warranty'); assert.ok(done.warranty_until > '2036');
  const invoices = h.db.one("SELECT COUNT(*) n FROM invoices WHERE project_id=?", p.id).n;
  assert.equal(invoices, h.db.one('SELECT COUNT(*) n FROM milestones WHERE project_id=?', p.id).n, 'one invoice per stage');
});

test('existing client menu: status and payments are answered from real data; unknown numbers are not told anything', async () => {
  const AMIT = '919811111101';
  await h.say(AMIT, 'status');
  assert.match(h.last(AMIT).body, /NS-PRJ-\d{4}-\d{3}/);
  await h.say(AMIT, 'payment');
  assert.match(h.last(AMIT).body, /Paid/);
  const X = '919876500077';
  await h.say(X, 'what is the status of NS-PRJ-2026-001', 'Stranger');
  assert.match(h.last(X).body, /verify/i);
  assert.ok(h.db.one("SELECT 1 FROM tickets WHERE category='verify_access'"));
});
