import { randomUUID } from 'node:crypto';
import { BillingError, GatewayError } from '@datascribe/billing';
import { errorInfo } from '@datascribe/db';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { Router, type ErrorRequestHandler, type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { Deps } from './context';
import { writeAudit } from './lib/audit';
import { cfConnectingIp } from './lib/client-ip';
import { RELAY_PATH } from './lib/relay-token';
import { storageRelayRouter } from './lib/storage-relay';
import { HttpError } from './lib/errors';
import { auditRouter } from './routes/admin/audit';
import { impersonationRouter } from './routes/admin/impersonation';
import { organizationsRouter } from './routes/admin/organizations';
import { rolesRouter } from './routes/admin/roles';
import { settingsRouter } from './routes/admin/settings';
import { adminUsersRouter } from './routes/admin/users';
import { authRouter } from './routes/auth';
import { invoicesRouter } from './routes/billing/invoices';
import { paymentsRouter } from './routes/billing/payments';
import { plansRouter } from './routes/billing/plans';
import { subscriptionsRouter } from './routes/billing/subscriptions';
import { casesRouter } from './routes/cases';
import { accountsRouter } from './routes/crm/accounts';
import { documentsRouter } from './routes/documents';
import { portalRouter } from './routes/portal';
import { activitiesRouter } from './routes/crm/activities';
import { contactsRouter } from './routes/crm/contacts';
import { leadsRouter } from './routes/crm/leads';
import { dashboardsRouter } from './routes/dashboards';
import { healthRouter } from './routes/health';
import { invitesRouter } from './routes/invites';
import { medicalRouter } from './routes/medical';
import { notificationsRouter } from './routes/notifications';
import { permissionsRouter } from './routes/permissions';
import { publicRouter } from './routes/public';

/** Log path without query string or secrets in the path (invite / relay tokens, audit M3). */
export const redactPath = (url: string): string =>
  (url.split('?')[0] ?? '')
    .replace(/\/invites\/[^/]+/, '/invites/[token]')
    .replace(/\/storage-relay\/[^/]+/, '/storage-relay/[token]');

export function createApp(deps: Deps): Express {
  const { env, logger } = deps;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);
  if (env.TRUST_CF_CONNECTING_IP) app.use(cfConnectingIp());

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
          path: redactPath(req.url),
        }),
      },
    }),
  );
  app.use(helmet());
  app.use(cors({ origin: [env.APP_URL, ...env.EXTRA_TRUSTED_ORIGINS], credentials: true }));
  // Payment webhooks are verified against the exact bytes received, so they get the raw body
  // (express.json then skips them).
  app.use('/api/v1/payments/webhook', express.raw({ type: () => true, limit: '1mb' }));
  // Staging's storage relay streams upload parts, so it comes before the JSON parser (D-122).
  if (env.S3_BROWSER_ACCESS === 'relay') app.use(RELAY_PATH, storageRelayRouter(deps));
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
  v1.use(adminUsersRouter(deps));
  v1.use(rolesRouter(deps));
  v1.use(organizationsRouter(deps));
  v1.use(settingsRouter(deps));
  v1.use(auditRouter(deps));
  v1.use(impersonationRouter(deps));
  v1.use(casesRouter(deps));
  v1.use(documentsRouter(deps));
  v1.use(portalRouter(deps));
  v1.use(leadsRouter(deps));
  v1.use(contactsRouter(deps));
  v1.use(activitiesRouter(deps));
  v1.use(accountsRouter(deps));
  v1.use(medicalRouter(deps));
  v1.use(notificationsRouter(deps));
  v1.use(dashboardsRouter(deps));
  v1.use(publicRouter(deps));
  v1.use(plansRouter(deps));
  v1.use(subscriptionsRouter(deps));
  v1.use(invoicesRouter(deps));
  v1.use(paymentsRouter(deps));
  app.use('/api/v1', v1);

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: 'Route not found' } });
  });

  const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({
        error: {
          code: err.code,
          message: err.message,
          ...(err.details ? { details: err.details } : {}),
        },
      });
      return;
    }
    if (err instanceof BillingError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message } });
      return;
    }
    if (err instanceof GatewayError) {
      req.log.warn({ err: { name: err.name, message: err.message } }, 'payment gateway error');
      res.status(502).json({ error: { code: 'gateway_error', message: err.message } });
      return;
    }
    const e = err as { type?: string; status?: number; name?: string; message?: string };
    if (e.type === 'entity.parse.failed' || e.type === 'entity.too.large') {
      res
        .status(e.status ?? 400)
        .json({ error: { code: 'bad_body', message: 'Invalid request body' } });
      return;
    }
    // never the request body, stack or a Prisma message (it quotes query values, audit L7)
    req.log.error({ err: errorInfo(err) }, 'unhandled error');
    res.status(500).json({ error: { code: 'internal', message: 'Internal server error' } });
  };
  app.use(errorHandler);

  return app;
}
