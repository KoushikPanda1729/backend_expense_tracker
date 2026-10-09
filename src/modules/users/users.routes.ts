import argon2 from 'argon2';
import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../db/pool';
import { notFound, unauthorized } from '../../lib/errors';
import { password } from '../auth/auth.schemas';
import { revokeAllSessions, toPublicUser, UserRow } from '../auth/auth.service';

export const usersRouter = Router();

usersRouter.get('/me', async (req, res) => {
  const user = (await query<UserRow>('SELECT * FROM users WHERE id = $1', [req.userId]))[0];
  if (!user) throw notFound('User not found');
  res.json(toPublicUser(user));
});

usersRouter.patch('/me', async (req, res) => {
  const { name } = z.object({ name: z.string().trim().min(2).max(60) }).parse(req.body);
  const user = (
    await query<UserRow>('UPDATE users SET name = $2, updated_at = now() WHERE id = $1 RETURNING *', [
      req.userId,
      name,
    ])
  )[0];
  if (!user) throw notFound('User not found');
  res.json(toPublicUser(user));
});

/** There is no "forgot password" yet, so changing it while signed in is the only way. */
usersRouter.post('/me/password', async (req, res) => {
  const body = z.object({ currentPassword: z.string().min(1).max(72), newPassword: password }).parse(req.body);
  const user = (await query<UserRow>('SELECT * FROM users WHERE id = $1', [req.userId]))[0];
  if (!user) throw notFound('User not found');
  if (!(await argon2.verify(user.password_hash, body.currentPassword))) {
    throw unauthorized('Current password is wrong');
  }
  const hash = await argon2.hash(body.newPassword, { type: argon2.argon2id });
  await query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [req.userId, hash]);
  await revokeAllSessions(req.userId); // sign out every device
  res.status(204).end();
});
