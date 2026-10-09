import { Pool, PoolClient, QueryResultRow, types } from 'pg';
import { env } from '../config/env';
import { logger } from '../config/logger';

// numeric -> number, date -> 'YYYY-MM-DD' string (no timezone shifts), bigint -> number
types.setTypeParser(1700, (v) => parseFloat(v));
types.setTypeParser(1082, (v) => v);
types.setTypeParser(20, (v) => Number(v));

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.DB_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => logger.error({ err }, 'unexpected error on idle postgres client'));

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await pool.query<T>(text, params);
  return res.rows;
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
