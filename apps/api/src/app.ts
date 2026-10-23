import { randomUUID } from 'node:crypto';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { Router, type ErrorRequestHandler, type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { Deps } from './context';
import { writeAudit } from './lib/audit';
import { HttpError } from './lib/errors';
import { authRouter } from './routes/auth';
import { casesRouter } from './routes/cases';
import { healthRouter } from './routes/health';
import { invitesRouter } from './routes/invites';
import { permissionsRouter } from './routes/permissions';

export function createApp(deps: Deps): Express {
  const { env, logger } = deps;
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
  app.use(cookieParser());

  // Audit middleware: every handler gets req.audit(), bound to the request's actor, IP and UA.
  app.use((req, _res, next) => {
    req.audit = (entry) => writeAudit(deps.prisma, req, entry);
    next();
  });

  const v1 = Router();
  v1.use(healthRouter);
  v1.use(authRouter(deps));
  v1.use(invitesRouter(deps));
  v1.use(permissionsRouter(deps));
  v1.use(casesRouter(deps));
  app.use('/api/v1', v1);

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: 'Route not found' } });
  });

  const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({
        error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
      });
      return;
    }
    const e = err as { type?: string; status?: number; name?: string; message?: string };
    if (e.type === 'entity.parse.failed' || e.type === 'entity.too.large') {
      res.status(e.status ?? 400).json({ error: { code: 'bad_body', message: 'Invalid request body' } });
      return;
    }
    // name + message only: never the request body or stack with data
    req.log.error({ err: { name: e.name, message: e.message } }, 'unhandled error');
    res.status(500).json({ error: { code: 'internal', message: 'Internal server error' } });
  };
  app.use(errorHandler);

  return app;
}
