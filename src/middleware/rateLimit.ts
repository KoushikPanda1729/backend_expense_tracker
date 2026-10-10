import rateLimit from 'express-rate-limit';

const body = (message: string) => ({ error: { code: 'RATE_LIMITED', message } });

/** Applies to every request. */
export const globalLimiter = rateLimit({
  windowMs: 60_000,
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: body('Too many requests, slow down'),
});

/** Login / register / refresh: slows down password guessing. */
export const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: body('Too many attempts, try again in a few minutes'),
});

/** Refresh runs on every access-token renewal, so it gets more room than login (still capped). */
export const refreshLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 200,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: body('Too many requests, try again in a few minutes'),
});

/** Uploads are the expensive calls. */
export const uploadLimiter = rateLimit({
  windowMs: 60 * 60_000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: body('Too many uploads, try again later'),
});
