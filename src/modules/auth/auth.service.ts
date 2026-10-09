import argon2 from 'argon2';
import { env } from '../../config/env';
import { query } from '../../db/pool';
import { randomToken, sha256 } from '../../lib/crypto';
import { conflict, isUniqueViolation, unauthorized } from '../../lib/errors';
import { LoginInput, RegisterInput } from './auth.schemas';
import { signAccessToken } from './tokens';

export interface UserRow {
  id: string;
  name: string;
  country_code: string;
  phone: string;
  phone_e164: string;
  password_hash: string;
  created_at: string;
}

export interface RequestMeta {
  userAgent?: string;
  ip?: string;
}

export const toPublicUser = (u: UserRow) => ({
  id: u.id,
  name: u.name,
  countryCode: u.country_code,
  phone: u.phone,
  createdAt: u.created_at,
});

const hashPassword = (p: string) => argon2.hash(p, { type: argon2.argon2id });

// Verified against when the phone number is unknown, so a miss takes as long as a hit.
const dummyHash = hashPassword('not-a-real-password');

async function issueTokens(userId: string, meta: RequestMeta) {
  const refreshToken = randomToken();
  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, user_agent, ip)
     VALUES ($1, $2, now() + ($3 || ' days')::interval, $4, $5)`,
    [userId, sha256(refreshToken), String(env.REFRESH_TOKEN_TTL_DAYS), meta.userAgent ?? null, meta.ip ?? null],
  );
  return {
    tokenType: 'Bearer' as const,
    accessToken: signAccessToken(userId),
    refreshToken,
  };
}

export async function register(input: RegisterInput, meta: RequestMeta) {
  const e164 = `${input.countryCode}${input.phone}`;
  const hash = await hashPassword(input.password);
  let user: UserRow;
  try {
    const rows = await query<UserRow>(
      `INSERT INTO users (name, country_code, phone, phone_e164, password_hash)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [input.name, input.countryCode, input.phone, e164, hash],
    );
    user = rows[0]!;
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('An account with this phone number already exists');
    throw err;
  }
  return { user: toPublicUser(user), ...(await issueTokens(user.id, meta)) };
}

export async function login(input: LoginInput, meta: RequestMeta) {
  const e164 = `${input.countryCode}${input.phone}`;
  const user = (await query<UserRow>('SELECT * FROM users WHERE phone_e164 = $1', [e164]))[0];
  const ok = await argon2.verify(user?.password_hash ?? (await dummyHash), input.password);
  if (!user || !ok) throw unauthorized('Invalid phone number or password');
  return { user: toPublicUser(user), ...(await issueTokens(user.id, meta)) };
}

/** Rotates the refresh token. A token that is used twice revokes every session of that user. */
export async function refresh(token: string, meta: RequestMeta) {
  const row = (
    await query<{ id: string; user_id: string; revoked_at: string | null; expires_at: string }>(
      'SELECT id, user_id, revoked_at, expires_at FROM refresh_tokens WHERE token_hash = $1',
      [sha256(token)],
    )
  )[0];
  if (!row) throw unauthorized('Invalid refresh token');
  if (row.revoked_at) {
    await query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [row.user_id]);
    throw unauthorized('Refresh token was already used');
  }
  if (new Date(row.expires_at) < new Date()) throw unauthorized('Refresh token expired');
  await query('UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1', [row.id]);
  return issueTokens(row.user_id, meta);
}

export async function logout(token: string) {
  await query('UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [
    sha256(token),
  ]);
}

export async function revokeAllSessions(userId: string) {
  await query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
}
