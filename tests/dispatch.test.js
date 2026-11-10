import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { boot } from './helpers.js';
import { gridDisk, isValidCell } from 'h3-js';

let h, dispatch, scheduling, travel, config;
before(async () => {
  h = await boot();
  dispatch = await import('../server/domain/dispatch.js');
  scheduling = await import('../server/domain/scheduling.js');
  travel = await import('../server/domain/travel.js');
  config = (await import('../server/config.js')).config;
});
after(async () => { await h?.close(); });

test('hex coverage assigns every cell exactly once and remains connected for each architect', () => {
  const plan = dispatch.territoryPlan();
  assert.ok(plan.cells.length > 50 && plan.cells.length <= 6000);
  assert.equal(plan.owners.size, plan.cells.length);
  assert.equal(new Set(plan.owners.values()).size, plan.users.length);
  assert.ok(plan.cells.every(isValidCell));
  for (const u of plan.users) {
    const cells = plan.cells.filter(c => plan.owners.get(c) === u.id), visited = new Set([cells[0]]), pending = [cells[0]];
    while (pending.length) for (const c of gridDisk(pending.pop(), 1)) if (plan.owners.get(c) === u.id && !visited.has(c)) { visited.add(c); pending.push(c); }
    assert.equal(visited.size, cells.length, `Territory for ${u.name} must be connected`);
  }
  const json = dispatch.coverageGeoJSON();
  assert.equal(json.type, 'FeatureCollection');
  assert.equal(json.features.length, plan.cells.length);
  assert.ok(json.features.every(f => f.geometry.coordinates[0].length >= 7));
});

test('coverage rebalances when architects are added or deactivated', () => {
  const count = dispatch.territoryPlan().users.length;
  const id = h.db.insert('users', { name: 'Additional architect', role: 'architect', phone: '919800009888', active: 1, daily_visit_cap: 3, created_at: h.util.nowIso() });
  const enlarged = dispatch.territoryPlan();
  assert.equal(enlarged.users.length, count + 1);
  assert.ok(enlarged.users.find(u => u.id === id).cells > 0);
  h.db.run('UPDATE users SET active=0 WHERE id=?', id);
  const reduced = dispatch.territoryPlan();
  assert.equal(reduced.users.length, count);
  assert.equal([...reduced.owners.values()].includes(id), false);
});

test('distance ranking chooses the near architect and respects leave, shifts and daily cap', () => {
  const arches = h.db.all("SELECT * FROM users WHERE active=1 AND role IN ('architect','engineer') ORDER BY id");
  const prior = arches.map(u => ({ ...u }));
  const day = h.util.addDays(h.util.istDate(), 10), start = h.util.fromIst(day, '10:00').toISOString(), end = h.util.addMinIso(start, 60);
  try {
    for (const [i,u] of arches.entries()) {
      h.db.run("UPDATE users SET weekly_off='[]',skills='[]',zones='[]',shift_start='09:00',shift_end='18:00',daily_visit_cap=3 WHERE id=?", u.id);
      dispatch.setLocationProfile(u.id, { default_origin: 'home', home_lat: i === 0 ? 26.90 : 27.04, home_lng: i === 0 ? 75.75 : 75.93 }, 'test');
    }
    const lead = { services: '[]', zone: null, site_lat: 26.901, site_lng: 75.751 };
    let list = scheduling.eligibleArchitects(lead, start, end);
    assert.equal(list[0].user.id, arches[0].id);
    assert.ok(list[0].distance_km < 1);
    h.db.run('UPDATE users SET daily_visit_cap=0 WHERE id=?', arches[0].id);
    assert.ok(!scheduling.eligibleArchitects(lead, start, end).some(x => x.user.id === arches[0].id));
    h.db.run('UPDATE users SET daily_visit_cap=3,shift_start=? WHERE id=?', '11:00', arches[0].id);
    assert.ok(!scheduling.eligibleArchitects(lead, start, end).some(x => x.user.id === arches[0].id));
    h.db.run('UPDATE users SET shift_start=? WHERE id=?', '09:00', arches[0].id);
    const hold = h.db.insert('calendar_holds', { user_id: arches[0].id, start_at: start, end_at: end, kind: 'leave', status: 'active' });
    assert.ok(!scheduling.eligibleArchitects(lead, start, end).some(x => x.user.id === arches[0].id));
    h.db.run('DELETE FROM calendar_holds WHERE id=?', hold);
    const noPin = scheduling.eligibleArchitects({ ...lead, site_lat: null, site_lng: null }, start, end);
    assert.ok(noPin.length > 0); assert.equal(noPin[0].distance_km, null);
  } finally {
    for (const u of prior) h.db.run('UPDATE users SET weekly_off=?,skills=?,zones=?,shift_start=?,shift_end=?,daily_visit_cap=? WHERE id=?', u.weekly_off,u.skills,u.zones,u.shift_start,u.shift_end,u.daily_visit_cap,u.id);
  }
});

