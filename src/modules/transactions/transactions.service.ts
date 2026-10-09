import { randomUUID } from 'node:crypto';
import { query } from '../../db/pool';
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from '../../lib/categories';
import { badRequest, notFound } from '../../lib/errors';
import { CreateInput, ListQuery } from './transactions.schemas';

interface TxnRow {
  id: string;
  statement_id: string | null;
  txn_date: string;
  merchant: string;
  mode: string;
  category: string;
  amount: number;
  is_income: boolean;
  created_at: string;
}

const toDto = (t: TxnRow) => ({
  id: t.id,
  date: t.txn_date,
  merchant: t.merchant,
  mode: t.mode,
  category: t.category,
  amount: t.amount,
  isIncome: t.is_income,
  statementId: t.statement_id,
  createdAt: t.created_at,
});

// Date sorts use keyset cursors ("k:<date>|<id>"); amount sorts use offsets ("o:<n>").
const encodeKeyset = (t: TxnRow) => Buffer.from(`k:${t.txn_date}|${t.id}`).toString('base64url');
const encodeOffset = (n: number) => Buffer.from(`o:${n}`).toString('base64url');

type Cursor = { kind: 'keyset'; date: string; id: string } | { kind: 'offset'; n: number };

function decodeCursor(c: string): Cursor {
  const raw = Buffer.from(c, 'base64url').toString();
  if (raw.startsWith('o:')) {
    const n = Number(raw.slice(2));
    if (Number.isInteger(n) && n >= 0) return { kind: 'offset', n };
  } else if (raw.startsWith('k:')) {
    const [d, id] = raw.slice(2).split('|');
    if (d && id && /^\d{4}-\d{2}-\d{2}$/.test(d) && /^[0-9a-f-]{36}$/i.test(id)) return { kind: 'keyset', date: d, id };
  }
  throw badRequest('Invalid cursor');
}

const ORDER = {
  newest: 'txn_date DESC, id DESC',
  oldest: 'txn_date ASC, id ASC',
  highest: 'amount DESC, txn_date DESC, id DESC',
  lowest: 'amount ASC, txn_date DESC, id DESC',
} as const;

/** Pass `nextCursor` from the previous page as `cursor` to get the next one. */
export async function listTransactions(userId: string, q: ListQuery) {
  const params: unknown[] = [userId];
  const where = ['user_id = $1'];
  const add = (sql: (n: number) => string, value: unknown) => {
    params.push(value);
    where.push(sql(params.length));
  };

  if (q.from) add((n) => `txn_date >= $${n}`, q.from);
  if (q.to) add((n) => `txn_date <= $${n}`, q.to);
  if (q.type) add((n) => `is_income = $${n}`, q.type === 'income');
  if (q.category?.length) add((n) => `category = ANY($${n}::text[])`, q.category);
  if (q.q) {
    const like = `%${q.q.replace(/[\\%_]/g, '\\$&')}%`;
    add((n) => `(merchant ILIKE $${n} OR category ILIKE $${n})`, like);
  }

  const byAmount = q.sort === 'highest' || q.sort === 'lowest';
  let offset = 0;
  if (q.cursor) {
    const c = decodeCursor(q.cursor);
    if (byAmount) {
      if (c.kind !== 'offset') throw badRequest('Cursor does not match the sort order');
      offset = c.n;
    } else {
      if (c.kind !== 'keyset') throw badRequest('Cursor does not match the sort order');
      params.push(c.date, c.id);
      const op = q.sort === 'newest' ? '<' : '>';
      where.push(`(txn_date, id) ${op} ($${params.length - 1}::date, $${params.length}::uuid)`);
    }
  }
  params.push(q.limit + 1);
  const limitParam = params.length;
  let offsetSql = '';
  if (offset > 0) {
    params.push(offset);
    offsetSql = ` OFFSET $${params.length}`;
  }

  const rows = await query<TxnRow>(
    `SELECT * FROM transactions WHERE ${where.join(' AND ')}
     ORDER BY ${ORDER[q.sort]} LIMIT $${limitParam}${offsetSql}`,
    params,
  );
  const page = rows.slice(0, q.limit);
  const more = rows.length > q.limit;
  return {
    items: page.map(toDto),
    nextCursor: !more ? null : byAmount ? encodeOffset(offset + q.limit) : encodeKeyset(page[page.length - 1]!),
  };
}

export async function createTransaction(userId: string, input: CreateInput) {
  const rows = await query<TxnRow>(
    `INSERT INTO transactions (user_id, txn_date, merchant, mode, category, amount, is_income, dedupe_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    // manual entries never collide with anything
    [userId, input.date, input.merchant, input.mode, input.category, input.amount, input.isIncome, `m:${randomUUID()}`],
  );
  return toDto(rows[0]!);
}

export async function updateTransaction(userId: string, id: string, patch: Partial<CreateInput>) {
  const current = (await query<TxnRow>('SELECT * FROM transactions WHERE id = $1 AND user_id = $2', [id, userId]))[0];
  if (!current) throw notFound('Transaction not found');

  const next = {
    date: patch.date ?? current.txn_date,
    merchant: patch.merchant ?? current.merchant,
    mode: patch.mode ?? current.mode,
    category: patch.category ?? current.category,
    amount: patch.amount ?? current.amount,
    isIncome: patch.isIncome ?? current.is_income,
  };
  const allowed: readonly string[] = next.isIncome ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
  if (!allowed.includes(next.category)) throw badRequest('Category does not match the transaction type');

  const rows = await query<TxnRow>(
    `UPDATE transactions
        SET txn_date = $3, merchant = $4, mode = $5, category = $6, amount = $7, is_income = $8, updated_at = now()
      WHERE id = $1 AND user_id = $2 RETURNING *`,
    [id, userId, next.date, next.merchant, next.mode, next.category, next.amount, next.isIncome],
  );
  return toDto(rows[0]!);
}

export async function deleteTransaction(userId: string, id: string) {
  const rows = await query('DELETE FROM transactions WHERE id = $1 AND user_id = $2 RETURNING id', [id, userId]);
  if (rows.length === 0) throw notFound('Transaction not found');
}
