import { createHash, randomBytes } from 'node:crypto';

export const sha256 = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');

/** Opaque random token (refresh tokens). Only its hash is stored. */
export const randomToken = () => randomBytes(48).toString('base64url');
