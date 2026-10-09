import { query } from '../../db/pool';
import { decryptText, encryptText } from '../../lib/secretbox';
import { conflict, isUniqueViolation, notFound, unprocessable } from '../../lib/errors';

interface Row {
  id: string;
  label: string;
  secret_enc: string;
  last_used_at: string | null;
  created_at: string;
}

const MAX_SAVED = 20;

// the password itself is never part of a response
const toDto = (r: Row) => ({ id: r.id, label: r.label, lastUsedAt: r.last_used_at, createdAt: r.created_at });

export async function listPasswords(userId: string) {
  const rows = await query<Row>(
    'SELECT * FROM pdf_passwords WHERE user_id = $1 ORDER BY last_used_at DESC NULLS LAST, created_at DESC',
    [userId],
  );
  return rows.map(toDto);
}

export async function createPassword(userId: string, label: string, password: string) {
  const count = (await query<{ n: number }>('SELECT COUNT(*)::int AS n FROM pdf_passwords WHERE user_id = $1', [userId]))[0]!.n;
  if (count >= MAX_SAVED) throw unprocessable(`You can save up to ${MAX_SAVED} passwords`);
  try {
    const rows = await query<Row>(
      'INSERT INTO pdf_passwords (user_id, label, secret_enc) VALUES ($1, $2, $3) RETURNING *',
      [userId, label, encryptText(password)],
    );
    return toDto(rows[0]!);
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('You already have a saved password with that label');
    throw err;
  }
}

export async function updatePassword(userId: string, id: string, patch: { label?: string; password?: string }) {
  try {
    const rows = await query<Row>(
      `UPDATE pdf_passwords SET label = COALESCE($3, label), secret_enc = COALESCE($4, secret_enc)
        WHERE id = $1 AND user_id = $2 RETURNING *`,
      [id, userId, patch.label ?? null, patch.password ? encryptText(patch.password) : null],
    );
    if (!rows[0]) throw notFound('Saved password not found');
    return toDto(rows[0]);
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('You already have a saved password with that label');
    throw err;
  }
}

export async function deletePassword(userId: string, id: string) {
  const rows = await query('DELETE FROM pdf_passwords WHERE id = $1 AND user_id = $2 RETURNING id', [id, userId]);
  if (rows.length === 0) throw notFound('Saved password not found');
}

// ---- used by the statement upload ----

export interface SavedSecret {
  id: string;
  label: string;
  password: string;
}

/** Decrypts one saved password (to unlock a PDF). */
export async function getSecret(userId: string, id: string): Promise<SavedSecret> {
  const r = (await query<Row>('SELECT * FROM pdf_passwords WHERE id = $1 AND user_id = $2', [id, userId]))[0];
  if (!r) throw notFound('Saved password not found');
  return { id: r.id, label: r.label, password: decryptText(r.secret_enc) };
}

/** Every saved password, most recently used first (tried one by one on a locked PDF). */
export async function allSecrets(userId: string): Promise<SavedSecret[]> {
  const rows = await query<Row>(
    'SELECT * FROM pdf_passwords WHERE user_id = $1 ORDER BY last_used_at DESC NULLS LAST, created_at DESC',
    [userId],
  );
  return rows.map((r) => ({ id: r.id, label: r.label, password: decryptText(r.secret_enc) }));
}

export const touchPassword = (userId: string, id: string) =>
  query('UPDATE pdf_passwords SET last_used_at = now() WHERE id = $1 AND user_id = $2', [id, userId]);

/** Saves a password the user just typed, unless the same one is already saved. */
export async function saveTypedPassword(userId: string, password: string, label?: string) {
  const existing = (await allSecrets(userId)).find((s) => s.password === password);
  if (existing) {
    await touchPassword(userId, existing.id);
    return { id: existing.id, label: existing.label };
  }
  const name = label?.trim() || `Statement password ${new Date().toISOString().slice(0, 10)}`;
  try {
    const saved = await createPassword(userId, name, password);
    await touchPassword(userId, saved.id);
    return { id: saved.id, label: saved.label };
  } catch (err) {
    // label taken or the 20 limit reached: the upload itself still worked, so do not fail it
    return null;
  }
}
