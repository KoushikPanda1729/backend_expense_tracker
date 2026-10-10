import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../../db/pool';
import { conflict, isUniqueViolation, notFound } from '../../lib/errors';

export const fundsRouter = Router();

const idParam = z.object({ id: z.string().uuid() });
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const name = z.string().trim().min(1).max(120);
const money = z.number().positive().max(10_000_000_000);
const round2 = (n: number) => Math.round(n * 100) / 100;

interface FundRow {
  id: string;
  name: string;
  current_value: number | null;
  value_as_of: string | null;
  invested: number;
  withdrawn: number;
  entries: number;
  last_entry: string | null;
}

const fundSql = `
  SELECT f.id, f.name, f.current_value, f.value_as_of,
         COALESCE(SUM(e.amount) FILTER (WHERE e.kind = 'invest'), 0)   AS invested,
         COALESCE(SUM(e.amount) FILTER (WHERE e.kind = 'withdraw'), 0) AS withdrawn,
         COUNT(e.id)::int AS entries, MAX(e.entry_date) AS last_entry
    FROM funds f LEFT JOIN fund_entries e ON e.fund_id = f.id
   WHERE f.user_id = $1 /*AND*/
   GROUP BY f.id ORDER BY f.name`;

function toDto(f: FundRow) {
  const net = round2(f.invested - f.withdrawn);
  const gain = f.current_value === null ? null : round2(f.current_value - net);
  return {
    id: f.id,
    name: f.name,
    invested: round2(f.invested),
    withdrawn: round2(f.withdrawn),
    netInvested: net,
    entryCount: f.entries,
    lastEntry: f.last_entry,
    currentValue: f.current_value,
    valueAsOf: f.value_as_of,
    gain,
    gainPercent: gain !== null && net > 0 ? Math.round((gain / net) * 1000) / 10 : null,
  };
}

// every fund with what was put in, and the totals
fundsRouter.get('/', async (req, res) => {
  const items = (await query<FundRow>(fundSql.replace('/*AND*/', ''), [req.userId])).map(toDto);
  const netInvested = round2(items.reduce((a, f) => a + f.netInvested, 0));
  const valued = items.filter((f) => f.currentValue !== null);
  const currentValue = round2(valued.reduce((a, f) => a + (f.currentValue ?? 0), 0));
  const investedInValued = round2(valued.reduce((a, f) => a + f.netInvested, 0));
  res.json({
    items,
    totals: {
      netInvested,
      // returns are only counted for funds whose current value the user entered
      currentValue: valued.length ? currentValue : null,
      gain: valued.length ? round2(currentValue - investedInValued) : null,
      valuedFunds: valued.length,
    },
  });
});

// bank statement rows that look like fund payments (category Investment) and are not in any fund yet
fundsRouter.get('/unassigned', async (req, res) => {
  const rows = await query<{ id: string; txn_date: string; merchant: string; amount: number; description: string | null }>(
    `SELECT t.id, t.txn_date, t.merchant, t.amount, t.description FROM transactions t
      WHERE t.user_id = $1 AND t.category = 'Investment' AND NOT t.is_income
        AND NOT EXISTS (SELECT 1 FROM fund_entries e WHERE e.txn_id = t.id)
      ORDER BY t.txn_date DESC, t.id`,
    [req.userId],
  );
  res.json({
    items: rows.map((r) => ({ id: r.id, date: r.txn_date, merchant: r.merchant, amount: r.amount, description: r.description })),
    total: round2(rows.reduce((a, r) => a + r.amount, 0)),
  });
});

fundsRouter.post('/', async (req, res) => {
  const b = z.object({ name, currentValue: z.number().min(0).optional() }).parse(req.body);
  try {
    const rows = await query<{ id: string }>(
      `INSERT INTO funds (user_id, name, current_value, value_as_of) VALUES ($1, $2, $3, CASE WHEN $3::numeric IS NULL THEN NULL ELSE CURRENT_DATE END) RETURNING id`,
      [req.userId, b.name, b.currentValue ?? null],
    );
    const f = (await query<FundRow>(fundSql.replace('/*AND*/', 'AND f.id = $2'), [req.userId, rows[0]!.id]))[0]!;
    res.status(201).json(toDto(f));
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict('You already track a fund with that name');
    throw e;
  }
});

// delete one entry (must stay above /:id)
fundsRouter.delete('/entries/:id', async (req, res) => {
  const { id } = idParam.parse(req.params);
  const rows = await query('DELETE FROM fund_entries WHERE id = $1 AND user_id = $2 RETURNING id', [id, req.userId]);
  if (rows.length === 0) throw notFound('Entry not found');
  res.status(204).end();
});

