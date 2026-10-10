import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { buffer as readAll } from 'node:stream/consumers';
import { PoolClient } from 'pg';
import { logger } from '../../config/logger';
import { query, withTransaction } from '../../db/pool';
import { sha256 } from '../../lib/crypto';
import { AppError, conflict, notFound, unprocessable } from '../../lib/errors';
import { decryptBuffer, encryptBuffer } from '../../lib/secretbox';
import { storage } from '../../storage';
import * as passwords from '../pdfPasswords/pdfPasswords.service';
import * as payees from '../payees/payees.service';
import { extractPdfText, PdfPasswordError } from './pdf-text';
import { unlockPdf, WrongPasswordError } from './qpdf';
import { ParsedStatement, parseSbiText } from './sbi.parser';

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
  opening_balance: number | null;
  closing_balance: number | null;
  file_encrypted: boolean;
  was_locked: boolean;
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
  openingBalance: s.opening_balance,
  closingBalance: s.closing_balance,
  wasLocked: s.was_locked, // the bank's file had a password; what we keep and serve is unlocked
  downloadUrl: `/api/v1/statements/${s.id}/file`,
  createdAt: s.created_at,
});

const round2 = (n: number) => Math.round(n * 100) / 100;

/** What the client chose for the password: a saved one, a typed one, or nothing. */
export interface UnlockOptions {
  passwordId?: string;
  password?: string;
}

interface Prepared {
  parsed: ParsedStatement;
  /** The PDF without a password: this is what gets stored and downloaded. */
  unlocked: Buffer;
  wasLocked: boolean;
  /** The saved password that opened the file, if one did. */
  usedSaved: passwords.SavedSecret | null;
  /** A password typed in this request that opened the file. */
  typedPassword: string | null;
}

/**
 * Checks the file, unlocks it when needed and parses the rows. Nothing is saved here.
 * A locked file is opened with the chosen password, or, when none was chosen, with each
 * saved password in turn (most recently used first).
 */
async function prepare(userId: string, buf: Buffer, opts: UnlockOptions): Promise<Prepared> {
  // the mime type comes from the client, so also check the file itself
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw unprocessable('That file is not a PDF');

  let text: string;
  let unlocked = buf;
  let wasLocked = false;
  let usedSaved: passwords.SavedSecret | null = null;
  let typedPassword: string | null = null;

  try {
    text = await extractPdfText(buf);
  } catch (err) {
    if (!(err instanceof PdfPasswordError)) {
      logger.warn({ err }, 'pdf read failed');
      throw unprocessable('Could not read the PDF');
    }
    wasLocked = true;

    const chosen = opts.passwordId
      ? [await passwords.getSecret(userId, opts.passwordId)]
      : opts.password
        ? [{ id: null, label: '', password: opts.password }]
        : await passwords.allSecrets(userId);
    const explicit = Boolean(opts.passwordId || opts.password);

    let opened = false;
    for (const c of chosen) {
      try {
        unlocked = await unlockPdf(buf, c.password);
        if (c.id) usedSaved = c as passwords.SavedSecret;
        else typedPassword = c.password;
        opened = true;
        break;
      } catch (e) {
        if (!(e instanceof WrongPasswordError)) throw e;
      }
    }
    if (!opened) {
      throw new AppError(
        422,
        explicit ? 'PDF_PASSWORD_INCORRECT' : 'PDF_PASSWORD_REQUIRED',
        explicit
          ? 'That password does not open this PDF'
          : 'This PDF is password protected and none of your saved passwords opens it. Choose or add the password.',
        { savedPasswordsTried: explicit ? 0 : chosen.length },
      );
    }

    try {
      text = await extractPdfText(unlocked);
    } catch (e) {
      logger.warn({ err: e }, 'unlocked pdf read failed');
      throw unprocessable('Could not read the PDF');
    }
  }

  const parsed = parseSbiText(text);
  if (!parsed) throw unprocessable('No transactions found. This works with SBI statement PDFs.');
  return { parsed, unlocked, wasLocked, usedSaved, typedPassword };
}

