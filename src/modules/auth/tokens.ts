import jwt, { SignOptions } from 'jsonwebtoken';
import { env } from '../../config/env';

export function signAccessToken(userId: string): string {
  return jwt.sign({}, env.JWT_ACCESS_SECRET, {
    subject: userId,
    algorithm: 'HS256',
    expiresIn: env.ACCESS_TOKEN_TTL as SignOptions['expiresIn'],
  });
}

/** Returns the user id, throws if the token is invalid or expired. */
export function verifyAccessToken(token: string): string {
  const payload = jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ['HS256'] });
  if (typeof payload === 'string' || !payload.sub) throw new Error('bad token');
  return payload.sub;
}
