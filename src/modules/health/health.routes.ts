import { Router } from 'express';
import { pool } from '../../db/pool';

export const healthRouter = Router();

// liveness: the process is up
healthRouter.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: Math.round(process.uptime()) });
});

// readiness: the database answers too (use this for load balancers / orchestrators)
healthRouter.get('/ready', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ready' });
  } catch {
    res.status(503).json({ status: 'unavailable' });
  }
});