/** Which of these transaction keys does the user already have? */
async function existingKeys(userId: string, keys: string[]): Promise<Set<string>> {
  const rows = await query<{ dedupe_key: string }>(
    'SELECT dedupe_key FROM transactions WHERE user_id = $1 AND dedupe_key = ANY($2::text[])',
    [userId, keys],
  );
  return new Set(rows.map((r) => r.dedupe_key));
}

/**
 * Step 1 of an import: what would happen if this file were uploaded. Saves nothing,
 * so the app can show "126 found, 80 new, 46 already imported" and let the user confirm.
 */
export async function previewStatement(userId: string, file: Express.Multer.File, opts: UnlockOptions) {
  const { parsed, wasLocked, usedSaved } = await prepare(userId, file.buffer, opts);
  const t = parsed.txns;
  const have = await existingKeys(userId, t.map((x) => x.dedupeKey));
  const alreadyUploaded =
    (await query('SELECT 1 FROM statements WHERE user_id = $1 AND sha256 = $2', [userId, sha256(file.buffer)])).length > 0;

  return {
    fileName: file.originalname,
    alreadyUploaded,
    wasLocked,
    unlockedWith: usedSaved ? { id: usedSaved.id, label: usedSaved.label } : null,
    transactionCount: t.length,
    newCount: t.filter((x) => !have.has(x.dedupeKey)).length,
    duplicateCount: t.filter((x) => have.has(x.dedupeKey)).length,
    periodStart: t[0]!.date,
    periodEnd: t[t.length - 1]!.date,
    income: round2(t.filter((x) => x.isIncome).reduce((a, x) => a + x.amount, 0)),
    expense: round2(t.filter((x) => !x.isIncome).reduce((a, x) => a + x.amount, 0)),
    openingBalance: parsed.opening,
    closingBalance: t[t.length - 1]!.balance,
    sample: t.slice(0, 5).map((x) => ({
      date: x.date,
      merchant: x.merchant,
      category: x.category,
      amount: x.amount,
      isIncome: x.isIncome,
    })),
  };
}

/** The account's opening balance is the one printed on its earliest statement. */
async function recomputeOpeningBalance(c: PoolClient, userId: string) {
  await c.query(
    `UPDATE users SET opening_balance = COALESCE(
       (SELECT opening_balance FROM statements
         WHERE user_id = $1 AND opening_balance IS NOT NULL
         ORDER BY period_start ASC NULLS LAST LIMIT 1), 0), updated_at = now()
     WHERE id = $1`,
    [userId],
  );
}

export interface UploadOptions extends UnlockOptions {
  /** Remember a typed password for next time. */
  savePassword?: boolean;
  passwordLabel?: string;
}

