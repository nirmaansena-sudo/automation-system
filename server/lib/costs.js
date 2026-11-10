import { all, one, insert, update, run, tx } from '../db/index.js';
import { istDate, fromIst, nowIso, jparse } from './util.js';
import { config } from '../config.js';
import { audit } from '../core/base.js';

const RATE_KEYS = ['service', 'utility', 'marketing', 'authentication', 'unknown', 'ai_call', 'transcription'];
export function readCostPolicy() {
  const saved = jparse(one("SELECT value FROM settings WHERE key='cost_policy'")?.value, {});
  return { currency: 'INR', monthlyBudget: saved.monthlyBudget ?? null, fixedMonthlyCost: saved.fixedMonthlyCost ?? null,
    aiDailyLimit: saved.aiDailyLimit ?? 200, transcriptionDailyLimit: saved.transcriptionDailyLimit ?? 25,
    rates: Object.fromEntries(RATE_KEYS.map((key) => [key, saved.rates?.[key] ?? null])) };
}
export function saveCostPolicy(data, actor) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Cost settings must be an object');
  if (data.rates !== undefined && (!data.rates || typeof data.rates !== 'object' || Array.isArray(data.rates))) throw new Error('Rates must be an object');
  const policy = readCostPolicy();
  const parseCost = (value) => {
    if (value === null || (typeof value === 'string' && !value.trim())) return null;
    if (!['number', 'string'].includes(typeof value)) throw new Error('Rates and budgets must be numeric amounts');
    const n = Number(value);
    if (typeof value === 'boolean' || !Number.isFinite(n) || n < 0 || n > 100000000) throw new Error('Rates and budgets must be nonnegative finite amounts');
    return n;
  };
  for (const key of ['monthlyBudget', 'fixedMonthlyCost']) if (data[key] !== undefined) policy[key] = parseCost(data[key]);
  for (const key of RATE_KEYS) if (data.rates?.[key] !== undefined) policy.rates[key] = parseCost(data.rates[key]);
  for (const key of ['aiDailyLimit', 'transcriptionDailyLimit']) if (data[key] !== undefined) {
    if (actor.role !== 'owner') throw new Error('Only the owner can change compute limits');
    const value = data[key];
    if (!['number', 'string'].includes(typeof value) || (typeof value === 'string' && !value.trim())) throw new Error('Daily limits must be whole numbers');
    const n = Number(value); if (!Number.isInteger(n) || n < 0 || n > 100000) throw new Error('Daily limits must be whole numbers from 0 to 100000'); policy[key] = n;
  }
  return tx(() => {
    run("INSERT INTO settings(key,value,updated_at) VALUES ('cost_policy',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at", JSON.stringify(policy), nowIso());
    audit(`user:${actor.id}`, 'costs.policy', 'settings', null, policy);
    return policy;
  });
}
export function effectiveLimit(kind, hardLimit) {
  const policy = readCostPolicy(); const soft = kind === 'ai' ? policy.aiDailyLimit : policy.transcriptionDailyLimit;
  const cap = Number(hardLimit ?? (kind === 'ai' ? 200 : 25));
  return Math.max(0, Math.min(soft, Number.isFinite(cap) ? Math.floor(cap) : 0));
}
export function reserveCompute(kind, hardLimit, details = {}) {
  if (!['ai', 'transcription'].includes(kind)) throw new Error('Unknown compute type');
  return tx(() => {
    const day = istDate(); const limit = effectiveLimit(kind, hardLimit);
    const used = one('SELECT COUNT(*) n FROM compute_usage WHERE day=? AND kind=?', day, kind).n;
    if (used >= limit) return null;
    return insert('compute_usage', { kind, day, status: 'reserved', provider: details.provider || null, media_id: details.mediaId || null, created_at: nowIso() });
  });
}
export function finishCompute(id, status, durationMs) {
  if (id) update('compute_usage', id, { status: status === 'ok' ? 'ok' : 'failed', duration_ms: Math.max(0, Math.round(Number(durationMs) || 0)), completed_at: nowIso() });
}
export function monthBounds(month = istDate().slice(0, 7)) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('Month must be YYYY-MM');
  const [year, m] = month.split('-').map(Number);
  if (year < 2000 || year > 2100) throw new Error('Month is outside the supported range');
  const next = new Date(Date.UTC(year, m, 1)).toISOString().slice(0, 10);
  return { month, from: fromIst(`${month}-01`, '00:00').toISOString(), to: fromIst(next, '00:00').toISOString() };
}
export function usageReport(month) {
  const bounds = monthBounds(month); const { from, to } = bounds;
  const policy = readCostPolicy();
  const byCategory = all("SELECT CASE WHEN route='template' THEN COALESCE(category,'unknown') ELSE 'service' END cat, COUNT(*) n FROM messages WHERE direction='out' AND status IN ('sent','delivered','read') AND created_at>=? AND created_at<? GROUP BY cat", from, to);
  const byKind = all("SELECT kind,COUNT(*) n FROM outbox WHERE channel='whatsapp' AND status='sent' AND COALESCE(sent_at,created_at)>=? AND COALESCE(sent_at,created_at)<? GROUP BY kind ORDER BY n DESC LIMIT 20", from, to);
  const compute = all('SELECT kind,status,COUNT(*) n FROM compute_usage WHERE created_at>=? AND created_at<? GROUP BY kind,status', from, to);
  const lines = byCategory.map((row) => ({ key: row.cat, label: `WhatsApp ${row.cat}`, count: row.n, rate: policy.rates[row.cat] ?? null }));
  for (const [kind, key] of [['ai', 'ai_call'], ['transcription', 'transcription']]) lines.push({ key, label: kind === 'ai' ? 'AI understanding attempts' : 'Voice transcription attempts', count: compute.filter((row) => row.kind === kind).reduce((n, row) => n + row.n, 0), rate: policy.rates[key] });
  let estimate = policy.fixedMonthlyCost || 0; let unpriced = 0;
  for (const line of lines) { line.estimate = line.rate === null ? null : Math.round(line.count * line.rate * 100) / 100; if (line.rate === null) unpriced += line.count; else estimate += line.estimate; }
  estimate = Math.round(estimate * 100) / 100;
  const today = istDate();
  return { ...bounds, byCategory, byKind, inbound: one("SELECT COUNT(*) n FROM messages WHERE direction='in' AND created_at>=? AND created_at<?", from, to).n,
    policy, lines, compute, knownEstimate: estimate, unpricedEvents: unpriced, completeEstimate: unpriced === 0 && policy.fixedMonthlyCost !== null,
    budgetExceeded: policy.monthlyBudget !== null && estimate > policy.monthlyBudget,
    today: { day: today, ai: one("SELECT COUNT(*) n FROM compute_usage WHERE day=? AND kind='ai'", today).n, transcription: one("SELECT COUNT(*) n FROM compute_usage WHERE day=? AND kind='transcription'", today).n,
      aiLimit: effectiveLimit('ai', config.ai.dailyLimit), transcriptionLimit: effectiveLimit('transcription', config.transcription?.dailyLimit) } };
}
