import { describe, expect, it } from 'vitest';
import { sniffImage } from '../src/modules/users/users.service';

describe('sniffImage', () => {
  it('recognises JPEG, PNG and WebP by their first bytes', () => {
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(16).fill(0)]))?.ext).toBe('jpg');
    expect(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(16).fill(0)]))?.ext).toBe('png');
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(8)]);
    expect(sniffImage(webp)?.ext).toBe('webp');
  });

  it('rejects anything else, whatever the client says it is', () => {
    expect(sniffImage(Buffer.from('<?php echo 1; ?>'.padEnd(32, ' ')))).toBeNull();
    expect(sniffImage(Buffer.from('%PDF-1.7'.padEnd(32, ' ')))).toBeNull();
  });
});
