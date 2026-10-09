import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../db/pool';

export const analyticsRouter = Router();

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const rangeQuery = z.object({ from: date.optional(), to: date.optional() });

const RANGE = `user_id = $1 AND ($2::date IS NULL OR txn_date >= $2) AND ($3::date IS NULL OR txn_date <= $3)`;

/** Numbers for the Analysis screen: totals, category split, top merchants, month by month. */
analyticsRouter.get('/summary', async (req, res) => {
  const { from, to } = rangeQuery.parse(req.query);
  const p = [req.userId, from ?? null, to ?? null];

  const [totals, byCategory, topMerchants, monthly] = await Promise.all([
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
  ]);

  const t = totals[0]!;
  const net = t.income - t.expense;
  const days = t.first && t.last ? Math.round((Date.parse(t.last) - Date.parse(t.first)) / 86_400_000) + 1 : 0;

  res.json({
    range: { from: t.first, to: t.last },
    income: t.income,
    expense: t.expense,
    net,
    savingsRate: t.income > 0 ? Math.round((net / t.income) * 1000) / 10 : 0, // percent, 1 decimal
    averageDailySpend: days > 0 ? Math.round((t.expense / days) * 100) / 100 : 0,
    transactionCount: t.count,
    byCategory,
    topMerchants,
    monthly,
  });
});
