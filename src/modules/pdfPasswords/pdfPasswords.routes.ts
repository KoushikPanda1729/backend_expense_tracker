import { Router } from 'express';
import { z } from 'zod';
import * as svc from './pdfPasswords.service';

export const pdfPasswordsRouter = Router();

const idParam = z.object({ id: z.string().uuid() });
const label = z.string().trim().min(1).max(60);
const secret = z.string().min(1).max(100);

// the dropdown in the upload screen: ids and labels only
pdfPasswordsRouter.get('/', async (req, res) => {
  res.json({ items: await svc.listPasswords(req.userId) });
});

pdfPasswordsRouter.post('/', async (req, res) => {
  const body = z.object({ label, password: secret }).parse(req.body);
  res.status(201).json(await svc.createPassword(req.userId, body.label, body.password));
});

pdfPasswordsRouter.patch('/:id', async (req, res) => {
  const { id } = idParam.parse(req.params);
  const body = z
    .object({ label: label.optional(), password: secret.optional() })
    .refine((v) => v.label !== undefined || v.password !== undefined, { message: 'Send label or password' })
    .parse(req.body);
  res.json(await svc.updatePassword(req.userId, id, body));
});

pdfPasswordsRouter.delete('/:id', async (req, res) => {
  const { id } = idParam.parse(req.params);
  await svc.deletePassword(req.userId, id);
  res.status(204).end();
});
