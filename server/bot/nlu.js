// Rule-based understanding (works with AI switched off). English, Hindi and
// Hinglish keywords; field parsers for area, zone, services, timeline.
import { SERVICES, NATURES, WINDOWS, JAIPUR_LOCALITIES } from './catalog.js';
import { isDevanagari } from '../lib/util.js';

export const norm = (s) => String(s || '').toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();
const has = (text, words) => words.some((w) => {
  if (/^[a-z0-9 +'-]+$/.test(w)) return new RegExp(`(^|[^a-z0-9])${w.replace(/[+]/g, '\\+')}([^a-z0-9]|$)`).test(text);
  return text.includes(w);
});

const KW = {
  greeting: ['hi', 'hii', 'hello', 'hey', 'helo', 'namaste', 'namaskar', 'ram ram', 'jai shree ram', 'good morning', 'good evening', 'नमस्ते', 'नमस्कार', 'राम राम', 'हेलो'],
  menu: ['menu', 'options', 'start over', 'main menu', 'मेनू'],
  human: ['human', 'agent', 'person', 'staff', 'call me', 'call back', 'callback', 'talk to', 'speak to', 'baat karni', 'baat karo', 'baat kara', 'phone karo', 'call karo', 'manager', 'executive', 'insaan', 'बात करनी', 'बात करें', 'कॉल करें', 'फोन करो'],
  stop: ['stop', 'unsubscribe', 'band karo', 'mat bhejo', 'बंद करो', 'मत भेजो'],
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

export function detectIntents(text) {
  const n = norm(text);
  const out = new Set();
  for (const [k, words] of Object.entries(KW)) if (has(n, words)) out.add(k);
  // "stop"/"start" only count as commands when the message is short
  if (n.split(' ').length > 3) { out.delete('stop'); out.delete('start'); out.delete('yes'); out.delete('no'); }
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
  const num = /(\d+(?:\.\d+)?)\s*(sq\.?\s*ft|sqft|sft|square feet|feet|ft|वर्ग फीट|फीट|gaj|gaz|गज|sq\.?\s*yd|sq\.?\s*yards?|yards?|sqyd|sq\.?\s*m|sqm|square meter|square metre|मीटर)?/.exec(n);
  if (!num) return null;
  const v = Number(num[1]);
  const unit = num[2] || '';
  let sqft = v;
  if (/gaj|gaz|गज|yd|yard/.test(unit)) sqft = v * 9;
  else if (/sq\.?\s*m|sqm|meter|metre|मीटर/.test(unit)) sqft = v * 10.764;
  else if (!unit && v < 100) return null;
  if (sqft < 100 || sqft > 500000) return null;
  return { sqft: Math.round(sqft), text: `${num[1]} ${unit || 'sq ft'}`.trim() };
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
