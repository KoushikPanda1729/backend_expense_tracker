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
  invested_total: number | null;
  current_value: number | null;
  last_amount: number | null;
  monthly_sip: number | null;
  value_as_of: string | null;
  invested: number;
  withdrawn: number;
  entries: number;
  last_entry: string | null;
}

const fundSql = `
  SELECT f.id, f.name, f.invested_total, f.current_value, f.monthly_sip, f.value_as_of,
         (SELECT e2.amount FROM fund_entries e2 WHERE e2.fund_id = f.id AND e2.kind = 'invest'
           ORDER BY e2.entry_date DESC, e2.created_at DESC LIMIT 1) AS last_amount,
         COALESCE(SUM(e.amount) FILTER (WHERE e.kind = 'invest'), 0)   AS invested,
         COALESCE(SUM(e.amount) FILTER (WHERE e.kind = 'withdraw'), 0) AS withdrawn,
         COUNT(e.id)::int AS entries, MAX(e.entry_date) AS last_entry
    FROM funds f LEFT JOIN fund_entries e ON e.fund_id = f.id
   WHERE f.user_id = $1 /*AND*/
   GROUP BY f.id ORDER BY MAX(e.entry_date) DESC NULLS LAST, f.name`;

function toDto(f: FundRow) {
  const fromStatements = round2(f.invested - f.withdrawn); // what the bank statements show went in
  // the total invested as typed from the fund app; until it is typed, the statement amounts stand in
  const invested = f.invested_total ?? fromStatements;
  // returns and percentage are worked out from the two typed numbers
  const gain = f.current_value === null ? null : round2(f.current_value - invested);
  return {
    id: f.id,
    name: f.name,
    investedTotal: f.invested_total, // as typed, or null
    invested, // what to show as the total invested
    currentValue: f.current_value, // as typed, or null
    gain,
    gainPercent: gain !== null && invested > 0 ? Math.round((gain / invested) * 1000) / 10 : null,
    // the amount of the latest statement payment: the monthly SIP
    monthlySip: f.monthly_sip ?? f.last_amount, // typed by the user, else the latest statement payment
    fromStatements,
    entryCount: f.entries,
    lastEntry: f.last_entry,
    valueAsOf: f.value_as_of,
  };
}

// every fund, and the totals across all of them
fundsRouter.get('/', async (req, res) => {
  const items = (await query<FundRow>(fundSql.replace('/*AND*/', ''), [req.userId])).map(toDto);
  const valued = items.filter((f) => f.currentValue !== null);
  res.json({
    items,
    totals: {
      invested: round2(items.reduce((a, f) => a + f.invested, 0)),
      // current value and returns count the funds the user gave a current value for
      currentValue: valued.length ? round2(valued.reduce((a, f) => a + (f.currentValue ?? 0), 0)) : null,
      returns: valued.length ? round2(valued.reduce((a, f) => a + (f.gain ?? 0), 0)) : null,
      investedInValued: round2(valued.reduce((a, f) => a + f.invested, 0)), // for the overall percentage
      monthlySip: round2(items.reduce((a, f) => a + (f.monthlySip ?? 0), 0)),
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
  const b = z.object({ name, investedTotal: z.number().min(0).optional() }).parse(req.body);
  try {
    const rows = await query<{ id: string }>(
      `INSERT INTO funds (user_id, name, invested_total, value_as_of) VALUES ($1, $2, $3, CASE WHEN $3::numeric IS NULL THEN NULL ELSE CURRENT_DATE END) RETURNING id`,
      [req.userId, b.name, b.investedTotal ?? null],
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
    .object({
      name: name.optional(),
      investedTotal: z.number().min(0).nullable().optional(),
      currentValue: z.number().min(0).nullable().optional(),
      monthlySip: z.number().min(0).nullable().optional(),
    })
    .refine((v) => Object.keys(v).length > 0, { message: 'Send at least one field to change' })
    .parse(req.body);
  try {
    const rows = await query(
      `UPDATE funds SET name = COALESCE($3, name),
              invested_total = CASE WHEN $4::boolean THEN $5::numeric ELSE invested_total END,
              current_value = CASE WHEN $6::boolean THEN $7::numeric ELSE current_value END,
              monthly_sip = CASE WHEN $8::boolean THEN $9::numeric ELSE monthly_sip END
        WHERE id = $1 AND user_id = $2 RETURNING id`,
      [id, req.userId, b.name ?? null, b.investedTotal !== undefined, b.investedTotal ?? null, b.currentValue !== undefined, b.currentValue ?? null, b.monthlySip !== undefined, b.monthlySip ?? null],
    );
    if (rows.length === 0) throw notFound('Fund not found');
    if (b.investedTotal !== undefined || b.currentValue !== undefined) {
      // "as of" is the day the numbers were typed in; no numbers left means no date
      await query(
        `UPDATE funds SET value_as_of = CASE WHEN invested_total IS NULL AND current_value IS NULL THEN NULL ELSE CURRENT_DATE END
          WHERE id = $1 AND user_id = $2`,
        [id, req.userId],
      );
    }
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
