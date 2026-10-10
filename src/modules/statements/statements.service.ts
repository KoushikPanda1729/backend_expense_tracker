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
import { findManualMatches, ManualRow } from './manualMatch';
import { ParsedStatement, ParsedTxn, parseSbiText } from './sbi.parser';

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

interface ExistingRow {
  id: string;
  dedupe_key: string;
  txn_date: string;
  merchant: string;
  category: string;
  amount: number;
}

/**
 * Rows the user already has (same bank reference) whose date, amount, name or category differ from what this
 * file says. The user decides per row: accept = take the bank's version, reject = keep their own.
 */
async function diffExisting(userId: string, t: ParsedTxn[], have: Set<string>) {
  const keys = t.filter((x) => have.has(x.dedupeKey)).map((x) => x.dedupeKey);
  if (keys.length === 0) return [];
  const rules = await payees.loadRules(userId);
  const rows = await query<ExistingRow>(
    'SELECT id, dedupe_key, txn_date, merchant, category, amount FROM transactions WHERE user_id = $1 AND dedupe_key = ANY($2::text[])',
    [userId, keys],
  );
  const byKey = new Map(rows.map((r) => [r.dedupe_key, r]));
  const out: {
    id: string;
    key: string;
    isIncome: boolean;
    fields: string[];
    yours: { date: string; name: string; category: string; amount: number };
    bank: { date: string; name: string; category: string; amount: number; description: string; upiId: string | null; bankCode: string | null };
  }[] = [];
  for (const b of t) {
    const r = byKey.get(b.dedupeKey);
    if (!r) continue;
    const bankCategory = rules.apply(b.merchant, b.category, b.isIncome);
    const fields = [
      r.txn_date !== b.date && 'date',
      Math.abs(r.amount - b.amount) > 0.004 && 'amount',
      r.merchant !== b.merchant && 'name',
      r.category !== bankCategory && 'category',
    ].filter((f): f is string => typeof f === 'string');
    if (fields.length === 0) continue;
    out.push({
      id: r.id,
      key: b.dedupeKey,
      isIncome: b.isIncome,
      fields,
      yours: { date: r.txn_date, name: r.merchant, category: r.category, amount: r.amount },
      bank: {
        date: b.date, name: b.merchant, category: bankCategory, amount: b.amount,
        description: b.description, upiId: b.upiId, bankCode: b.bank,
      },
    });
  }
  return out.slice(0, 300);
}

/** Takes the bank's version for the rows the user accepted. Only rows the server itself found different are touched. */
async function applyChanges(userId: string, t: ParsedTxn[], have: Set<string>, ids: string[]) {
  if (ids.length === 0) return 0;
  const wanted = new Set(ids);
  const changes = (await diffExisting(userId, t, have)).filter((c) => wanted.has(c.id));
  const byKey = new Map(t.map((x) => [x.dedupeKey, x]));
  for (const c of changes) {
    const b = byKey.get(c.key)!;
    await query(
      `UPDATE transactions SET txn_date = $3, amount = $4, merchant = $5, category = $6, description = $7,
              upi_id = $8, bank = $9, updated_at = now()
        WHERE id = $1 AND user_id = $2`,
      [c.id, userId, c.bank.date, c.bank.amount, c.bank.name, c.bank.category, b.description, b.upiId, b.bank],
    );
  }
  return changes.length;
}

