import { describe, expect, it } from 'vitest';
import { DbStorage, RunQuery } from '../src/storage/db';

/** An in-memory stand-in for the `files` table. */
function fakeDb() {
  const rows = new Map<string, { data: Buffer; mime: string; size: number }>();
  const run = (async (sql: string, p: unknown[]) => {
    if (sql.startsWith('INSERT')) {
      const [key, data, mime, size] = p as [string, Buffer, string, number];
      if (rows.has(key)) throw Object.assign(new Error('duplicate key'), { code: '23505' });
      rows.set(key, { data, mime, size });
      return [];
    }
    if (sql.startsWith('SELECT')) {
      const r = rows.get(p[0] as string);
      return r ? [{ data: r.data }] : [];
    }
    if (sql.startsWith('DELETE')) {
      rows.delete(p[0] as string);
      return [];
    }
    throw new Error(`unexpected sql ${sql}`);
  }) as unknown as RunQuery;
  return { rows, run };
}

describe('DbStorage', () => {
  it('stores, reads back and deletes a file', async () => {
    const db = fakeDb();
    const st = new DbStorage(db.run);
    await st.put('statements/u1/a.pdf.enc', Buffer.from('hello'), 'application/octet-stream');
    expect(db.rows.get('statements/u1/a.pdf.enc')).toMatchObject({ mime: 'application/octet-stream', size: 5 });

    const chunks: Buffer[] = [];
    for await (const c of await st.stream('statements/u1/a.pdf.enc')) chunks.push(Buffer.from(c));
    expect(Buffer.concat(chunks).toString()).toBe('hello');

    await st.delete('statements/u1/a.pdf.enc');
    expect(db.rows.size).toBe(0);
    await st.delete('statements/u1/a.pdf.enc'); // deleting twice is fine
  });

  it('never overwrites an existing key', async () => {
    const st = new DbStorage(fakeDb().run);
    await st.put('avatars/u/1.png', Buffer.from('a'), 'image/png');
    await expect(st.put('avatars/u/1.png', Buffer.from('b'), 'image/png')).rejects.toThrow('duplicate key');
  });

  it('turns a missing file into a 404', async () => {
    await expect(new DbStorage(fakeDb().run).stream('avatars/x/none.png')).rejects.toMatchObject({ status: 404 });
  });

  it('refuses keys that could climb out', async () => {
    const st = new DbStorage(fakeDb().run);
    for (const bad of ['../x', 'a/../b', '/abs', 'a//b']) {
      await expect(st.put(bad, Buffer.from('x'), 'text/plain')).rejects.toThrow('Invalid storage key');
    }
  });
});
