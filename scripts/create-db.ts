/**
 * Creates the application database (default: kharcha_db) on the Postgres server in
 * DATABASE_URL, next to your other databases. Safe to run twice.
 */
import 'dotenv/config';
import { Client } from 'pg';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set (copy .env.example to .env)');

  const target = new URL(url);
  const dbName = decodeURIComponent(target.pathname.replace(/^\//, ''));
  if (!/^[a-zA-Z0-9_]+$/.test(dbName)) {
    throw new Error(`Database name "${dbName}" must only contain letters, digits and underscores`);
  }

  // Connect to the maintenance database to create ours.
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const client = new Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (exists.rowCount) {
      console.log(`Database "${dbName}" already exists.`);
    } else {
      await client.query(`CREATE DATABASE "${dbName}"`);
      console.log(`Created database "${dbName}".`);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
