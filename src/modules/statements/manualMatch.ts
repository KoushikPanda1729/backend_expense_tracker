import { ParsedTxn } from './sbi.parser';

export interface ManualRow {
  id: string;
  txn_date: string;
  merchant: string;
  category: string;
  amount: number;
  is_income: boolean;
  note: string | null;
  label: string | null;
}

export interface ManualMatch {
  manual: ManualRow;
  bank: ParsedTxn;
  /** 0 = same date, 1 = one day apart (the bank books late-night payments on the next day) */
  daysApart: number;
}

const DAY = 86_400_000;
const daysBetween = (a: string, b: string) => Math.round(Math.abs(Date.parse(a) - Date.parse(b)) / DAY);

/**
 * Pure: which entries the user added by hand look like rows of a statement being imported.
 * Same amount and direction, and the same date or one day apart. Each side is used at most once, and
 * same-date pairs are made first so a near match never steals a better one.
 * These are only suggestions: the user accepts or rejects each one.
 */
export function findManualMatches(bankRows: ParsedTxn[], manual: ManualRow[]): ManualMatch[] {
  const usedManual = new Set<string>();
  const usedBank = new Set<ParsedTxn>();
  const out: ManualMatch[] = [];
  for (const maxDays of [0, 1]) {
    for (const b of bankRows) {
      if (usedBank.has(b)) continue;
      let best: ManualRow | undefined;
      let bestDiff = Infinity;
      for (const m of manual) {
        if (usedManual.has(m.id) || m.is_income !== b.isIncome || Math.abs(m.amount - b.amount) > 0.004) continue;
        const d = daysBetween(m.txn_date, b.date);
        if (d <= maxDays && d < bestDiff) {
          best = m;
          bestDiff = d;
        }
      }
      if (best) {
        usedManual.add(best.id);
        usedBank.add(b);
        out.push({ manual: best, bank: b, daysApart: bestDiff });
      }
    }
  }
  return out.sort((a, b) => a.bank.date.localeCompare(b.bank.date));
}
