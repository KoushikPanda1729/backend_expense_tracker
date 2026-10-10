import { randomUUID } from 'node:crypto';
import { logger } from '../../config/logger';
import { query, withTransaction } from '../../db/pool';
import { AppError, unprocessable } from '../../lib/errors';
import { storage } from '../../storage';

/** Recognises the image by its first bytes (the client-sent mime type cannot be trusted). */
export function sniffImage(buf: Buffer): { ext: string; mime: string } | null {
  if (buf.length > 12 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { ext: 'png', mime: 'image/png' };
  }
  if (buf.length > 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') {
    return { ext: 'webp', mime: 'image/webp' };
  }
  return null;
}

const quietDelete = (key: string) =>
  storage.delete(key).catch((err) => logger.warn({ err, key }, 'file delete failed'));

// ponytail: saved as uploaded (max 5 MB). Resize/compress with sharp if photos get heavy.
export async function setPhoto(userId: string, buf: Buffer) {
  const img = sniffImage(buf);
  if (!img) throw unprocessable('Use a JPEG, PNG or WebP image');

  const key = `avatars/${userId}/${randomUUID()}.${img.ext}`;
  await storage.put(key, buf, img.mime);
  const old = (await query<{ photo_key: string | null }>('SELECT photo_key FROM users WHERE id = $1', [userId]))[0]?.photo_key;
  try {
    await query('UPDATE users SET photo_key = $2, updated_at = now() WHERE id = $1', [userId, key]);
  } catch (err) {
    await quietDelete(key);
    throw err;
  }
  if (old) await quietDelete(old);
}

export async function getPhoto(userId: string) {
  const key = (await query<{ photo_key: string | null }>('SELECT photo_key FROM users WHERE id = $1', [userId]))[0]?.photo_key;
  if (!key) throw new AppError(404, 'NOT_FOUND', 'No profile photo');
  const ext = key.split('.').pop();
  const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  return { mime, stream: await storage.stream(key) };
}

export async function removePhoto(userId: string) {
  const old = (await query<{ photo_key: string | null }>('SELECT photo_key FROM users WHERE id = $1', [userId]))[0]?.photo_key;
  await query('UPDATE users SET photo_key = NULL, updated_at = now() WHERE id = $1', [userId]);
  if (old) await quietDelete(old);
}

export const DATA_SCOPES = ['transactions', 'budgets', 'passwords', 'photo'] as const;
export type DataScope = (typeof DATA_SCOPES)[number];

/**
 * Deletes the chosen parts of the user's data. Keeps the account and login.
 * - transactions: every transaction, every imported statement and its stored PDF (they are linked)
 * - budgets, passwords (saved PDF passwords), photo (profile photo)
 */
export async function deleteData(userId: string, scopes: readonly DataScope[]) {
  const has = (s: DataScope) => scopes.includes(s);
  const keys = has('transactions')
    ? (await query<{ storage_key: string }>('SELECT storage_key FROM statements WHERE user_id = $1', [userId])).map(
        (r) => r.storage_key,
      )
    : [];
  await withTransaction(async (c) => {
    if (has('transactions')) {
      await c.query('DELETE FROM transactions WHERE user_id = $1', [userId]);
      await c.query('DELETE FROM statements WHERE user_id = $1', [userId]);
      await c.query('UPDATE users SET opening_balance = 0, updated_at = now() WHERE id = $1', [userId]);
    }
    if (has('budgets')) await c.query('DELETE FROM budgets WHERE user_id = $1', [userId]);
    if (has('passwords')) await c.query('DELETE FROM pdf_passwords WHERE user_id = $1', [userId]);
  });
  await Promise.all(keys.map(quietDelete));
  if (has('photo')) await removePhoto(userId);
}

/** Deletes the account and everything that belongs to it, files included. */
export async function deleteAccount(userId: string) {
  const files = (
    await query<{ k: string }>(
      `SELECT storage_key AS k FROM statements WHERE user_id = $1
       UNION ALL SELECT photo_key FROM users WHERE id = $1 AND photo_key IS NOT NULL`,
      [userId],
    )
  ).map((r) => r.k);
  await query('DELETE FROM users WHERE id = $1', [userId]); // cascades to every table
  await Promise.all(files.map(quietDelete));
}
