// Base data (zones, FAQs from nirmaansena.com, templates) and optional demo data.
import { all, one, run, insert, tx } from '../db/index.js';
import { now, nowIso, addMinIso, istDate, addDays, fromIst, hashSecret, randomToken, dayOfWeek } from '../lib/util.js';
import { ZONES_DEFAULT } from '../bot/catalog.js';
import { seedTemplates } from '../whatsapp/templates.js';
import { nextRef } from '../core/base.js';
import { ensureContact } from '../domain/common.js';
import { recomputeDay } from '../domain/staff.js';

const FAQS = [
  { q: 'Which areas do you serve?', en: 'We work across Jaipur — Vaishali Nagar, Mansarovar, Jhotwara/Kalwar Road, Jagatpura, Malviya Nagar, Raja Park/C-Scheme, Ajmer Road/Bhankrota, Vidhyadhar Nagar, Sanganer/Tonk Road and other Jaipur sectors.', hi: 'हम पूरे जयपुर में काम करते हैं — वैशाली नगर, मानसरोवर, झोटवाड़ा/कालवाड़ रोड, जगतपुरा, मालवीय नगर, राजा पार्क/सी-स्कीम, अजमेर रोड/भांकरोटा, विद्याधर नगर, सांगानेर/टोंक रोड और जयपुर के अन्य क्षेत्र।', kw: 'which area,which areas,service area,where do you work,kahan kaam,कहाँ,outside jaipur,other city' },
  { q: 'What are your working hours?', en: 'We are open Monday to Sunday, 8:00 AM to 6:00 PM. Emergency site teams are on 24/7 standby — reply EMERGENCY if it is urgent.', hi: 'हम सोमवार से रविवार सुबह 8 से शाम 6 बजे तक खुले हैं। आपात स्थिति के लिए साइट टीम 24/7 तैयार रहती है — ज़रूरी हो तो EMERGENCY लिखें।', kw: 'timing,timings,working hours,office hours,open,kab khula,samay,समय,कब' },
  { q: 'How is the cost decided?', en: 'Rates depend on scope, materials and site conditions. After a physical site audit our engineer shares a line-item BOQ with fixed item rates, so you know the cost before work starts.', hi: 'दरें काम, मटेरियल और साइट की स्थिति पर निर्भर करती हैं। साइट ऑडिट के बाद हमारे इंजीनियर तय आइटम दरों वाला BOQ देते हैं, ताकि काम शुरू होने से पहले लागत साफ़ हो।', kw: 'rate,rates,price,cost,per sq ft,per sqft,kitna kharcha,kharcha,budget,estimate,boq,कितना,खर्च,रेट' },
  { q: 'How do payments work?', en: 'Payments are released in stages linked to verified milestones (for example plinth/DPC, lintel, plaster). You get an invoice for each stage after you approve the work.', hi: 'भुगतान सत्यापित चरणों (जैसे प्लिंथ/DPC, लिंटर, प्लास्टर) से जुड़े हिस्सों में होता है। हर चरण का काम आपकी स्वीकृति के बाद उसका इनवॉइस मिलता है।', kw: 'payment terms,how to pay,installment,kist,किस्त,milestone payment,escrow' },
  { q: 'Do you give a warranty?', en: 'Full turnkey civil construction comes with a 10-year structural warranty.', hi: 'पूरे टर्नकी निर्माण पर 10 साल की संरचनात्मक (स्ट्रक्चरल) वारंटी मिलती है।', kw: 'warranty,guarantee,वारंटी,गारंटी' },
  { q: 'Will I get progress updates?', en: 'Yes. During construction you get daily photo updates of your site here on WhatsApp, and a private project page with progress and payments.', hi: 'हाँ। निर्माण के दौरान आपको रोज़ साइट की फ़ोटो अपडेट यहीं WhatsApp पर मिलेंगी, और प्रगति व भुगतान का एक निजी प्रोजेक्ट पेज भी।', kw: 'daily update,progress update,photos,photo,updates,रोज़,फ़ोटो' },
  { q: 'Do you supply building materials?', en: 'Yes — cement, TMT steel, bricks, Kota stone and CPVC fittings at depot rates. Choose "Building materials" in the menu and tell us what you need.', hi: 'हाँ — सीमेंट, TMT सरिया, ईंट, कोटा स्टोन और CPVC फिटिंग डिपो रेट पर। मेनू में "बिल्डिंग मटेरियल" चुनें और ज़रूरत बताएँ।', kw: 'depot rate,material rate,cement rate,steel rate,sariya rate' },
  { q: 'How can I contact you?', en: 'Call or WhatsApp +91 78917 19291, or email contact@nirmaansena.com.', hi: 'कॉल या WhatsApp करें +91 78917 19291, या ईमेल करें contact@nirmaansena.com।', kw: 'contact number,phone number,email,call you,address of office,office address' },
];