/** Step 2: store the unlocked PDF (encrypted at rest) and import its transactions. */
export async function uploadStatement(userId: string, file: Express.Multer.File, opts: UploadOptions) {
  const original = file.buffer;
  const { parsed, unlocked, wasLocked, usedSaved, typedPassword } = await prepare(userId, original, opts);

  const hash = sha256(original); // of the file as uploaded, so the same download is not imported twice
  const dup = (await query<{ id: string }>('SELECT id FROM statements WHERE user_id = $1 AND sha256 = $2', [userId, hash]))[0];
  if (dup) throw conflict('This statement was already uploaded', { statementId: dup.id });

  // only the unlocked copy is kept, encrypted with the server key
  const key = `statements/${userId}/${randomUUID()}.pdf.enc`;
  await storage.put(key, encryptBuffer(unlocked), 'application/octet-stream');

  const rules = await payees.loadRules(userId); // categories the user chose for payees
  let result;
  try {
    result = await withTransaction(async (c) => {
      const t = parsed.txns;
      const stmt = (
        await c.query<StatementRow>(
          `INSERT INTO statements
             (user_id, original_name, storage_key, size_bytes, sha256, status, period_start, period_end,
              opening_balance, closing_balance, file_encrypted, was_locked)
           VALUES ($1, $2, $3, $4, $5, 'parsed', $6, $7, $8, $9, true, $10) RETURNING *`,
          [
            userId,
            file.originalname.slice(0, 200),
            key,
            unlocked.length,
            hash,
            t[0]!.date,
            t[t.length - 1]!.date,
            parsed.opening,
            t[t.length - 1]!.balance,
            wasLocked,
          ],
        )
      ).rows[0]!;

      // one round trip: unnest the columns, skip rows the user already has
      const inserted = await c.query(
        `INSERT INTO transactions (user_id, statement_id, txn_date, merchant, mode, category, amount, is_income, ref, dedupe_key,
                                   description, upi_id, bank)
         SELECT $1::uuid, $2::uuid, x.d, x.m, x.mode, x.c, x.a, x.i, x.r, x.k, x.descr, x.upi, x.bank
         FROM unnest($3::date[], $4::text[], $5::text[], $6::text[], $7::numeric[], $8::bool[], $9::text[], $10::text[],
                     $11::text[], $12::text[], $13::text[])
              AS x(d, m, mode, c, a, i, r, k, descr, upi, bank)
         ON CONFLICT (user_id, dedupe_key) DO NOTHING
         RETURNING id`,
        [
          userId,
          stmt.id,
          t.map((x) => x.date),
          t.map((x) => x.merchant),
          t.map((x) => x.mode),
          t.map((x) => rules.apply(x.merchant, x.category, x.isIncome)),
          t.map((x) => x.amount),
          t.map((x) => x.isIncome),
          t.map((x) => x.ref),
          t.map((x) => x.dedupeKey),
          t.map((x) => x.description),
          t.map((x) => x.upiId),
          t.map((x) => x.bank),
        ],
      );
      const added = inserted.rowCount ?? 0;
      await c.query('UPDATE statements SET txn_count = $2 WHERE id = $1', [stmt.id, added]);
      stmt.txn_count = added;
      await recomputeOpeningBalance(c, userId);
      return { stmt, added, skipped: t.length - added };
    });
  } catch (err) {
    await storage.delete(key).catch(() => undefined); // do not leave an orphan file
    throw err;
  }

  // password bookkeeping happens after the import succeeded, and never fails it
  let savedPassword: { id: string; label: string } | null = null;
  try {
    if (usedSaved) await passwords.touchPassword(userId, usedSaved.id);
    else if (typedPassword && opts.savePassword) {
      savedPassword = await passwords.saveTypedPassword(userId, typedPassword, opts.passwordLabel);
    }
  } catch (err) {
    logger.warn({ err }, 'saving the pdf password failed');
  }

  return {
    statement: toStatementDto(result.stmt),
    added: result.added,
    skippedDuplicates: result.skipped,
    unlockedWith: usedSaved ? { id: usedSaved.id, label: usedSaved.label } : null,
    savedPassword,
  };
}

export async function listStatements(userId: string) {
  const rows = await query<StatementRow>('SELECT * FROM statements WHERE user_id = $1 ORDER BY period_start DESC NULLS LAST, created_at DESC', [userId]);
  return rows.map(toStatementDto);
}

export async function getStatement(userId: string, id: string): Promise<StatementRow> {
  const row = (await query<StatementRow>('SELECT * FROM statements WHERE id = $1 AND user_id = $2', [id, userId]))[0];
  if (!row) throw notFound('Statement not found');
  return row;
}

/** The stored PDF, ready to send: decrypted, and without a password. */
export async function openStatementFile(row: StatementRow): Promise<{ data: Buffer | Readable; fileName: string }> {
  const stream = await storage.stream(row.storage_key);
  const base = row.original_name.replace(/\.pdf$/i, '');
  const fileName = `${base}${row.was_locked ? '-unlocked' : ''}.pdf`;
  if (!row.file_encrypted) return { data: stream, fileName }; // files saved before encryption existed
  return { data: decryptBuffer(await readAll(stream)), fileName };
}

/** Deletes the statement, the transactions imported from it (cascade) and the stored file. */
export async function deleteStatement(userId: string, id: string) {
  const row = await getStatement(userId, id);
  await withTransaction(async (c) => {
    await c.query('DELETE FROM statements WHERE id = $1 AND user_id = $2', [id, userId]);
    await recomputeOpeningBalance(c, userId);
  });
  await storage.delete(row.storage_key).catch((err) => logger.warn({ err, key: row.storage_key }, 'file delete failed'));
}
