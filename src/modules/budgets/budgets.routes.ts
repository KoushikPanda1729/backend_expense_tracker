import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../db/pool';
import { EXPENSE_CATEGORIES } from '../../lib/categories';
import { notFound } from '../../lib/errors';

export const budgetsRouter = Router();

const categoryParam = z.object({ category: z.enum(EXPENSE_CATEGORIES) });
const limitBody = z.object({ limit: z.number().positive().max(1_000_000_000) });

budgetsRouter.get('/', async (req, res) => {
  const rows = await query<{ category: string; limit_amount: number }>(
    'SELECT category, limit_amount FROM budgets WHERE user_id = $1 ORDER BY category',
    [req.userId],
  );
  res.json({ items: rows.map((r) => ({ category: r.category, limit: r.limit_amount })) });
});

// create or change the monthly limit of one category
budgetsRouter.put('/:category', async (req, res) => {
  const { category } = categoryParam.parse(req.params);
  const { limit } = limitBody.parse(req.body);
  await query(
    `INSERT INTO budgets (user_id, category, limit_amount) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, category) DO UPDATE SET limit_amount = EXCLUDED.limit_amount, updated_at = now()`,
    [req.userId, category, limit],
  );
  res.json({ category, limit });
});

budgetsRouter.delete('/:category', async (req, res) => {
  const { category } = categoryParam.parse(req.params);
  const rows = await query('DELETE FROM budgets WHERE user_id = $1 AND category = $2 RETURNING category', [
    req.userId,
    category,
  ]);
  if (rows.length === 0) throw notFound('No budget for that category');
  res.status(204).end();
});
