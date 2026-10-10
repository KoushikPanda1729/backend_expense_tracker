import { Category, classify } from '../../lib/categories';

export interface ParsedTxn {
  date: string; // YYYY-MM-DD
  amount: number;
  balance: number;
  isIncome: boolean;
  merchant: string;
  mode: string; // UPI | IMPS | NEFT | ...
  category: Category;
  ref: string | null;
  dedupeKey: string;
}

export interface ParsedStatement {
  txns: ParsedTxn[]; // oldest first
  opening: number;
}

const START = /(\d\d)\/(\d\d)\/(\d{4})\s+\d\d\/\d\d\/\d{4}\s+/g;
const MONEY = /([\d,]+\.\d\d)\s+([\d,]+\.\d\d)/;
const num = (s: string) => parseFloat(s.replace(/,/g, ''));
const round2 = (n: number) => Math.round(n * 100) / 100;

function merchantOf(raw: string): string {
  const p = raw.split('/');
  let m: string;
  if (raw.startsWith('UPI') && p.length > 3) m = p[3]!;
  else if (raw.includes('*')) m = raw.split('*').pop()!;
  else m = p.length > 2 ? p[p.length - 1]! : raw;
  m = m.trim();
  return (m || 'Unknown').slice(0, 120);
}

function refOf(raw: string): string | null {
  const p = raw.split(/[/*]/);
  return p.length > 2 && /^\w{8,}$/.test(p[2]!) ? p[2]! : null;
}

/**
 * Parses the text of an SBI account statement PDF.
 * Rows look like `01/01/2026 01/01/2026 <description> <amount> <balance>`.
 * Debit vs credit comes from the change in balance, so the column layout does not matter.
 * ponytail: SBI layout only. Add one parser per bank if you switch banks.
 */
export function parseSbiText(text: string): ParsedStatement | null {
  const starts = [...text.matchAll(START)];
  const txns: ParsedTxn[] = [];
  let prev: number | null = null;

  for (let i = 0; i < starts.length; i++) {
    const m = starts[i]!;
    const from = m.index! + m[0].length;
    const to = i + 1 < starts.length ? starts[i + 1]!.index! : text.length;
    const seg = text.slice(from, to);

    const money = MONEY.exec(seg);
    if (!money) continue; // page header/footer noise

    const raw = seg.slice(0, money.index).replace(/\s+/g, ' ').trim();
    const amount = round2(num(money[1]!));
    const balance = round2(num(money[2]!));
    const isIncome = prev !== null ? Math.abs(prev + amount - balance) < 0.02 : raw.includes('/CR/');
    prev = balance;

    const date = `${m[3]}-${m[2]}-${m[1]}`;
    const ref = refOf(raw);
    const { category, name } = classify(raw, isIncome);
    let merchant = name ?? merchantOf(raw);
    // UPI/DRC/<ref>/... is a refund: it has no shop name, so borrow it from the payment with the same reference
    if (raw.startsWith('UPI/DRC/')) {
      const paid = ref ? txns.find((t) => t.ref === ref && !t.isIncome) : undefined;
      merchant = paid ? `Refund: ${paid.merchant}` : 'Refund';
    }
    txns.push({
      date,
      amount,
      balance,
      isIncome,
      merchant,
      mode: (raw.split(/[/*]/)[0] || 'Bank').slice(0, 20),
      category,
      ref,
      // direction is part of the key: a payment and its reversal share one bank reference
      dedupeKey: ref ? `r:${ref}:${isIncome ? 'i' : 'e'}` : `${date}|${amount}|${isIncome}|${merchant}`,
    });
  }

  if (txns.length === 0) return null;
  const first = txns[0]!;
  const opening = round2(first.balance - (first.isIncome ? first.amount : -first.amount));
  return { txns, opening };
}
