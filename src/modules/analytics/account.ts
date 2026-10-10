export interface StatementRow {
  period_start: string;
  period_end: string;
  opening_balance: number | null;
  closing_balance: number | null;
  balance_asof_date: string | null;
  balance_asof: number | null;
}
export interface SignedTxn {
  txn_date: string;
  signed: number; // + income, - expense
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const sum = (t: SignedTxn[], after: string | null, upTo: string | null) =>
  t
    .filter((x) => (after === null || x.txn_date > after) && (upTo === null || x.txn_date <= upTo))
    .reduce((a, x) => a + x.signed, 0);

/**
 * The real balance of the account, from the statements.
 * SBI prints "Balance as on <date>" in the header: that is the balance on the download day, so it wins over
 * the closing balance of the period. Transactions after that date (manual entries, later imports) are added.
 * - untracked: money that moved between the end of the last statement and the header date, which no imported
 *   transaction explains (the user has not imported that part yet)
 * - gaps: where a statement does not start from the previous one's closing balance (a month is missing)
 */
export function buildAccount(statements: StatementRow[], txns: SignedTxn[], userOpening: number) {
  if (statements.length === 0) {
    const last = txns.reduce<string | null>((m, t) => (m === null || t.txn_date > m ? t.txn_date : m), null);
    return {
      balance: round2(userOpening + sum(txns, null, null)),
      asOf: last,
      source: 'computed' as const,
      untracked: null,
      gaps: [],
      coverage: null,
      statementCount: 0,
    };
  }

  const byEnd = [...statements].sort((a, b) => a.period_end.localeCompare(b.period_end));
  const latest = byEnd[byEnd.length - 1]!;
  const closing = latest.closing_balance ?? 0;

  let anchorDate = latest.period_end;
  let anchorAmount = closing;
  let source: 'statement-header' | 'statement-closing' = 'statement-closing';
  let untracked: { amount: number; from: string; to: string } | null = null;
  if (latest.balance_asof !== null && latest.balance_asof_date !== null && latest.balance_asof_date >= latest.period_end) {
    anchorDate = latest.balance_asof_date;
    anchorAmount = latest.balance_asof;
    source = 'statement-header';
    const expected = closing + sum(txns, latest.period_end, anchorDate);
    const diff = round2(anchorAmount - expected);
    if (Math.abs(diff) >= 0.01) untracked = { amount: diff, from: latest.period_end, to: anchorDate };
  }

  const byStart = [...statements].sort((a, b) => a.period_start.localeCompare(b.period_start));
  const gaps: { from: string; to: string; difference: number }[] = [];
  for (let i = 1; i < byStart.length; i++) {
    const prev = byStart[i - 1]!;
    const next = byStart[i]!;
    if (prev.closing_balance === null || next.opening_balance === null) continue;
    const diff = round2(next.opening_balance - prev.closing_balance);
    if (Math.abs(diff) >= 0.01) gaps.push({ from: prev.period_end, to: next.period_start, difference: diff });
  }

  return {
    balance: round2(anchorAmount + sum(txns, anchorDate, null)),
    asOf: anchorDate,
    source,
    untracked,
    gaps,
    coverage: { from: byStart[0]!.period_start, to: latest.period_end },
    statementCount: statements.length,
  };
}
