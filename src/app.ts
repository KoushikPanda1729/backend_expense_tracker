import compression from 'compression';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import pinoHttp from 'pino-http';
import { env, isProd } from './config/env';
import { logger } from './config/logger';
import { errorHandler, notFoundHandler } from './middleware/error';
import { globalLimiter } from './middleware/rateLimit';
import { healthRouter } from './modules/health/health.routes';
import { apiRouter } from './routes';

export function createApp() {
  const app = express();

  app.set('trust proxy', env.TRUST_PROXY);
  app.disable('x-powered-by');

  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const id = (req.headers['x-request-id'] as string | undefined) ?? randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
      autoLogging: { ignore: (req) => req.url === '/health' },
    }),
  );
  app.use(helmet());
  app.use(
    cors({
      // Mobile apps do not use CORS. Browsers: only the origins listed in CORS_ORIGINS.
      origin: env.CORS_ORIGINS.length > 0 ? env.CORS_ORIGINS : !isProd,
      credentials: false,
    }),
  );
  app.use(compression());
  app.use(express.json({ limit: '1mb' }));
  app.use(globalLimiter);

  app.use(healthRouter);
  app.use('/api/v1', apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