fundsRouter.get('/:id', async (req, res) => {
  const { id } = idParam.parse(req.params);
  const f = (await query<FundRow>(fundSql.replace('/*AND*/', 'AND f.id = $2'), [req.userId, id]))[0];
  if (!f) throw notFound('Fund not found');
  const entries = await query<{ id: string; entry_date: string; amount: number; kind: string; note: string | null; txn_id: string | null }>(
    'SELECT id, entry_date, amount, kind, note, txn_id FROM fund_entries WHERE fund_id = $1 AND user_id = $2 ORDER BY entry_date DESC, created_at DESC',
    [id, req.userId],
  );
  res.json({
    ...toDto(f),
    entries: entries.map((e) => ({ id: e.id, date: e.entry_date, amount: e.amount, kind: e.kind, note: e.note, fromStatement: e.txn_id !== null })),
  });
});

// rename, or set what the fund is worth today (null clears it)
fundsRouter.patch('/:id', async (req, res) => {
  const { id } = idParam.parse(req.params);
  const b = z
    .object({ name: name.optional(), currentValue: z.number().min(0).nullable().optional() })
    .refine((v) => Object.keys(v).length > 0, { message: 'Send at least one field to change' })
    .parse(req.body);
  try {
    const rows = await query(
      `UPDATE funds SET name = COALESCE($3, name),
              current_value = CASE WHEN $4::boolean THEN $5::numeric ELSE current_value END,
              value_as_of   = CASE WHEN $4::boolean THEN CASE WHEN $5::numeric IS NULL THEN NULL ELSE CURRENT_DATE END ELSE value_as_of END
        WHERE id = $1 AND user_id = $2 RETURNING id`,
      [id, req.userId, b.name ?? null, b.currentValue !== undefined, b.currentValue ?? null],
    );
    if (rows.length === 0) throw notFound('Fund not found');
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict('You already track a fund with that name');
    throw e;
  }
  const f = (await query<FundRow>(fundSql.replace('/*AND*/', 'AND f.id = $2'), [req.userId, id]))[0]!;
  res.json(toDto(f));
});

fundsRouter.delete('/:id', async (req, res) => {
  const { id } = idParam.parse(req.params);
  const rows = await query('DELETE FROM funds WHERE id = $1 AND user_id = $2 RETURNING id', [id, req.userId]);
  if (rows.length === 0) throw notFound('Fund not found');
  res.status(204).end();
});

// add an amount by hand: invested (SIP or lump sum) or taken out
fundsRouter.post('/:id/entries', async (req, res) => {
  const { id } = idParam.parse(req.params);
  const b = z
    .object({ date, amount: money, kind: z.enum(['invest', 'withdraw']).default('invest'), note: z.string().trim().max(200).optional() })
    .parse(req.body);
  const rows = await query(
    `INSERT INTO fund_entries (user_id, fund_id, entry_date, amount, kind, note)
     SELECT $1, f.id, $3, $4, $5, $6 FROM funds f WHERE f.id = $2 AND f.user_id = $1 RETURNING id`,
    [req.userId, id, b.date, b.amount, b.kind, b.note || null],
  );
  if (rows.length === 0) throw notFound('Fund not found');
  res.status(201).json({ id: (rows[0] as { id: string }).id });
});

// put bank statement payments into this fund (each payment can only be in one fund)
fundsRouter.post('/:id/assign', async (req, res) => {
  const { id } = idParam.parse(req.params);
  const { txnIds } = z.object({ txnIds: z.array(z.string().uuid()).min(1).max(500) }).parse(req.body);
  const added = await withTransaction(async (c) => {
    const fund = await c.query('SELECT 1 FROM funds WHERE id = $1 AND user_id = $2', [id, req.userId]);
    if (fund.rowCount === 0) throw notFound('Fund not found');
    const r = await c.query(
      `INSERT INTO fund_entries (user_id, fund_id, entry_date, amount, kind, txn_id)
       SELECT $1, $2, t.txn_date, t.amount, 'invest', t.id FROM transactions t
        WHERE t.user_id = $1 AND t.id = ANY($3::uuid[]) AND t.category = 'Investment' AND NOT t.is_income
       ON CONFLICT (txn_id) DO NOTHING`,
      [req.userId, id, txnIds],
    );
    return r.rowCount ?? 0;
  });
  res.json({ added });
});
