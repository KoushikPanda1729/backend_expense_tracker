import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '../config/env';

const key = Buffer.from(env.ENCRYPTION_KEY, 'hex');
const VERSION = 1; // lets the format change later without breaking old data

/** AES-256-GCM. Layout: version(1) | iv(12) | auth tag(16) | ciphertext. */
export function encryptBuffer(plain: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), enc]);
}

/** Throws if the data was changed or the key is wrong. */
export function decryptBuffer(blob: Buffer): Buffer {
  if (blob.length < 29 || blob[0] !== VERSION) throw new Error('Unreadable encrypted data');
  const decipher = createDecipheriv('aes-256-gcm', key, blob.subarray(1, 13));
  decipher.setAuthTag(blob.subarray(13, 29));
  return Buffer.concat([decipher.update(blob.subarray(29)), decipher.final()]);
}

export const encryptText = (s: string) => encryptBuffer(Buffer.from(s, 'utf8')).toString('base64');
export const decryptText = (b64: string) => decryptBuffer(Buffer.from(b64, 'base64')).toString('utf8');
