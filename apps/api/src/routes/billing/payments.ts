import {
  FakeGateway,
  WebhookSignatureError,
  applyGatewayEvent,
  refundPayment,
} from '@datascribe/billing';
import { notifyPaymentRecorded } from '@datascribe/db/notifications';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { authenticate, requireAuth } from '../../auth/middleware';
import type { Deps } from '../../context';
import { badRequest, notFound } from '../../lib/errors';
import { safeNotify } from '../../lib/notify';
import { parse } from '../../lib/validate';
import { Money, billingOrgWhere, requireStaffAll, serializePayment } from './common';

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * §5.6 payments: gateway webhook (signature-verified, idempotent), refunds (finance:
 * payments:approve) and, outside production with the Fake gateway, a simulated checkout page.
 */
export function paymentsRouter(deps: Deps): Router {
  const { prisma, gateway, env } = deps;
  const r = Router();

  /** Verify, normalise and apply a webhook body. Shared by the real route and the fake checkout. */
  async function handleWebhook(req: Request, raw: Buffer, headers: Request['headers']) {
    const event = await gateway.parseWebhook(raw, headers);
    const result = await applyGatewayEvent(prisma, gateway.name, event);
    if (result.outcome === 'recorded') {
      await req.audit({
        action: event.kind === 'payment_succeeded' ? 'payment.succeeded' : 'payment.failed',
        entity: 'Payment',
        entityId: result.paymentId,
        organizationId: result.organizationId,
        actorId: null,
        metadata: {
          gateway: gateway.name,
          eventId: event.eventId,
          invoiceId: result.invoiceId,
          invoicePaid: result.invoicePaid,
        },
      });
      const { paymentId, invoicePaid } = result;
      await safeNotify(deps.logger, event.kind, () =>
        notifyPaymentRecorded(prisma, paymentId, invoicePaid),
      );
    }
    req.log.info(
      { gateway: gateway.name, eventId: event.eventId, outcome: result.outcome },
      'payment webhook',
    );
    return result;
  }

  // The configured gateway answers here (Stripe in production; the Fake gateway in dev/test).
  r.post('/payments/webhook/stripe', async (req, res) => {
    if (!Buffer.isBuffer(req.body)) throw badRequest('bad_body', 'Expected a raw body');
    try {
      const result = await handleWebhook(req, req.body, req.headers);
      res.json({ received: true, outcome: result.outcome });
    } catch (err) {
      if (err instanceof WebhookSignatureError) {
        req.log.warn({ gateway: gateway.name }, 'webhook signature rejected');
        throw badRequest('invalid_signature', 'Webhook signature verification failed');
      }
      throw err;
    }
  });

  r.get('/payments', authenticate(deps), async (req, res) => {
    const auth = requireAuth(req);
    const q = parse(
      z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }),
      req.query,
    );
    const items = await prisma.payment.findMany({
      where: { invoice: billingOrgWhere(auth, 'payments', 'view') },
      include: { invoice: { select: { id: true, number: true, organizationId: true } } },
      orderBy: { createdAt: 'desc' },
      take: q.limit,
    });
    res.json({ items: items.map((p) => ({ ...serializePayment(p), invoice: p.invoice })) });
  });

  r.post(
    '/payments/:id/refund',
    authenticate(deps),
    requireStaffAll('payments', 'approve'),
    async (req, res) => {
      const body = parse(
        z.object({ amount: Money.optional(), reason: z.string().trim().min(1).max(500) }),
        req.body,
      );
      const id = String(req.params.id);
      if (!(await prisma.payment.findUnique({ where: { id } }))) throw notFound();
      const result = await refundPayment(prisma, gateway, { paymentId: id, amount: body.amount });
      await req.audit({
        action: 'payment.refund',
        entity: 'Payment',
        entityId: id,
        organizationId: result.organizationId,
        metadata: {
          amount: result.amount,
          currency: result.payment.currency,
          refundRef: result.refund.refundRef,
          reason: body.reason,
          invoiceStatus: result.invoiceStatus,
        },
      });
      res.json({
        payment: serializePayment(result.payment),
        refund: { ...result.refund, amount: result.amount },
        invoiceStatus: result.invoiceStatus,
      });
    },
  );

  // ── Simulated hosted checkout for the Fake gateway (never mounted in production; staging, a
  // production build with no real money, keeps it: D-120) ──
  if (gateway instanceof FakeGateway && env.DEPLOY_ENV !== 'production') {
    const fake = gateway;
    const loadSession = async (sessionId: string) => {
      const invoiceId = FakeGateway.invoiceIdFromSession(sessionId);
      const inv = invoiceId ? await prisma.invoice.findUnique({ where: { id: invoiceId } }) : null;
      if (!inv) throw notFound();
      return inv;
    };

    r.get('/payments/fake-checkout/:session', async (req, res) => {
      const inv = await loadSession(String(req.params.session));
      const action = `${String(req.params.session)}/complete`;
      res.type('html').send(
        `<!doctype html><html><head><meta charset="utf-8"><title>Simulated checkout</title></head>
<body style="font-family:system-ui;max-width:32rem;margin:4rem auto">
<h1>Simulated checkout</h1>
<p>Development only: no card is charged. This stands in for Stripe Checkout until a test key is set.</p>
<p>Invoice <strong>${escapeHtml(inv.number)}</strong>: ${escapeHtml(inv.currency)} ${inv.total.toFixed(2)} (${escapeHtml(inv.status)})</p>
<form method="post" action="${escapeHtml(action)}"><button type="submit">Pay ${escapeHtml(inv.currency)} ${inv.total.toFixed(2)}</button></form>
</body></html>`,
      );
    });

    r.post('/payments/fake-checkout/:session/complete', async (req, res) => {
      const inv = await loadSession(String(req.params.session));
      const { body, headers } = fake.webhook({
        invoiceId: inv.id,
        amount: inv.total.toFixed(2),
        currency: inv.currency,
      });
      const result = await handleWebhook(req, Buffer.from(body), headers);
      res
        .type('html')
        .send(
          `<!doctype html><html><body style="font-family:system-ui;max-width:32rem;margin:4rem auto"><h1>Payment ${result.outcome === 'recorded' ? 'received' : escapeHtml(result.outcome)}</h1><p>Invoice ${escapeHtml(inv.number)}.</p></body></html>`,
        );
    });
  }

  return r;
}
