import { NextFunction, Request, Response } from 'express';
import { unauthorized } from '../lib/errors';
import { verifyAccessToken } from '../modules/auth/tokens';

/** Requires `Authorization: Bearer <access token>` and sets req.userId. */
export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.get('authorization');
  if (!header?.startsWith('Bearer ')) throw unauthorized();
  try {
    req.userId = verifyAccessToken(header.slice(7));
  } catch {
    throw unauthorized('Invalid or expired token');
  }
  next();
}
