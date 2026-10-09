import { createApp } from './app';
import { env } from './config/env';
import { logger } from './config/logger';
import { pool } from './db/pool';

async function main() {
  // fail fast if the database is not reachable
  await pool.query('SELECT 1');

  const server = createApp().listen(env.PORT, () => {
    logger.info(`API listening on :${env.PORT} (${env.NODE_ENV})`);
  });

  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    logger.info(`${signal} received, shutting down`);
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref(); // give up if connections hang
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'));

main().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
