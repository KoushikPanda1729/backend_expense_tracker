import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { S3Storage } from '../src/storage/s3';

/** An in-memory stand-in for the S3 client: understands put, get and delete by command name. */
function fakeS3() {
  const objects = new Map<string, { body: Buffer; type?: string; sse?: string }>();
  const calls: string[] = [];
  return {
    objects,
    calls,
    client: {
      async send(cmd: unknown) {
        const c = cmd as { constructor: { name: string }; input: Record<string, any> };
        const name = c.constructor.name;
        calls.push(name);
        const k = `${c.input.Bucket}/${c.input.Key}`;
        if (name === 'PutObjectCommand') {
          objects.set(k, { body: c.input.Body, type: c.input.ContentType, sse: c.input.ServerSideEncryption });
          return {};
        }
        if (name === 'GetObjectCommand') {
          const o = objects.get(k);
          if (!o) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
          return { Body: Readable.from(o.body) };
        }
        if (name === 'DeleteObjectCommand') {
          objects.delete(k);
          return {};
        }
        throw new Error(`unexpected ${name}`);
      },
    },
  };
}

describe('S3Storage', () => {
  it('stores, reads back and deletes a file under its prefix, encrypted at rest', async () => {
    const s3 = fakeS3();
    const st = new S3Storage('my-bucket', 'kharcha/', s3.client);
    await st.put('statements/u1/a.pdf.enc', Buffer.from('hello'), 'application/octet-stream');
    const stored = s3.objects.get('my-bucket/kharcha/statements/u1/a.pdf.enc')!;
    expect(stored.type).toBe('application/octet-stream');
    expect(stored.sse).toBe('AES256');

    const chunks: Buffer[] = [];
    for await (const c of await st.stream('statements/u1/a.pdf.enc')) chunks.push(Buffer.from(c));
    expect(Buffer.concat(chunks).toString()).toBe('hello');

    await st.delete('statements/u1/a.pdf.enc');
    expect(s3.objects.size).toBe(0);
    await st.delete('statements/u1/a.pdf.enc'); // deleting twice is fine
  });

  it('turns a missing object into a 404 error', async () => {
    const st = new S3Storage('b', '', fakeS3().client);
    await expect(st.stream('avatars/x/none.png')).rejects.toMatchObject({ status: 404 });
  });

  it('refuses keys that could climb out of the prefix', async () => {
    const st = new S3Storage('b', 'p/', fakeS3().client);
    for (const bad of ['../x', 'a/../b', '/abs', 'a//b']) {
      await expect(st.put(bad, Buffer.from('x'), 'text/plain')).rejects.toThrow('Invalid storage key');
    }
  });
});
