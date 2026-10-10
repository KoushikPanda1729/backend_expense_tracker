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
  description: string; // what the bank printed
  upiId: string | null; // UPI id or phone number of the other side
  bank: string | null; // bank code of the other side (SBIN, CNRB, ...)
  dedupeKey: string;
}

export interface ParsedStatement {
  txns: ParsedTxn[]; // oldest first
  opening: number;
  /** "Balance as on 09-10-2026 : 2494.86" from the statement header: the real balance on the download day. */
  asOf: { date: string; amount: number } | null;
}

// the two dates of a row are on one line: [ \t] (not \s) so a date at the end of a header line is never taken as a row start
const START = /(\d\d)\/(\d\d)\/(\d{4})[ \t]+\d\d\/\d\d\/\d{4}\s+/g;
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

/** No reference number: the first row keeps the plain key, an identical second one gets #2 and so on. */
function fallbackKey(seen: Map<string, number>, base: string): string {
  const n = (seen.get(base) ?? 0) + 1;
  seen.set(base, n);
  return n === 1 ? base : `${base}#${n}`;
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
  const repeats = new Map<string, number>(); // identical rows without a reference number on one day

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
    // some rows print no description at all
    let merchant = name ?? (raw ? merchantOf(raw) : isIncome ? 'Bank credit' : 'Bank debit');
    // UPI/DRC/<ref>/... is a refund: it has no shop name, so borrow it from the payment with the same reference
    if (raw.startsWith('UPI/DRC/')) {
      const paid = ref ? txns.find((t) => t.ref === ref && !t.isIncome) : undefined;
      merchant = paid ? `Refund: ${paid.merchant}` : 'Refund';
    }
    // UPI/DR/<ref>/<name>/<bank>/<upi id>/<note>: the PDF wraps long ids, so spaces are dropped from the id
    const parts = raw.split('/');
    const isUpi = /^UPI\/(DR|CR)\//.test(raw);
    const upiId = isUpi && parts[5] ? parts[5].replace(/\s+/g, '').slice(0, 60) : null;
    const bank = isUpi && parts[4] ? parts[4].replace(/\s+/g, '').toUpperCase().slice(0, 10) : null;
    txns.push({
      date,
      amount,
      balance,
      isIncome,
      merchant,
      mode: (raw.split(/[/*]/)[0] || 'Bank').slice(0, 20),
      category,
      ref,
      description: raw.slice(0, 300),
      upiId: upiId || null,
      bank: bank || null,
      // direction is part of the key: a payment and its reversal share one bank reference
      dedupeKey: ref ? `r:${ref}:${isIncome ? 'i' : 'e'}` : fallbackKey(repeats, `${date}|${amount}|${isIncome}|${merchant}`),
    });
  }

  if (txns.length === 0) return null;
  const first = txns[0]!;
  const opening = round2(first.balance - (first.isIncome ? first.amount : -first.amount));
  const h = /Balance\s*as\s*on\s*(\d\d)-(\d\d)-(\d{4})\s*:\s*(-?[\d,]+\.\d\d)/i.exec(text);
  const asOf = h ? { date: `${h[3]}-${h[2]}-${h[1]}`, amount: round2(num(h[4]!)) } : null;
  return { txns, opening, asOf };
}
