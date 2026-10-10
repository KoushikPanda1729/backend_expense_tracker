import { describe, expect, it } from 'vitest';
import { findManualMatches, ManualRow } from '../src/modules/statements/manualMatch';
import { ParsedTxn } from '../src/modules/statements/sbi.parser';

const bank = (o: Partial<ParsedTxn>): ParsedTxn => ({
  date: '2026-10-12', amount: 120, balance: 0, isIncome: false, merchant: 'SHOP', mode: 'UPI', category: 'Shopping',
  ref: '1', description: '', upiId: null, bank: null, dedupeKey: 'r:1:e', ...o,
});
let n = 0;
const manual = (o: Partial<ManualRow>): ManualRow => ({
  id: String(++n), txn_date: '2026-10-12', merchant: 'Tea', category: 'Food', amount: 120, is_income: false, note: null, label: null, ...o,
});

describe('findManualMatches', () => {
  it('matches the same amount, direction and date', () => {
    const r = findManualMatches([bank({})], [manual({})]);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ daysApart: 0 });
  });

  it('accepts one day apart, but not two, a different amount or the other direction', () => {
    expect(findManualMatches([bank({})], [manual({ txn_date: '2026-10-11' })])[0]?.daysApart).toBe(1);
    expect(findManualMatches([bank({})], [manual({ txn_date: '2026-10-10' })])).toHaveLength(0);
    expect(findManualMatches([bank({})], [manual({ amount: 121 })])).toHaveLength(0);
    expect(findManualMatches([bank({})], [manual({ is_income: true })])).toHaveLength(0);
  });

  it('uses each entry once and prefers the same date over a near date', () => {
    const near = manual({ txn_date: '2026-10-11' });
    const same = manual({});
    const r = findManualMatches([bank({})], [near, same]);
    expect(r).toHaveLength(1);
    expect(r[0]!.manual.id).toBe(same.id);
    // two bank rows, one manual entry: only one pair
    expect(findManualMatches([bank({ dedupeKey: 'a' }), bank({ dedupeKey: 'b' })], [manual({})])).toHaveLength(1);
  });
});
