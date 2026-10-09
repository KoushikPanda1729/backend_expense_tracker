import { describe, expect, it } from 'vitest';
import { decryptBuffer, decryptText, encryptBuffer, encryptText } from '../src/lib/secretbox';

describe('secretbox', () => {
  it('round-trips text and binary data', () => {
    expect(decryptText(encryptText('my bank pdf password'))).toBe('my bank pdf password');
    const pdf = Buffer.from('%PDF-1.7 pretend file \u0000\u0001ÿ');
    expect(decryptBuffer(encryptBuffer(pdf)).equals(pdf)).toBe(true);
  });

  it('gives different ciphertext every time (random IV)', () => {
    expect(encryptText('same')).not.toBe(encryptText('same'));
  });

  it('does not leave the plain text in the output', () => {
    expect(encryptBuffer(Buffer.from('secret-password')).includes('secret-password')).toBe(false);
  });

  it('detects tampering', () => {
    const blob = encryptBuffer(Buffer.from('hello'));
    blob[blob.length - 1] = blob[blob.length - 1]! ^ 1;
    expect(() => decryptBuffer(blob)).toThrow();
  });
});
