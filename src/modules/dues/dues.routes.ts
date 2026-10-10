import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../db/pool';
import { badRequest, notFound } from '../../lib/errors';

export const duesRouter = Router();

const idParam = z.object({ id: z.string().uuid() });
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const person = z.string().trim().min(1).max(80);
const amount = z.number().positive().max(1_000_000_000);

interface DueRow {
  id: string;
  person: string;
  direction: 'get' | 'give';
  amount: number;
  settled: number;
  note: string | null;
  due_date: string | null;
  created_at: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const toDto = (d: DueRow) => ({
  id: d.id,
  person: d.person,
  direction: d.direction,
  amount: d.amount,
  settled: d.settled,
  remaining: round2(d.amount - d.settled),
  note: d.note,
  dueDate: d.due_date,
  createdAt: d.created_at,
});

// open ones first (soonest due date first), then the settled ones
duesRouter.get('/', async (req, res) => {
  const rows = await query<DueRow>(
    `SELECT * FROM dues WHERE user_id = $1
      ORDER BY (amount - settled <= 0), due_date NULLS LAST, created_at DESC`,
    [req.userId],
  );
  const items = rows.map(toDto);
  const sum = (dir: 'get' | 'give') => round2(items.filter((i) => i.direction === dir).reduce((a, i) => a + i.remaining, 0));
  res.json({ items, totals: { toGet: sum('get'), toGive: sum('give') } });
});

duesRouter.post('/', async (req, res) => {
  const b = z
    .object({
      person,
      direction: z.enum(['get', 'give']),
      amount,
      note: z.string().trim().max(300).optional(),
      dueDate: date.optional(),
    })
    .parse(req.body);
  const rows = await query<DueRow>(
    `INSERT INTO dues (user_id, person, direction, amount, note, due_date) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [req.userId, b.person, b.direction, b.amount, b.note || null, b.dueDate ?? null],
  );
  res.status(201).json(toDto(rows[0]!));
});

// change any field; note '' and dueDate null clear them
duesRouter.patch('/:id', async (req, res) => {
  const { id } = idParam.parse(req.params);
  const b = z
    .object({
      person: person.optional(),
      direction: z.enum(['get', 'give']).optional(),
      amount: amount.optional(),
      note: z.string().trim().max(300).optional(),
      dueDate: date.nullable().optional(),
    })
    .refine((v) => Object.keys(v).length > 0, { message: 'Send at least one field to change' })
    .parse(req.body);
  const cur = (await query<DueRow>('SELECT * FROM dues WHERE id = $1 AND user_id = $2', [id, req.userId]))[0];
  if (!cur) throw notFound('Entry not found');
  const next = {
    person: b.person ?? cur.person,
    direction: b.direction ?? cur.direction,
    amount: b.amount ?? cur.amount,
    note: b.note === undefined ? cur.note : b.note || null,
    due: b.dueDate === undefined ? cur.due_date : b.dueDate,
  };
  if (next.amount < cur.settled) throw badRequest('The amount cannot be less than what is already paid back');
  const rows = await query<DueRow>(
    `UPDATE dues SET person = $3, direction = $4, amount = $5, note = $6, due_date = $7, updated_at = now()
      WHERE id = $1 AND user_id = $2 RETURNING *`,
    [id, req.userId, next.person, next.direction, next.amount, next.note, next.due],
  );
  res.json(toDto(rows[0]!));
});

// record a (part) payment; it can never go past the total
duesRouter.post('/:id/settle', async (req, res) => {
  const { id } = idParam.parse(req.params);
  const { amount: paid } = z.object({ amount }).parse(req.body);
  const rows = await query<DueRow>(
    `UPDATE dues SET settled = LEAST(amount, settled + $3), updated_at = now()
      WHERE id = $1 AND user_id = $2 RETURNING *`,
    [id, req.userId, paid],
  );
  if (!rows[0]) throw notFound('Entry not found');
  res.json(toDto(rows[0]));
});

duesRouter.delete('/:id', async (req, res) => {
  const { id } = idParam.parse(req.params);
  const rows = await query('DELETE FROM dues WHERE id = $1 AND user_id = $2 RETURNING id', [id, req.userId]);
  if (rows.length === 0) throw notFound('Entry not found');
  res.status(204).end();
});
