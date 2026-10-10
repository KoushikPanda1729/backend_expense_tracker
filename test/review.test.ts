import { describe, expect, it } from 'vitest';
import { buildReview, ReviewRow } from '../src/modules/analytics/review';

let n = 0;
const row = (o: Partial<ReviewRow>): ReviewRow => ({
  id: String(++n), txn_date: '2026-09-01', merchant: 'DRISANA', mode: 'UPI', category: 'Transfer',
  amount: 100, is_income: false, ref: null, description: 'UPI/DR/1/DRISANA/CNRB/8918846865/UPI',
  upi_id: '8918846865', bank: 'CNRB', ...o,
});

describe('buildReview', () => {
  it('groups unknown payees with sent, received, net and the phone number', () => {
    const r = buildReview(
      [row({ amount: 200 }), row({ amount: 50 }), row({ amount: 80, is_income: true, category: 'Received' })],
      new Set(),
    );
    expect(r.unknownPayees).toHaveLength(1);
    expect(r.unknownPayees[0]).toMatchObject({ sent: 250, received: 80, net: -170, sentCount: 2, phone: '8918846865' });
  });

  it('drops a payee once the user has labelled it', () => {
    const r = buildReview([row({})], new Set(['drisana']));
    expect(r.unknownPayees).toHaveLength(0);
  });

  it('flags auto-debits, bank charges, large payments and double payments', () => {
    const r = buildReview(
      [
        row({ merchant: 'Indian Clearing', category: 'Investment', mode: 'ACHDr YESB00709000', description: 'ACHDr YESB00709000028661 Indian Clearin', upi_id: null, bank: null }),
        row({ merchant: 'SMS CHARGES', category: 'Transfer', description: 'SMS CHARGES 01-09', upi_id: null, bank: null }),
        row({ merchant: 'SABUJ DU', amount: 5240 }),
        row({ merchant: 'SANCHAIT', amount: 100, txn_date: '2026-09-13' }),
        row({ merchant: 'SANCHAIT', amount: 100, txn_date: '2026-09-13' }),
      ],
      new Set(),
    );
    const why = Object.fromEntries(r.flagged.map((f) => [f.merchant + f.amount, f.reasons]));
    expect(why['Indian Clearing100']).toContain('Auto-debit');
    expect(why['SMS CHARGES100']).toContain('Bank charge');
    expect(why['SABUJ DU5240']).toContain('Large payment');
    expect(r.flagged.filter((f) => f.reasons.includes('Paid twice the same day'))).toHaveLength(2);
  });
});
