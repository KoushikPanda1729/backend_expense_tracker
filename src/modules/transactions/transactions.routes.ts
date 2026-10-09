import { Router } from 'express';
import { z } from 'zod';
import { createSchema, listQuery, updateSchema } from './transactions.schemas';
import * as svc from './transactions.service';

export const transactionsRouter = Router();

const idParam = z.object({ id: z.string().uuid() });

transactionsRouter.get('/', async (req, res) => {
  res.json(await svc.listTransactions(req.userId, listQuery.parse(req.query)));
});

transactionsRouter.post('/', async (req, res) => {
  res.status(201).json(await svc.createTransaction(req.userId, createSchema.parse(req.body)));
});

transactionsRouter.patch('/:id', async (req, res) => {
  const { id } = idParam.parse(req.params);
  res.json(await svc.updateTransaction(req.userId, id, updateSchema.parse(req.body)));
});

transactionsRouter.delete('/:id', async (req, res) => {
  const { id } = idParam.parse(req.params);
  await svc.deleteTransaction(req.userId, id);
  res.status(204).end();
});
