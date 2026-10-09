import { describe, expect, it } from 'vitest';
import { parseSbiText } from '../src/modules/statements/sbi.parser';

// Text shaped like the PDF extraction: descriptions wrap over lines, and the page
// footer is glued to the last row of a page.
const SAMPLE = `
Statementof Mr.TEST between01/01/2026to31/03/2026
TxnDate ValueDate Description Debit Credit Balance
01/01/2026 01/01/2026 UPI/DR/600138334049/ANANDA
B/ICIC/getepay.mb/Sent
40.00 31861.75
02/01/2026 02/01/2026 UPI/DR/600242028980/SWIGGY
/YESB/q096841618/Sent
75.00 31786.75
05/01/2026 05/01/2026 NEFT*IDFB0080223*IDFB603062216308*ACME SOFTWARE
29,166.00 60,952.75
**This is computer generated statement**
`;

describe('parseSbiText', () => {
  const r = parseSbiText(SAMPLE)!;

  it('finds every row', () => {
    expect(r.txns).toHaveLength(3);
  });

  it('reads debit vs credit from the balance change', () => {
    expect(r.txns.map((t) => t.isIncome)).toEqual([false, false, true]);
  });

  it('parses amounts with thousands separators', () => {
    expect(r.txns[2]!.amount).toBe(29166);
    expect(r.txns[2]!.balance).toBe(60952.75);
  });

  it('derives the opening balance', () => {
    expect(r.opening).toBe(31901.75);
  });

  it('extracts merchant, reference, date and mode', () => {
    expect(r.txns[0]).toMatchObject({
      date: '2026-01-01',
      merchant: 'ANANDA B',
      ref: '600138334049',
      mode: 'UPI',
      dedupeKey: 'r:600138334049',
    });
  });

  it('categorises by keyword and by direction', () => {
    expect(r.txns[1]!.category).toBe('Food');
    expect(r.txns[2]!.category).toBe('Salary');
  });

  it('returns null when nothing looks like a statement', () => {
    expect(parseSbiText('hello world')).toBeNull();
  });
});
