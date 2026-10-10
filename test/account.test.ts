import { describe, expect, it } from 'vitest';
import { buildAccount } from '../src/modules/analytics/account';

const sep = {
  period_start: '2026-09-01', period_end: '2026-09-30',
  opening_balance: 41494.34, closing_balance: 134.95,
  balance_asof_date: '2026-10-09', balance_asof: 2494.86,
};

describe('buildAccount', () => {
  it('uses the header balance and says how much moved after the statement ended', () => {
    const a = buildAccount([sep], [], 0);
    expect(a.balance).toBe(2494.86);
    expect(a.asOf).toBe('2026-10-09');
    expect(a.source).toBe('statement-header');
    expect(a.untracked).toEqual({ amount: 2359.91, from: '2026-09-30', to: '2026-10-09' });
  });

  it('adds transactions entered after the header date', () => {
    const a = buildAccount([sep], [{ txn_date: '2026-10-10', signed: -100 }], 0);
    expect(a.balance).toBe(2394.86);
  });

  it('falls back to the closing balance when the header has no balance', () => {
    const a = buildAccount([{ ...sep, balance_asof: null, balance_asof_date: null }], [], 0);
    expect(a).toMatchObject({ balance: 134.95, asOf: '2026-09-30', source: 'statement-closing', untracked: null });
  });

  it('finds a missing month between two statements', () => {
    const nov = { period_start: '2026-11-01', period_end: '2026-11-30', opening_balance: 900, closing_balance: 1000, balance_asof_date: null, balance_asof: null };
    const a = buildAccount([sep, nov], [], 0);
    expect(a.gaps).toHaveLength(1);
    expect(a.gaps[0]).toMatchObject({ from: '2026-09-30', to: '2026-11-01' });
  });

  it('with no statements adds up the transactions', () => {
    const a = buildAccount([], [{ txn_date: '2026-10-01', signed: 500 }, { txn_date: '2026-10-02', signed: -120 }], 0);
    expect(a).toMatchObject({ balance: 380, source: 'computed', statementCount: 0 });
  });
});
