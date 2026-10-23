import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express, { type ErrorRequestHandler, type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { Logger } from 'pino';
import type { Env } from './config/env';
import { healthRouter } from './routes/health';

export function createApp(env: Env, logger: Logger): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(
    pinoHttp({
      logger,
      // request id on every log line (§10); honour an upstream id if present
      genReqId: (req, res) => {
        const id = (req.headers['x-request-id'] as string | undefined) ?? randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
      serializers: {
        // method, path and status only: no query strings or bodies (may carry PHI)
        req: (req: { id: string; method: string; url: string }) => ({
          id: req.id,
          method: req.method,
          path: req.url.split('?')[0],
        }),
      },
    }),
  );
  app.use(helmet());
  app.use(cors({ origin: [env.APP_URL], credentials: true }));
  app.use(express.json({ limit: '1mb' }));

  app.use('/api/v1', healthRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: 'Route not found' } });
  });

  const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
    req.log.error(
      { err: { name: (err as Error).name, message: (err as Error).message } },
      'unhandled error',
    );
    res.status(500).json({ error: { code: 'internal', message: 'Internal server error' } });
  };
  app.use(errorHandler);

  return app;
}
