import { randomUUID } from 'node:crypto';
import pdf from 'pdf-parse/lib/pdf-parse.js';
import { logger } from '../../config/logger';
import { query, withTransaction } from '../../db/pool';
import { sha256 } from '../../lib/crypto';
import { conflict, notFound, unprocessable } from '../../lib/errors';
import { storage } from '../../storage';
import { parseSbiText, ParsedStatement } from './sbi.parser';

export interface StatementRow {
  id: string;
  original_name: string;
  storage_key: string;
  mime: string;
  size_bytes: number;
  sha256: string;
  bank: string;
  status: 'uploaded' | 'parsed' | 'failed';
  period_start: string | null;
  period_end: string | null;
  txn_count: number;
  error: string | null;
  created_at: string;
}

export const toStatementDto = (s: StatementRow) => ({
  id: s.id,
  fileName: s.original_name,
  sizeBytes: s.size_bytes,
  bank: s.bank,
  status: s.status,
  periodStart: s.period_start,
  periodEnd: s.period_end,
  transactionCount: s.txn_count,
  error: s.error,
  createdAt: s.created_at,
});

/** Reads the PDF text and parses it. Returns the statement or the reason it failed. */
async function parsePdf(buf: Buffer): Promise<{ parsed: ParsedStatement } | { error: string }> {
  try {
    const { text } = await pdf(buf);
    const parsed = parseSbiText(text);
    return parsed ? { parsed } : { error: 'No transactions found. This works with SBI statement PDFs.' };
  } catch (err) {
    logger.warn({ err }, 'pdf parse failed');
    // ponytail: password-protected PDFs are not supported yet (needs pdfjs-dist with a password).
    return { error: /password/i.test(String(err)) ? 'The PDF is password protected' : 'Could not read the PDF' };
  }
}

export async function uploadStatement(userId: string, file: Express.Multer.File) {
  const buf = file.buffer;
  // the mime type comes from the client, so also check the file itself
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw unprocessable('That file is not a PDF');

  const hash = sha256(buf);
  const existing = (await query<{ id: string }>('SELECT id FROM statements WHERE user_id = $1 AND sha256 = $2', [userId, hash]))[0];
  if (existing) throw conflict('This statement was already uploaded', { statementId: existing.id });

  const result = await parsePdf(buf);
  const key = `statements/${userId}/${randomUUID()}.pdf`;
  await storage.put(key, buf, 'application/pdf');

  try {
    return await withTransaction(async (c) => {
      const parsed = 'parsed' in result ? result.parsed : null;
      const first = parsed?.txns[0];
      const last = parsed?.txns[parsed.txns.length - 1];

      const stmt = (
        await c.query<StatementRow>(
          `INSERT INTO statements (user_id, original_name, storage_key, size_bytes, sha256, status, period_start, period_end, error)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
          [
            userId,
            file.originalname.slice(0, 200),
            key,
            buf.length,
            hash,
            parsed ? 'parsed' : 'failed',
            first?.date ?? null,
            last?.date ?? null,
            'error' in result ? result.error : null,
          ],
        )
      ).rows[0]!;

      let added = 0;
      if (parsed) {
        const t = parsed.txns;
        // one round trip: unnest the columns, skip rows we already have
        const inserted = await c.query(
          `INSERT INTO transactions (user_id, statement_id, txn_date, merchant, mode, category, amount, is_income, ref, dedupe_key)
           SELECT $1::uuid, $2::uuid, x.d, x.m, x.mode, x.c, x.a, x.i, x.r, x.k
           FROM unnest($3::date[], $4::text[], $5::text[], $6::text[], $7::numeric[], $8::bool[], $9::text[], $10::text[])
                AS x(d, m, mode, c, a, i, r, k)
           ON CONFLICT (user_id, dedupe_key) DO NOTHING
           RETURNING id`,
          [
            userId,
            stmt.id,
            t.map((x) => x.date),
            t.map((x) => x.merchant),
            t.map((x) => x.mode),
            t.map((x) => x.category),
            t.map((x) => x.amount),
            t.map((x) => x.isIncome),
            t.map((x) => x.ref),
            t.map((x) => x.dedupeKey),
          ],
        );
        added = inserted.rowCount ?? 0;
        await c.query('UPDATE statements SET txn_count = $2 WHERE id = $1', [stmt.id, added]);
        stmt.txn_count = added;
      }

      return {
        statement: toStatementDto(stmt),
        added,
        skippedDuplicates: parsed ? parsed.txns.length - added : 0,
      };
    });
  } catch (err) {
    await storage.delete(key).catch(() => undefined); // do not leave an orphan file
    throw err;
  }
}

export async function listStatements(userId: string) {
  const rows = await query<StatementRow>('SELECT * FROM statements WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
  return rows.map(toStatementDto);
}

export async function getStatement(userId: string, id: string): Promise<StatementRow> {
  const row = (await query<StatementRow>('SELECT * FROM statements WHERE id = $1 AND user_id = $2', [id, userId]))[0];
  if (!row) throw notFound('Statement not found');
  return row;
}

/** Deletes the statement, the transactions imported from it (cascade) and the stored file. */
export async function deleteStatement(userId: string, id: string) {
  const row = await getStatement(userId, id);
  await query('DELETE FROM statements WHERE id = $1 AND user_id = $2', [id, userId]);
  await storage.delete(row.storage_key).catch((err) => logger.warn({ err, key: row.storage_key }, 'file delete failed'));
}
