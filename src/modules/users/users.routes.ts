import argon2 from 'argon2';
import { Router } from 'express';
import multer from 'multer';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { query } from '../../db/pool';
import { AppError, notFound, unauthorized } from '../../lib/errors';
import { password } from '../auth/auth.schemas';
import { revokeAllSessions, toPublicUser, UserRow } from '../auth/auth.service';
import * as users from './users.service';

export const usersRouter = Router();

const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});

const loadUser = async (id: string) => {
  const user = (await query<UserRow>('SELECT * FROM users WHERE id = $1', [id]))[0];
  if (!user) throw notFound('User not found');
  return user;
};

usersRouter.get('/me', async (req, res) => {
  res.json(toPublicUser(await loadUser(req.userId)));
});

usersRouter.patch('/me', async (req, res) => {
  const body = z
    .object({
      name: z.string().trim().min(2).max(60).optional(),
      // shown as @handle in the app
      username: z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^[a-z0-9_.]{3,30}$/, 'Use 3-30 letters, digits, dots or underscores')
        .optional(),
    })
    .refine((v) => v.name !== undefined || v.username !== undefined, { message: 'Send name or username' })
    .parse(req.body);

  const rows = await query<UserRow>(
    `UPDATE users SET name = COALESCE($2, name), username = COALESCE($3, username), updated_at = now()
      WHERE id = $1 RETURNING *`,
    [req.userId, body.name ?? null, body.username ?? null],
  );
  if (!rows[0]) throw notFound('User not found');
  res.json(toPublicUser(rows[0]));
});

// profile photo (stored through the storage driver: local disk now, S3 later)
usersRouter.put('/me/photo', photoUpload.single('photo'), async (req, res) => {
  if (!req.file) throw new AppError(400, 'FILE_REQUIRED', 'Attach an image in the "photo" field');
  await users.setPhoto(req.userId, req.file.buffer);
  res.json(toPublicUser(await loadUser(req.userId)));
});

usersRouter.get('/me/photo', async (req, res) => {
  const { mime, stream } = await users.getPhoto(req.userId);
  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', 'private, max-age=300');
  await pipeline(stream, res);
});

usersRouter.delete('/me/photo', async (req, res) => {
  await users.removePhoto(req.userId);
  res.status(204).end();
});

/** There is no "forgot password" yet, so changing it while signed in is the only way. */
usersRouter.post('/me/password', async (req, res) => {
  const body = z.object({ currentPassword: z.string().min(1).max(72), newPassword: password }).parse(req.body);
  const user = await loadUser(req.userId);
  if (!(await argon2.verify(user.password_hash, body.currentPassword))) {
    throw unauthorized('Current password is wrong');
  }
  const hash = await argon2.hash(body.newPassword, { type: argon2.argon2id });
  await query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [req.userId, hash]);
  await revokeAllSessions(req.userId); // sign out every device
  res.status(204).end();
});

// "Delete my data" in the app. ?scope=transactions,budgets,passwords,photo (comma separated, default: the first three).
// transactions also removes the imported statements and their stored PDFs. The account and login stay.
const scopeQuery = z.object({
  scope: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined))
    .pipe(z.array(z.enum(users.DATA_SCOPES)).min(1).optional()),
});
usersRouter.delete('/me/data', async (req, res) => {
  const { scope } = scopeQuery.parse(req.query);
  await users.deleteData(req.userId, scope ?? ['transactions', 'budgets', 'passwords']);
  res.status(204).end();
});

// delete the whole account; asks for the password because it cannot be undone
usersRouter.delete('/me', async (req, res) => {
  const { password: pw } = z.object({ password: z.string().min(1).max(72) }).parse(req.body);
  const user = await loadUser(req.userId);
  if (!(await argon2.verify(user.password_hash, pw))) throw unauthorized('Password is wrong');
  await users.deleteAccount(req.userId);
  res.status(204).end();
});