test('manual assignment cannot bypass an architect day off', () => {
  const arch = h.db.one("SELECT * FROM users WHERE active=1 AND role='architect' ORDER BY id LIMIT 1");
  const lead = h.db.one('SELECT * FROM leads ORDER BY id LIMIT 1'), day = h.util.addDays(h.util.istDate(), 10), start = h.util.fromIst(day, '12:00').toISOString();
  h.db.run('UPDATE users SET weekly_off=? WHERE id=?', JSON.stringify([h.util.dayOfWeek(day)]), arch.id);
  try { const result = scheduling.createOffer(lead.id, { architectId: arch.id, slotStart: start }); assert.equal(result.code, 'ineligible'); }
  finally { h.db.run('UPDATE users SET weekly_off=? WHERE id=?', arch.weekly_off, arch.id); }
});

test('road routing is opt-in, cached, and round trips request both legs', async () => {
  const arch = h.db.one("SELECT * FROM users WHERE active=1 AND role='architect' ORDER BY id LIMIT 1"), owner = h.db.one("SELECT * FROM users WHERE role='owner' LIMIT 1");
  const contact = h.db.insert('contacts', { wa_id: '919999991234', name: 'Routing fixture', created_at: h.util.nowIso() });
  const lead = h.db.insert('leads', { ref:'TEST-ROUTE',contact_id:contact,site_lat:26.951,site_lng:75.741,services:'[]',created_at:h.util.nowIso() });
  const visit = h.db.insert('visits', { ref:'TEST-ROUTE-VIS',lead_id:lead,architect_id:arch.id,start_at:h.util.nowIso(),end_at:h.util.addMinIso(h.util.nowIso(),60),status:'confirmed',created_at:h.util.nowIso() });
  let hits=0,lastPath='';
  const server=http.createServer((req,res)=>{hits++;lastPath=req.url;res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({code:'Ok',routes:[{distance:4200,duration:900}]}));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const old=config.routing.osrmUrl, policy=dispatch.travelSettings();
  try {
    dispatch.setLocationProfile(arch.id, { default_origin:'office',home_lat:26.95,home_lng:75.74 }, 'test');
    config.routing.osrmUrl=`http://127.0.0.1:${server.address().port}`;
    dispatch.saveDispatchSettings({travel:{rate_per_km:8,round_trip:true}},'test');
    let options=await travel.travelOptions(visit,owner);
    const office=options.choices.find(x=>x.type==='office');
    assert.equal(office.source,'osrm');assert.equal(office.distance_km,4.2);assert.equal(office.amount,34);
    assert.equal(lastPath.split('?')[0].split(';').length,3,'round trip includes return coordinates');
    const firstHits=hits;options=await travel.travelOptions(visit,owner);assert.equal(hits,firstHits,'cached route prevents repeated requests');
    config.routing.osrmUrl=''; options=await travel.travelOptions(visit,owner);
    assert.equal(options.choices.find(x=>x.type==='office').source,'estimated');assert.equal(hits,firstHits,'unconfigured mode never calls a router');
  } finally {config.routing.osrmUrl=old;dispatch.saveDispatchSettings({travel:policy},'test');await new Promise(r=>server.close(r));}
});
