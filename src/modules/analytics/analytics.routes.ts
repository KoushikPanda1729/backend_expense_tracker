import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../db/pool';
import { listRules, keyOf } from '../payees/payees.service';
import { buildAccount, SignedTxn, StatementRow } from './account';
import { buildReview, ReviewRow } from './review';

export const analyticsRouter = Router();

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const rangeQuery = z.object({ from: date.optional(), to: date.optional() });

const round2 = (n: number) => Math.round(n * 100) / 100;
const SIGNED = 'CASE WHEN is_income THEN amount ELSE -amount END';
// cash and wallet entries are real spending but never touch the bank account's balance
const IN_BANK = "mode NOT IN ('Cash', 'Wallet')";
const RANGE = `user_id = $1 AND ($2::date IS NULL OR txn_date >= $2) AND ($3::date IS NULL OR txn_date <= $3)`;

/** Numbers for the Analysis screen: totals, category split, top merchants, month by month, weekdays. */
analyticsRouter.get('/summary', async (req, res) => {
  const { from, to } = rangeQuery.parse(req.query);
  const p = [req.userId, from ?? null, to ?? null];

  const [totals, byCategory, topMerchants, monthly, byWeekday, biggest, small] = await Promise.all([
    query<{ income: number; expense: number; count: number; first: string | null; last: string | null }>(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE is_income), 0)     AS income,
              COALESCE(SUM(amount) FILTER (WHERE NOT is_income), 0) AS expense,
              COUNT(*)::int AS count, MIN(txn_date) AS first, MAX(txn_date) AS last
         FROM transactions WHERE ${RANGE}`,
      p,
    ),
    query<{ category: string; total: number; count: number }>(
      `SELECT category, SUM(amount) AS total, COUNT(*)::int AS count
         FROM transactions WHERE ${RANGE} AND NOT is_income
        GROUP BY category ORDER BY total DESC`,
      p,
    ),
    query<{ merchant: string; total: number; count: number }>(
      `SELECT merchant, SUM(amount) AS total, COUNT(*)::int AS count
         FROM transactions WHERE ${RANGE} AND NOT is_income
        GROUP BY merchant ORDER BY total DESC LIMIT 5`,
      p,
    ),
    query<{ month: string; income: number; expense: number }>(
      `SELECT to_char(txn_date, 'YYYY-MM') AS month,
              COALESCE(SUM(amount) FILTER (WHERE is_income), 0)     AS income,
              COALESCE(SUM(amount) FILTER (WHERE NOT is_income), 0) AS expense
         FROM transactions WHERE ${RANGE}
        GROUP BY 1 ORDER BY 1`,
      p,
    ),
    // 1 = Monday ... 7 = Sunday
    query<{ weekday: number; total: number }>(
      `SELECT EXTRACT(ISODOW FROM txn_date)::int AS weekday, SUM(amount) AS total
         FROM transactions WHERE ${RANGE} AND NOT is_income
        GROUP BY 1 ORDER BY 1`,
      p,
    ),
    query<{ date: string; merchant: string; category: string; amount: number }>(
      `SELECT txn_date AS date, merchant, category, amount
         FROM transactions WHERE ${RANGE} AND NOT is_income
        ORDER BY amount DESC, txn_date DESC LIMIT 3`,
      p,
    ),
    // payments under 100: the small ones that add up
    query<{ count: number; total: number }>(
      `SELECT COUNT(*)::int AS count, COALESCE(SUM(amount), 0) AS total
         FROM transactions WHERE ${RANGE} AND NOT is_income AND amount < 100`,
      p,
    ),
  ]);

  const t = totals[0]!;
  const net = t.income - t.expense;
  const days = t.first && t.last ? Math.round((Date.parse(t.last) - Date.parse(t.first)) / 86_400_000) + 1 : 0;

  res.json({
    range: { from: t.first, to: t.last },
    income: t.income,
    expense: t.expense,
    net: round2(net),
    savingsRate: t.income > 0 ? Math.round((net / t.income) * 1000) / 10 : 0, // percent, 1 decimal
    averageDailySpend: days > 0 ? round2(t.expense / days) : 0,
    transactionCount: t.count,
    byCategory,
    topMerchants,
    monthly,
    byWeekday,
    biggestExpenses: biggest,
    smallPayments: small[0],
  });
});

/**
 * Chart data for the Home "Spend Frequency" line: income and expense per day, week
 * (Monday start) or month, with empty buckets left out (the app fills the gaps).
 */
analyticsRouter.get('/series', async (req, res) => {
  const q = rangeQuery.extend({ granularity: z.enum(['day', 'week', 'month']).default('day') }).parse(req.query);
  const rows = await query<{ bucket: string; income: number; expense: number }>(
    `SELECT date_trunc($4::text, txn_date::timestamp)::date AS bucket,
            COALESCE(SUM(amount) FILTER (WHERE is_income), 0)     AS income,
            COALESCE(SUM(amount) FILTER (WHERE NOT is_income), 0) AS expense
       FROM transactions WHERE ${RANGE}
      GROUP BY 1 ORDER BY 1`,
    [req.userId, q.from ?? null, q.to ?? null, q.granularity],
  );
  res.json({ granularity: q.granularity, items: rows });
});

/** Account balance: the opening balance of the earliest statement plus every transaction up to `asOf`. */
analyticsRouter.get('/balance', async (req, res) => {
  const { asOf } = z.object({ asOf: date.optional() }).parse(req.query);
  const row = (
    await query<{ opening: number; delta: number }>(
      `SELECT u.opening_balance AS opening,
              COALESCE((SELECT SUM(${SIGNED}) FROM transactions t
                         WHERE t.user_id = u.id AND t.mode NOT IN ('Cash', 'Wallet') AND ($2::date IS NULL OR t.txn_date <= $2)), 0) AS delta
         FROM users u WHERE u.id = $1`,
      [req.userId, asOf ?? null],
    )
  )[0]!;
  res.json({ asOf: asOf ?? null, openingBalance: row.opening, balance: round2(row.opening + row.delta) });
});

/** Running balance at the end of every day that has transactions (for the balance trend chart). */
analyticsRouter.get('/balance-trend', async (req, res) => {
  const { from, to } = rangeQuery.parse(req.query);
  const rows = await query<{ day: string; balance: number }>(
    `SELECT day, balance FROM (
        SELECT d.txn_date AS day, u.opening_balance + SUM(d.net) OVER (ORDER BY d.txn_date) AS balance
          FROM (SELECT txn_date, SUM(${SIGNED}) AS net FROM transactions WHERE user_id = $1 AND ${IN_BANK} GROUP BY txn_date) d
         CROSS JOIN (SELECT opening_balance FROM users WHERE id = $1) u
     ) x
      WHERE ($2::date IS NULL OR day >= $2) AND ($3::date IS NULL OR day <= $3)
      ORDER BY day`,
    [req.userId, from ?? null, to ?? null],
  );
  res.json({ items: rows.map((r) => ({ date: r.day, balance: round2(r.balance) })) });
});

/** "Check your money": payments the app cannot explain, so the user can look them up and label them. */
analyticsRouter.get('/review', async (req, res) => {
  // optional ?from&to (YYYY-MM-DD): look at one month, a few months, or everything
  const { from, to } = rangeQuery.parse(req.query);
  const [rows, rules] = await Promise.all([
    query<ReviewRow>(
      `SELECT id, txn_date, merchant, mode, category, amount, is_income, ref, description, upi_id, bank
         FROM transactions
        WHERE user_id = $1 AND ($2::date IS NULL OR txn_date >= $2) AND ($3::date IS NULL OR txn_date <= $3)
        ORDER BY txn_date, id`,
      [req.userId, from ?? null, to ?? null],
    ),
    listRules(req.userId),
  ]);
  res.json({ ...buildReview(rows, new Set(rules.map((r) => keyOf(r.merchant)))), known: rules });
});

/** The real account balance: the SBI header balance of the newest statement plus anything after it. */
analyticsRouter.get('/account', async (req, res) => {
  const [statements, txns, user] = await Promise.all([
    query<StatementRow>(
      `SELECT period_start, period_end, opening_balance, closing_balance, balance_asof_date, balance_asof
         FROM statements WHERE user_id = $1 AND period_start IS NOT NULL AND period_end IS NOT NULL`,
      [req.userId],
    ),
    query<SignedTxn>(`SELECT txn_date, ${SIGNED} AS signed FROM transactions WHERE user_id = $1 AND ${IN_BANK}`, [req.userId]),
    query<{ opening_balance: number }>('SELECT opening_balance FROM users WHERE id = $1', [req.userId]),
  ]);
  res.json(buildAccount(statements, txns, user[0]?.opening_balance ?? 0));
});
