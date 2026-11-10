// Monetary input is validated and calculated in integer paise; DB values remain rupees.
export function paise(value, { min = 0, max = 100000000000 } = {}) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') throw new Error('Enter a valid amount');
  const n = Number(value);
  const p = Math.round(n * 100);
  if (!Number.isFinite(n) || !Number.isSafeInteger(p) || n < min || n > max || Math.abs(n * 100 - p) > 0.00001) throw new Error('Amount must be within range and have at most two decimal places');
  return p;
}
export const rupees = (p) => p / 100;
export function allocateAmounts(total, schedule) {
  if (!Array.isArray(schedule) || !schedule.length || schedule.some((m) => !Number.isFinite(Number(m.pct)) || Number(m.pct) < 0 || Number(m.pct) > 100) || schedule.reduce((n, m) => n + Math.round(Number(m.pct) * 100), 0) !== 10000) throw new Error('Payment schedule must total exactly 100%');
  const cents = paise(total);
  let assigned = 0;
  return schedule.map((m, i) => {
    const amount = i === schedule.length - 1 ? cents - assigned : Math.floor(cents * Number(m.pct) / 100);
    assigned += amount;
    return rupees(amount);
  });
}
