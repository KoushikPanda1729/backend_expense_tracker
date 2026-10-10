export interface ReviewRow {
  id: string;
  txn_date: string;
  merchant: string;
  mode: string;
  category: string;
  amount: number;
  is_income: boolean;
  ref: string | null;
  description: string | null;
  upi_id: string | null;
  bank: string | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const key = (m: string) => m.trim().toLowerCase();
// a UPI id that is a mobile number (Indian mobiles start with 6-9; other 10-digit ids are account numbers)
const phoneOf = (upi: string | null) => (upi && /^[6-9]\d{9}$/.test(upi) ? upi : null);

const AUTO_DEBIT = /^(ach|nach|ecs|mandate|si\b)/i;
const CHARGE = /charge|chrg|\bsms\b|\bamc\b|\bgst\b|penalt|\bfee\b|annual/i;
const LARGE = 2000; // ponytail: fixed threshold; make it a setting or relative to the user's usual spend if needed

/**
 * Pure: what to look at in the user's transactions.
 * - unknownPayees: people / shops the bank only gave a short name for and the user has not labelled
 * - flagged: single payments worth a look (auto-debit, bank charge, large to an unknown payee, paid twice in a day)
 * `known` is the set of payee keys the user already labelled; they never show up as unknown.
 */
export function buildReview(rows: ReviewRow[], known: Set<string>) {
  const isKnown = (r: ReviewRow) => known.has(key(r.merchant));

  // ---- unknown payees (people), with what was sent and received
  const hasUnknownOut = new Set(
    rows.filter((r) => !r.is_income && r.category === 'Transfer' && !isKnown(r)).map((r) => key(r.merchant)),
  );
  const people = new Map<
    string,
    { merchant: string; sent: number; received: number; sentCount: number; receivedCount: number; first: string; last: string; upiId: string | null; bank: string | null }
  >();
  for (const r of rows) {
    const k = key(r.merchant);
    if (!hasUnknownOut.has(k)) continue;
    const p = people.get(k) ?? {
      merchant: r.merchant, sent: 0, received: 0, sentCount: 0, receivedCount: 0,
      first: r.txn_date, last: r.txn_date, upiId: null, bank: null,
    };
    if (r.is_income) { p.received += r.amount; p.receivedCount++; } else { p.sent += r.amount; p.sentCount++; }
    if (r.txn_date < p.first) p.first = r.txn_date;
    if (r.txn_date > p.last) p.last = r.txn_date;
    p.upiId = r.upi_id ?? p.upiId;
    p.bank = r.bank ?? p.bank;
    people.set(k, p);
  }
  const unknownPayees = [...people.values()]
    .map((p) => ({
      ...p,
      sent: round2(p.sent),
      received: round2(p.received),
      net: round2(p.received - p.sent),
      phone: phoneOf(p.upiId),
    }))
    .sort((a, b) => b.sent - a.sent);

  // ---- single payments worth a look
  const reasons = new Map<string, string[]>();
  const flag = (r: ReviewRow, why: string) => reasons.set(r.id, [...(reasons.get(r.id) ?? []), why]);

  const twice = new Map<string, ReviewRow[]>();
  for (const r of rows) {
    if (r.is_income || isKnown(r)) continue; // labelled by the user = explained
    const text = r.description ?? r.mode;
    if (AUTO_DEBIT.test(text)) flag(r, 'Auto-debit');
    if (!/^UPI\//i.test(r.description ?? '') && CHARGE.test(`${r.description ?? ''} ${r.merchant}`)) flag(r, 'Bank charge');
    if (r.category === 'Transfer' || r.category === 'Shopping') {
      if (r.amount >= LARGE) flag(r, 'Large payment');
      const k = `${r.txn_date}|${key(r.merchant)}|${r.amount}`;
      twice.set(k, [...(twice.get(k) ?? []), r]);
    }
  }
  for (const group of twice.values()) if (group.length > 1) group.forEach((r) => flag(r, 'Paid twice the same day'));

  const flagged = rows
    .filter((r) => reasons.has(r.id))
    .map((r) => ({
      id: r.id,
      date: r.txn_date,
      merchant: r.merchant,
      amount: r.amount,
      category: r.category,
      reasons: reasons.get(r.id)!,
      upiId: r.upi_id,
      phone: phoneOf(r.upi_id),
      bank: r.bank,
      ref: r.ref,
      description: r.description,
    }))
    .sort((a, b) => b.amount - a.amount);

  return {
    unknownPayees: unknownPayees.slice(0, 100),
    flagged: flagged.slice(0, 100),
    totals: {
      unknownSent: round2(unknownPayees.reduce((a, p) => a + p.sent, 0)),
      flaggedAmount: round2(flagged.reduce((a, f) => a + f.amount, 0)),
    },
  };
}
