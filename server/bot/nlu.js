// Rule-based understanding (works with AI switched off). English, Hindi and
// Hinglish keywords; field parsers for area, zone, services, timeline.
import { SERVICES, NATURES, WINDOWS, JAIPUR_LOCALITIES } from './catalog.js';
import { isDevanagari } from '../lib/util.js';

const HINDI_DIGITS = '०१२३४५६७८९';
export const norm = (s) => String(s || '').toLowerCase().replace(/[’']/g, "'").replace(/[०-९]/g, (d) => HINDI_DIGITS.indexOf(d)).replace(/\s+/g, ' ').trim();
const has = (text, words) => words.some((w) => {
  if (/^[a-z0-9 +'-]+$/.test(w)) return new RegExp(`(^|[^a-z0-9])${w.replace(/[+]/g, '\\+')}([^a-z0-9]|$)`).test(text);
  return text.includes(w);
});

const KW = {
  greeting: ['hi', 'hii', 'hello', 'hey', 'helo', 'namaste', 'namaskar', 'ram ram', 'jai shree ram', 'good morning', 'good evening', 'नमस्ते', 'नमस्कार', 'राम राम', 'हेलो'],
  menu: ['menu', 'options', 'start over', 'main menu', 'मेनू'],
  // Phrases that ask for a person in a sentence of any length.
  human: ['call me', 'call back', 'callback', 'talk to', 'talk with', 'speak to', 'speak with', 'connect me', 'customer care', 'customer support', 'real person', 'your manager', 'your team', 'your staff', 'your executive', 'someone from', 'baat karni', 'baat karo', 'baat kara', 'baat karwa', 'kisi se baat', 'koi insaan', 'phone karo', 'call karo', 'बात करनी', 'बात करें', 'बात करा', 'कॉल करें', 'फोन करो'],
  // Single words that only mean "give me a person" in a short message
  // ("agent please"), not inside "a house for a 4 person family" or "staff quarters".
  human_word: ['human', 'agent', 'person', 'staff', 'manager', 'executive', 'insaan', 'operator'],
  start: ['start', 'subscribe'],
  emergency: ['emergency', 'urgent help', 'accident', 'collapse', 'fire', 'आपात', 'इमरजेंसी'],
  status: ['status', 'update', 'progress', 'kitna hua', 'kaam kaha tak', 'kahan tak', 'स्थिति', 'अपडेट', 'प्रगति'],
  payment: ['payment', 'invoice', 'bill', 'paisa', 'paise', 'bhugtan', 'due', 'amount', 'भुगतान', 'बिल'],
  complaint: ['complaint', 'problem', 'issue', 'shikayat', 'galat', 'kharab', 'not happy', 'शिकायत', 'समस्या', 'खराब'],
  job: ['job', 'naukri', 'vacancy', 'hiring', 'kaam chahiye', 'need work', 'resume', 'cv', 'नौकरी'],
  vendor: ['supplier', 'vendor', 'dealer', 'distributor', 'partnership', 'collaborate', 'sell you', 'सप्लायर'],
  yes: ['yes', 'yeah', 'yep', 'ok', 'okay', 'haan', 'han', 'ha', 'ji', 'ji haan', 'theek', 'thik', 'sahi', 'correct', 'confirm', 'done', 'sure', 'हाँ', 'हां', 'जी', 'ठीक', 'सही'],
  no: ['no', 'nahi', 'nahin', 'nope', 'cancel', 'नहीं', 'ना'],
  skip: ['skip', 'not sure', 'pata nahi', "don't know", 'dont know', 'nahi pata', 'पता नहीं', 'skip karo'],
  hindi: ['hindi', 'हिंदी', 'हिन्दी'],
  english: ['english', 'angrezi', 'अंग्रेज़ी'],
  visit: ['visit', 'site visit', 'book visit', 'appointment', 'meeting', 'विज़िट', 'मीटिंग'],
  thanks: ['thanks', 'thank you', 'thank u', 'thx', 'dhanyavad', 'shukriya', 'धन्यवाद', 'शुक्रिया'],
  existing: ['my project', 'existing project', 'mera project', 'already', 'ongoing', 'मेरा प्रोजेक्ट'],
};

// Unsubscribing must be the whole message ("STOP", "please stop messages", "band karo").
// "Stop work" or "kaam band karo" is an instruction about the site, never an opt-out.
const OPT_OUT = [
  /^(?:please |pls |plz |kindly )?(?:stop|unsubscribe|opt ?out)(?: (?:it|this|now|please|pls|all|sending|messaging|messages?|msgs?|sms|updates?|notifications?|whatsapp|me))*$/,
  /^(?:(?:messages?|msgs?|sms|updates?) )?(?:band karo|band kar do|mat bhejo|bhejna band karo)(?: please)?$/,
  /^(?:(?:मैसेज|संदेश|अपडेट) )?(?:बंद करो|बंद कर दो|मत भेजो)$/,
];
const STOP_WORD = '(?:stop|stopped|halt|pause|hold|band|rok|roko|rokna|rukwa|ruk)';
const WORK_WORD = '(?:work|working|kaam|kam|construction|site|project|labour|labor)';
const STOP_WORK = [new RegExp(`(^|[^a-z])${STOP_WORD}([^a-z].*)?[^a-z]${WORK_WORD}([^a-z]|$)`), new RegExp(`(^|[^a-z])${WORK_WORD}([^a-z].*)?[^a-z]${STOP_WORD}([^a-z]|$)`), /काम\s*(बंद|रोक|रुकवा)/, /(बंद|रोक)\s*.*काम/];
// "fire" inside a service phrase is an enquiry, not an emergency.
const FIRE_SERVICE = /(^|[^a-z])fire[ -]?(safety|fighting|fight|exit|noc|alarm|proof|proofing|extinguishers?|sprinklers?|doors?|rated|rating|systems?|audit|hydrants?|escape|norms?|compliance|retardant|resistant|place|bricks?|work)([^a-z]|$)/;
// "staff quarters", "manager cabin", "4 person family" describe the building, not a wish to talk to someone.
const HUMAN_NOUN = /(^|[^a-z])(staff|servant|manager|executive|agent|operator)s?'?s? (quarters?|rooms?|cabins?|office|toilets?|washrooms?|kitchen|area|housing|accommodation|colony|block)([^a-z]|$)|\d+ ?(person|persons|people|member|members)([^a-z]|$)|(^|[^a-z])person(s)? (family|house|home|flat)([^a-z]|$)/;
// "free fire" is a game; children message business numbers about it.
const NOT_FIRE = /(^|[^a-z])(free|garena) ?fire([^a-z]|$)/;
const plain = (text) => norm(text).replace(/[.,!?।:;()"]+/g, ' ').replace(/\s+/g, ' ').trim();

export function detectIntents(text) {
  const n = norm(text);
  const p = plain(text);
  const count = p ? p.split(' ').length : 0;
  const out = new Set();
  for (const [k, words] of Object.entries(KW)) if (has(n, words)) out.add(k);
  if (OPT_OUT.some((re) => re.test(p))) out.add('stop');
  else if (STOP_WORK.some((re) => re.test(p))) out.add('stop_work');
  if (out.has('human_word')) { out.delete('human_word'); if (count <= 4 && !HUMAN_NOUN.test(p)) out.add('human'); }
  if (out.has('emergency') && (FIRE_SERVICE.test(p) || NOT_FIRE.test(p)) && !has(n, KW.emergency.filter((w) => w !== 'fire'))) out.delete('emergency');
  // "start", "yes" and "no" only count as commands when the message is short
  if (count > 3) { out.delete('start'); out.delete('yes'); out.delete('no'); }
  if (/ns-prj-\d{4}-\d+/i.test(text)) out.add('project_ref');
  return out;
}

export function detectLanguage(text, current = 'en') {
  if (isDevanagari(text)) return 'hi';
  return current;
}

export function extractServices(text) {
  const n = norm(text);
  let out = SERVICES.filter((s) => has(n, s.kw)).map((s) => s.code);
  // "interior design" means interiors, not architecture
  if (out.includes('interiors') && out.includes('architecture')) {
    const arch = SERVICES.find((s) => s.code === 'architecture');
    const hits = arch.kw.filter((w) => has(n, [w]));
    if (hits.every((w) => w === 'design' || w === 'डिज़ाइन' || w === 'डिजाइन')) out = out.filter((c) => c !== 'architecture');
  }
  // "construction material" is materials, not a turnkey house
  if (out.includes('materials') && out.includes('turnkey') && !/(house|home|ghar|makan|villa|मकान|घर)/.test(n)) out = out.filter((c) => c !== 'turnkey');
  return out;
}
export function extractNature(text) {
  const n = norm(text);
  const hit = NATURES.find((x) => x.kw.length && has(n, x.kw));
  return hit ? hit.code : null;
}
export function extractWindow(text) {
  const n = norm(text);
  const hit = WINDOWS.find((x) => has(n, x.kw));
  return hit ? hit.code : null;
}
export function extractZone(text, zones) {
  const n = norm(text);
  for (const z of zones) {
    const words = [norm(z.name), ...(z.kw || [])].filter(Boolean);
    if (words.some((w) => n.includes(w))) return { zone: z.code, locality: null };
  }
  if (JAIPUR_LOCALITIES.some((l) => n.includes(l))) return { zone: 'other_jaipur', locality: text.trim().slice(0, 120) };
  return null;
}
export function looksOutsideJaipur(text) {
  const n = norm(text);
  if (JAIPUR_LOCALITIES.some((l) => n.includes(l))) return false;
  return /(ajmer|jodhpur|udaipur|kota|bikaner|alwar|sikar|delhi|gurgaon|gurugram|noida|mumbai|ahmedabad|tonk|bhilwara|chittorgarh|अजमेर|जोधपुर|उदयपुर|कोटा|दिल्ली)/.test(n) && !/(ajmer road|tonk road|sikar road|delhi road)/.test(n);
}

/** Area in sq ft from "1200 sqft", "150 gaj", "30x40", "100 sq yd", "120 sqm". */
export function parseArea(text) {
  const n = norm(text).replace(/,/g, '');
  const dims = /(\d{1,3}(?:\.\d+)?)\s*(?:x|\*|×|by|बाय)\s*(\d{1,3}(?:\.\d+)?)/.exec(n);
  if (dims) {
    const a = Number(dims[1]) * Number(dims[2]);
    if (a >= 100 && a <= 200000) return { sqft: Math.round(a), text: `${dims[1]}x${dims[2]} ft` };
  }
  // Every number is considered. A clear area unit wins ("3 bhk, 1400 sqft" is 1,400 sq ft, not 3);
  // plain "feet" counts unless it describes a road or a length ("200 feet bypass", "40 ft wide");
  // a bare number counts only when nothing better is found and it is a believable area.
  const re = /(\d+(?:\.\d+)?)\s*(sq\.?\s*ft|sqft|sft|square feet|feet|ft|वर्ग फीट|फीट|gaj|gaz|गज|sq\.?\s*yd|sq\.?\s*yards?|yards?|sqyd|sq\.?\s*m|sqm|square meter|square metre|मीटर)?/g;
  const LENGTH_WORD = /^\s*(road|rd|bypass|by pass|wide|width|chaud|sadak|रोड|सड़क|front|frontage|height|high|long|lamba|gali|lane)/;
  let feet = null; let bare = null;
  for (const num of n.matchAll(re)) {
    const v = Number(num[1]);
    const unit = num[2] || '';
    if (!unit) { if (!bare && v >= 100 && v <= 100000) bare = { sqft: Math.round(v), text: `${num[1]} sq ft` }; continue; }
    let sqft = v;
    if (/gaj|gaz|गज|yd|yard/.test(unit)) sqft = v * 9;
    else if (/sq\.?\s*m|sqm|meter|metre|मीटर/.test(unit)) sqft = v * 10.764;
    if (sqft < 100 || sqft > 500000) continue;
    const found = { sqft: Math.round(sqft), text: `${num[1]} ${unit}`.trim() };
    if (/^(feet|ft|फीट)$/.test(unit)) { if (!feet && !LENGTH_WORD.test(n.slice(num.index + num[0].length))) feet = found; continue; }
    return found;
  }
  return feet || bare;
}

export function cleanName(text) {
  let s = String(text || '').trim();
  s = s.replace(/^(my name is|i am|i'm|this is|name is|mera naam|मेरा नाम|naam)\s*/i, '').replace(/\s*(hai|है|here)\.?$/i, '');
  s = s.replace(/[^\p{L}\p{M}\s.'-]/gu, '').replace(/\s+/g, ' ').trim();
  if (s.length < 2 || s.length > 60) return null;
  if (s.split(' ').length > 5) return null;
  return s.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
}

export function matchFaq(text, faqs) {
  const n = norm(text);
  let best = null; let bestScore = 0;
  for (const f of faqs) {
    const kws = String(f.keywords || '').split(',').map((k) => norm(k)).filter(Boolean);
    const score = kws.filter((k) => n.includes(k)).length;
    if (score > bestScore) { best = f; bestScore = score; }
  }
  return bestScore > 0 ? best : null;
}

export function extractProjectRef(text) { const m = /ns-prj-\d{4}-\d+/i.exec(text || ''); return m ? m[0].toUpperCase() : null; }
