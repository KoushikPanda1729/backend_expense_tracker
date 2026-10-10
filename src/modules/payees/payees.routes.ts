import { Router } from 'express';
import { z } from 'zod';
import { CATEGORIES } from '../../lib/categories';
import * as svc from './payees.service';

export const payeesRouter = Router();

const merchant = z.string().trim().min(1).max(120);

// the payees the user has told the app about
payeesRouter.get('/', async (req, res) => {
  res.json({ items: await svc.listRules(req.userId) });
});

// "I know this payee": { merchant, category, label? }. Moves existing payments and is applied to later imports.
payeesRouter.put('/', async (req, res) => {
  const b = z
    .object({ merchant, category: z.enum(CATEGORIES), label: z.string().trim().max(60).optional() })
    .parse(req.body);
  res.json(await svc.setRule(req.userId, b.merchant, b.category, b.label || null));
});

payeesRouter.delete('/', async (req, res) => {
  const q = z.object({ merchant }).parse(req.query);
  await svc.deleteRule(req.userId, q.merchant);
  res.status(204).end();
});
