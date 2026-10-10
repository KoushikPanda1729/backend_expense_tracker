import { Request, Router } from 'express';
import { authLimiter, refreshLimiter } from '../../middleware/rateLimit';
import { loginSchema, refreshSchema, registerSchema } from './auth.schemas';
import * as auth from './auth.service';

export const authRouter = Router();

const meta = (req: Request): auth.RequestMeta => ({ userAgent: req.get('user-agent') ?? undefined, ip: req.ip });

authRouter.post('/register', authLimiter, async (req, res) => {
  const body = registerSchema.parse(req.body);
  res.status(201).json(await auth.register(body, meta(req)));
});

authRouter.post('/login', authLimiter, async (req, res) => {
  const body = loginSchema.parse(req.body);
  res.json(await auth.login(body, meta(req)));
});

authRouter.post('/refresh', refreshLimiter, async (req, res) => {
  const { refreshToken } = refreshSchema.parse(req.body);
  res.json(await auth.refresh(refreshToken, meta(req)));
});

authRouter.post('/logout', async (req, res) => {
  const { refreshToken } = refreshSchema.parse(req.body);
  await auth.logout(refreshToken);
  res.status(204).end();
});