/** Entries the user added by hand that look like rows of this statement (only rows the user does not have yet). */
async function manualMatches(
  run: (sql: string, params: unknown[]) => Promise<ManualRow[]>,
  userId: string,
  t: ParsedTxn[],
  have: Set<string>,
) {
  const fresh = t.filter((x) => !have.has(x.dedupeKey));
  if (fresh.length === 0) return [];
  const manual = await run(
    `SELECT id, txn_date, merchant, category, amount, is_income, note, label FROM transactions
      WHERE user_id = $1 AND statement_id IS NULL AND dedupe_key LIKE 'm:%' AND mode NOT IN ('Cash', 'Wallet')
        AND txn_date BETWEEN ($2::date - 1) AND ($3::date + 1)`,
    [userId, t[0]!.date, t[t.length - 1]!.date],
  );
  return findManualMatches(fresh, manual);
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
  const matches = await manualMatches((sql, p) => query<ManualRow>(sql, p), userId, t, have);
  const changes = await diffExisting(userId, t, have);

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
    // rows the user already has that differ from this file: the user accepts or rejects each one
    changes,
    // entries the user added by hand that look like rows of this file: the user accepts or rejects each one
    manualMatches: matches.map((m) => ({
      manualId: m.manual.id,
      key: m.bank.dedupeKey,
      daysApart: m.daysApart,
      manual: {
        date: m.manual.txn_date,
        name: m.manual.merchant,
        category: m.manual.category,
        amount: m.manual.amount,
        isIncome: m.manual.is_income,
        note: m.manual.note,
        label: m.manual.label,
      },
      bank: {
        date: m.bank.date,
        name: m.bank.merchant,
        category: m.bank.category,
        amount: m.bank.amount,
        description: m.bank.description,
        upiId: m.bank.upiId,
        ref: m.bank.ref,
      },
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
  /** Hand-added entries the user accepted as the same payment as a statement row (manualId + the row's key). */
  merge?: { manualId: string; key: string }[];
  /** Ids of existing transactions where the user accepted the bank's version. */
  apply?: string[];
}

/** Step 2: store the unlocked PDF (encrypted at rest) and import its transactions. */
export async function uploadStatement(userId: string, file: Express.Multer.File, opts: UploadOptions) {
  const original = file.buffer;
  const { parsed, unlocked, wasLocked, usedSaved, typedPassword } = await prepare(userId, original, opts);

  const hash = sha256(original); // of the file as uploaded, so the same download is not imported twice
  const dup = (await query<{ id: string }>('SELECT id FROM statements WHERE user_id = $1 AND sha256 = $2', [userId, hash]))[0];
  if (dup) {
    // the same file again: nothing to import, but the user may still accept the bank's version of rows they edited
    if (opts.apply && opts.apply.length > 0) {
      const have = await existingKeys(userId, parsed.txns.map((x) => x.dedupeKey));
      const applied = await applyChanges(userId, parsed.txns, have, opts.apply);
      return {
        statement: toStatementDto(await getStatement(userId, dup.id)),
        added: 0,
        skippedDuplicates: parsed.txns.length,
        merged: 0,
        applied,
        unlockedWith: usedSaved ? { id: usedSaved.id, label: usedSaved.label } : null,
        savedPassword: null,
      };
    }
    throw conflict('This statement was already uploaded', { statementId: dup.id });
  }

  // only the unlocked copy is kept, encrypted with the server key
  const key = `statements/${userId}/${randomUUID()}.pdf.enc`;
  await storage.put(key, encryptBuffer(unlocked), 'application/octet-stream');

  const rules = await payees.loadRules(userId); // categories the user chose for payees
  let result;
  try {
    result = await withTransaction(async (c) => {
      const t = parsed.txns;
      const have = await existingKeys(userId, t.map((x) => x.dedupeKey));
      const wanted = opts.merge ?? [];
      // only pairs the server itself would suggest can be merged (the client cannot invent one)
      const accepted = (await manualMatches((sql, p) => c.query<ManualRow>(sql, p).then((r) => r.rows), userId, t, have)).filter(
        (m) => wanted.some((w) => w.manualId === m.manual.id && w.key === m.bank.dedupeKey),
      );
      const mergedKeys = new Set(accepted.map((m) => m.bank.dedupeKey));
      const ins = t.filter((x) => !mergedKeys.has(x.dedupeKey));
      const stmt = (
        await c.query<StatementRow>(
          `INSERT INTO statements
             (user_id, original_name, storage_key, size_bytes, sha256, status, period_start, period_end,
              opening_balance, closing_balance, file_encrypted, was_locked, balance_asof_date, balance_asof)
           VALUES ($1, $2, $3, $4, $5, 'parsed', $6, $7, $8, $9, true, $10, $11, $12) RETURNING *`,
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
            parsed.asOf?.date ?? null,
            parsed.asOf?.amount ?? null,
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
          ins.map((x) => x.date),
          ins.map((x) => x.merchant),
          ins.map((x) => x.mode),
          ins.map((x) => rules.apply(x.merchant, x.category, x.isIncome)),
          ins.map((x) => x.amount),
          ins.map((x) => x.isIncome),
          ins.map((x) => x.ref),
          ins.map((x) => x.dedupeKey),
          ins.map((x) => x.description),
          ins.map((x) => x.upiId),
          ins.map((x) => x.bank),
        ],
      );
      const added = inserted.rowCount ?? 0;

      // accepted pairs: the hand-added row becomes the bank row (keeps the user's name, category, note and label)
      for (const m of accepted) {
        await c.query(
          `UPDATE transactions SET statement_id = $3, txn_date = $4, dedupe_key = $5, ref = $6, description = $7,
                  upi_id = $8, bank = $9, mode = $10, updated_at = now()
            WHERE id = $1 AND user_id = $2 AND statement_id IS NULL`,
          [m.manual.id, userId, stmt.id, m.bank.date, m.bank.dedupeKey, m.bank.ref, m.bank.description, m.bank.upiId, m.bank.bank, m.bank.mode],
        );
      }

      // rows an older, overlapping statement already had now belong to this newer one, so the older
      // statement can be deleted without losing them
      await c.query(
        `UPDATE transactions SET statement_id = $2
          WHERE user_id = $1 AND dedupe_key = ANY($3::text[]) AND statement_id IS NOT NULL AND statement_id <> $2`,
        [userId, stmt.id, t.map((x) => x.dedupeKey)],
      );
      await c.query(
        `UPDATE statements s SET txn_count = (SELECT COUNT(*) FROM transactions x WHERE x.statement_id = s.id)
          WHERE s.user_id = $1`,
        [userId],
      );
      stmt.txn_count = (await c.query<{ n: number }>('SELECT txn_count AS n FROM statements WHERE id = $1', [stmt.id])).rows[0]!.n;
      await recomputeOpeningBalance(c, userId);
      return { stmt, added, skipped: ins.length - added, merged: accepted.length };
    });
  } catch (err) {
    await storage.delete(key).catch(() => undefined); // do not leave an orphan file
    throw err;
  }

  // rows the user chose to take the bank's version of (they existed before this upload)
  const applied = await applyChanges(userId, parsed.txns, new Set(parsed.txns.map((x) => x.dedupeKey)), opts.apply ?? []);

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
    merged: result.merged,
    applied,
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