export function seedBase() {
  tx(() => {
    if (!one('SELECT 1 FROM zones LIMIT 1')) {
      ZONES_DEFAULT.forEach((z, i) => insert('zones', { code: z.code, name: z.name, name_hi: z.name_hi, lat: z.lat, lng: z.lng, active: 1, sort: i }));
    }
    if (!one('SELECT 1 FROM faqs LIMIT 1')) {
      for (const f of FAQS) insert('faqs', { question: f.q, answer_en: f.en, answer_hi: f.hi, keywords: f.kw, active: 1, updated_at: nowIso() });
    }
    seedTemplates();
  });
}

const DEMO_PIN = '1234';
export function seedDemo() {
  if (one("SELECT 1 FROM users WHERE email='priya@demo.local'")) return { skipped: true };
  return tx(() => {
    const at = nowIso();
    const u = (name, phone, role, extra = {}) => insert('users', { name, phone, email: extra.email || null, role, title: extra.title || null, pin_hash: hashSecret(DEMO_PIN), password_hash: extra.password ? hashSecret(extra.password) : null, zones: JSON.stringify(extra.zones || []), skills: JSON.stringify(extra.skills || []), shift_start: '09:00', shift_end: '18:00', grace_min: 15, weekly_off: JSON.stringify([0]), daily_visit_cap: 3, active: 1, created_at: at, updated_at: at });
    const priya = u('Priya Sharma', '919800000100', 'manager', { email: 'priya@demo.local', password: 'demo1234', title: 'Operations manager' });
    const rahul = u('Rahul Mehta', '919800000101', 'architect', { title: 'Lead architect', zones: ['vaishali', 'ajmer_rd', 'jhotwara', 'vidhyadhar'], skills: ['turnkey', 'architecture', 'renovation', 'interiors', 'pmc', 'specialized', 'labour'] });
    const anjali = u('Anjali Verma', '919800000102', 'architect', { title: 'Architect & interiors', zones: ['mansarovar', 'sanganer', 'malviya', 'jagatpura', 'cscheme'], skills: ['turnkey', 'architecture', 'interiors', 'renovation', 'specialized'] });
    const vikram = u('Vikram Singh', '919800000103', 'engineer', { title: 'Site engineer (PMC)', zones: [], skills: ['renovation', 'pmc', 'specialized', 'labour', 'turnkey'] });
    const suresh = u('Suresh Kumar', '919800000104', 'supervisor', { title: 'Site supervisor' });
    const mahesh = u('Mahesh Yadav', '919800000105', 'supervisor', { title: 'Site supervisor' });
    u('Neha Gupta', '919800000106', 'finance', { email: 'neha@demo.local', password: 'demo1234', title: 'Accounts' });
    for (const [id, phone] of [[priya, '919800000100'], [rahul, '919800000101'], [anjali, '919800000102'], [vikram, '919800000103'], [suresh, '919800000104'], [mahesh, '919800000105']]) ensureContact(phone, { userId: id });

    // Clients
    const amit = ensureContact('919811111101', { name: 'Amit Jain', profileName: 'Amit Jain' });
    const sunita = ensureContact('919811111102', { name: 'Sunita Agarwal', profileName: 'Sunita' });
    const rohit = ensureContact('919811111103', { name: 'Rohit Khandelwal', profileName: 'Rohit K' });
    const kavita = ensureContact('919811111104', { name: 'Kavita Sharma', profileName: 'Kavita' });
    for (const c of [amit, sunita, rohit, kavita]) run('UPDATE contacts SET consent_at=?, last_inbound_at=? WHERE id=?', at, addMinIso(at, -60 * 30), c.id);
    run("UPDATE contacts SET language='hi' WHERE id=?", sunita.id);

    // Active project for Amit (Vaishali Nagar, turnkey)
    const leadA = insert('leads', { ref: nextRef('NS-JPR'), contact_id: amit.id, source: 'whatsapp', status: 'won', name: 'Amit Jain', phone: amit.wa_id, zone: 'vaishali', locality: 'Nemi Nagar', address: 'Plot 42, Nemi Nagar, Vaishali Nagar', site_lat: 26.9089, site_lng: 75.7342, location_source: 'pin', services: JSON.stringify(['turnkey']), project_nature: 'new_build', area_sqft: 2650, area_text: '2650 sq ft', execution_window: 'immediate', consent: 1, created_at: addMinIso(at, -60 * 24 * 40), updated_at: at, submitted_at: addMinIso(at, -60 * 24 * 40) });
    const total = 4753040;
    const qid = insert('quotations', { ref: nextRef('NS-QT'), lead_id: leadA, version: 2, service_type: 'construction', commercial_model: 'turnkey', items: JSON.stringify([{ desc: 'Turnkey civil construction G+1 (structure, masonry, plaster, flooring)', qty: 2650, unit: 'sq ft', rate: 1520, amount: 4028000 }]), subtotal: 4028000, gst_pct: 18, total, payment_schedule: JSON.stringify([]), valid_until: addDays(istDate(), -20), status: 'accepted', public_token: randomToken(18), created_at: addMinIso(at, -60 * 24 * 35), decided_at: addMinIso(at, -60 * 24 * 30), updated_at: at });
    const pid = insert('projects', { ref: nextRef('NS-PRJ', 3), name: 'Amit Jain — Nemi Nagar, Vaishali Nagar', lead_id: leadA, client_contact_id: amit.id, client_name: 'Amit Jain', client_phone: amit.wa_id, zone: 'vaishali', address: 'Plot 42, Nemi Nagar, Vaishali Nagar', site_lat: 26.9089, site_lng: 75.7342, geofence_m: 250, service_type: 'construction', commercial_model: 'turnkey', area_sqft: 2650, contract_value: total, quotation_id: qid, status: 'active', manager_id: priya, architect_id: rahul, supervisor_id: suresh, engineer_id: vikram, start_date: addDays(istDate(), -28), target_end: addDays(istDate(), 140), public_token: randomToken(18), authorized_phones: JSON.stringify([amit.wa_id]), created_at: addMinIso(at, -60 * 24 * 30), updated_at: at });
    run("UPDATE leads SET project_id=? WHERE id=?", pid, leadA);
    run('UPDATE quotations SET project_id=? WHERE id=?', pid, qid);
    const ms = [['Booking advance', 10, 0, 'paid', 100], ['Foundation & plinth (DPC)', 15, 1, 'paid', 100], ['Ground floor slab', 20, 1, 'in_progress', 60], ['Brickwork & lintel', 15, 1, 'planned', 0], ['Roof slab', 15, 1, 'planned', 0], ['Plaster, flooring & finishes', 15, 1, 'planned', 0], ['Handover', 10, 1, 'planned', 0]];
    const msIds = ms.map(([name, pct, site, status, progress], i) => insert('milestones', { project_id: pid, seq: i + 1, name, baseline_version: 1, pay_pct: pct, amount: Math.round(total * pct / 100), needs_site_work: site, status, progress, planned_start: addDays(istDate(), -28 + i * 20), planned_end: addDays(istDate(), -8 + i * 20), created_at: at, updated_at: at }));
    for (const [i, idx] of [[0, 0], [1, 1]]) {
      const amt = Math.round(total * ms[idx][1] / 100);
      const inv = insert('invoices', { ref: nextRef('NS-INV'), project_id: pid, milestone_id: msIds[idx], title: ms[idx][0], amount: amt, due_date: addDays(istDate(), -25 + i * 14), status: 'paid', paid_amount: amt, issued_at: at, paid_at: at, created_at: at });
      insert('payments', { invoice_id: inv, project_id: pid, amount: amt, method: 'bank', reference: `UTR${100200 + i}`, received_at: at, recorded_by: priya, created_at: at });
    }
    const logs = [
      [-2, 'Column shuttering for ground floor slab completed; rebar inspection done by site engineer.', { mason: 4, helper: 6, carpenter: 3 }, 45],
      [-1, 'Slab reinforcement tied; electrical conduits laid; cube samples prepared.', { mason: 3, helper: 7, bar_bender: 2, electrician: 1 }, 55],
      [0, 'Ground floor slab concreting started (RMC M25). Curing plan set for 14 days.', { mason: 5, helper: 9, carpenter: 2 }, 60],
    ];
    for (const [d, work, labour, progress] of logs) insert('site_logs', { project_id: pid, user_id: suresh, log_date: addDays(istDate(), d), work_done: work, labour: JSON.stringify(labour), milestone_id: msIds[2], progress, lat: 26.90895, lng: 75.73425, distance_m: 6, client_visible: 1, created_at: addMinIso(at, d * 1440 - 60), device_time: addMinIso(at, d * 1440 - 60) });

    // Lead awaiting approval (Sunita, Hindi, Mansarovar)
    // The demo team is off on Sundays: use the next working day so the sample approval can be approved.
    let demoDay = addDays(istDate(), 1); if (dayOfWeek(demoDay) === 0) demoDay = addDays(demoDay, 1);
    const slot = fromIst(demoDay, '12:00').toISOString();
    const leadB = insert('leads', { ref: nextRef('NS-JPR'), contact_id: sunita.id, source: 'whatsapp', status: 'awaiting_approval', name: 'Sunita Agarwal', phone: sunita.wa_id, zone: 'mansarovar', locality: 'Shipra Path', address: 'Near Shipra Path, Mansarovar', site_lat: 26.8530, site_lng: 75.7690, location_source: 'pin', services: JSON.stringify(['interiors']), project_nature: 'apartment_interior', area_sqft: 1450, area_text: '1450 sq ft', execution_window: 'within_15_days', preferred_slots: JSON.stringify([slot]), requirements: '3 BHK flat — modular kitchen and wardrobes', consent: 1, created_at: addMinIso(at, -25), updated_at: addMinIso(at, -20), submitted_at: addMinIso(at, -20), first_response_at: addMinIso(at, -20) });
    insert('approvals', { kind: 'lead_assignment', entity_type: 'lead', entity_id: leadB, title: `Approve visit · ${one('SELECT ref FROM leads WHERE id=?', leadB).ref} · Sunita Agarwal`, summary: 'Interiors · Flat interior · 1,450 sq ft · Shipra Path, Mansarovar', data: '{}', status: 'pending', requested_by: 'system', due_at: addMinIso(at, 10), created_at: addMinIso(at, -20) });

    // Confirmed visit tomorrow (Rohit, Ajmer Road) with Rahul
    const vStart = fromIst(demoDay, '15:00'); const vEnd = new Date(vStart.getTime() + 3600e3);
    const leadC = insert('leads', { ref: nextRef('NS-JPR'), contact_id: rohit.id, source: 'website', status: 'visit_confirmed', name: 'Rohit Khandelwal', phone: rohit.wa_id, zone: 'ajmer_rd', locality: 'Bhankrota', address: 'Shri Ram Nagar, Bhankrota', site_lat: 26.8781, site_lng: 75.6747, location_source: 'pin', services: JSON.stringify(['turnkey', 'architecture']), project_nature: 'new_build', area_sqft: 1800, area_text: '200 gaj', execution_window: 'within_15_days', preferred_slots: JSON.stringify([vStart.toISOString()]), consent: 1, created_at: addMinIso(at, -60 * 26), updated_at: at, submitted_at: addMinIso(at, -60 * 26), qualified_at: addMinIso(at, -60 * 25) });
    const hold = insert('calendar_holds', { user_id: rahul, start_at: vStart.toISOString(), end_at: vEnd.toISOString(), kind: 'visit', ref_type: 'visit', status: 'active', created_at: at });
    const offer = insert('visit_offers', { lead_id: leadC, architect_id: rahul, revision: 1, attempt: 1, slot_start: vStart.toISOString(), slot_end: vEnd.toISOString(), status: 'client_confirmed', hold_id: hold, created_by: 'auto', created_at: addMinIso(at, -60 * 25), updated_at: at });
    const vid = insert('visits', { ref: nextRef('NS-VIS'), lead_id: leadC, architect_id: rahul, offer_id: offer, hold_id: hold, revision: 1, start_at: vStart.toISOString(), end_at: vEnd.toISOString(), status: 'confirmed', created_at: addMinIso(at, -60 * 24), updated_at: at });
    run('UPDATE calendar_holds SET ref_id=? WHERE id=?', vid, hold);

    // Quote sent (Kavita, renovation, Malviya Nagar)
    const leadD = insert('leads', { ref: nextRef('NS-JPR'), contact_id: kavita.id, source: 'whatsapp', status: 'quote_sent', name: 'Kavita Sharma', phone: kavita.wa_id, zone: 'malviya', services: JSON.stringify(['renovation']), project_nature: 'repair', area_sqft: 1200, area_text: '1200 sq ft', execution_window: 'immediate', consent: 1, created_at: addMinIso(at, -60 * 24 * 6), updated_at: at, submitted_at: addMinIso(at, -60 * 24 * 6) });
    insert('quotations', { ref: nextRef('NS-QT'), lead_id: leadD, version: 1, service_type: 'renovation', commercial_model: 'with_material', items: JSON.stringify([{ desc: 'Terrace waterproofing (APP membrane + screed)', qty: 1200, unit: 'sq ft', rate: 95, amount: 114000 }, { desc: 'Wall seepage treatment & repaint (2 rooms)', qty: 1, unit: 'lot', rate: 38000, amount: 38000 }]), subtotal: 152000, gst_pct: 18, total: 179360, payment_schedule: JSON.stringify([{ name: 'Booking advance', pct: 20, site: false }, { name: 'Work stage 1', pct: 30, site: true }, { name: 'Work stage 2', pct: 30, site: true }, { name: 'Completion & handover', pct: 20, site: true }]), valid_until: addDays(istDate(), 9), status: 'sent', public_token: randomToken(18), created_at: addMinIso(at, -60 * 24 * 2), sent_at: addMinIso(at, -60 * 24 * 2), updated_at: at });

    // Attendance today: Suresh at site, Rahul at office (late), Vikram not yet
    const today = istDate();
    const ev = (uid, kind, hm, lat, lng, place, placeId, dist, reasons = []) => insert('attendance_events', { user_id: uid, kind, device_time: fromIst(today, hm).toISOString(), server_time: fromIst(today, hm).toISOString(), effective_time: fromIst(today, hm).toISOString(), lat, lng, accuracy_m: 18, place_type: place, place_id: placeId, place_name: place === 'project' ? 'Site' : 'Office', distance_m: dist, validation: 'accepted', reasons: JSON.stringify(reasons) });
    const nowMin = (() => { const d = now(); return d; })();
    if (fromIst(today, '09:05') < nowMin) ev(suresh, 'in', '08:52', 26.9090, 75.7343, 'project', pid, 14);
    if (fromIst(today, '09:40') < nowMin) ev(rahul, 'in', '09:32', 26.9498, 75.7381, 'office', null, 12, ['late']);
    for (const id of [suresh, rahul, vikram, mahesh, anjali]) recomputeDay(id, today);

    // Tasks
    const task = (title, assignee, due, priority = 'normal') => insert('tasks', { title, assignee_id: assignee, kind: 'general', priority, status: 'todo', due_at: due, created_by: 'demo', created_at: at, updated_at: at });
    task('Order 40 bags OPC 53 cement for GF slab curing week', suresh, addMinIso(at, 240), 'high');
    task('Upload revised 3D elevation for NS-PRJ site', rahul, addMinIso(at, 60 * 30));
    task('Monthly quality audit — Vaishali Nagar site', vikram, addMinIso(at, -120), 'high');
    return { ok: true, pin: DEMO_PIN, manager: 'priya@demo.local / demo1234', finance: 'neha@demo.local / demo1234' };
  });
}
