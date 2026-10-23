import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  GatewayError,
  WebhookSignatureError,
  header,
  type CheckoutRequest,
  type CheckoutSession,
  type GatewayEvent,
  type PaymentGateway,
  type RefundRequest,
  type RefundResult,
  type WebhookHeaders,
} from './types';

export const FAKE_SIGNATURE_HEADER = 'x-fake-signature';
const TOLERANCE_SECONDS = 300;

interface FakePayload {
  id: string;
  type: 'payment.succeeded' | 'payment.failed';
  data: { invoiceId: string; paymentRef: string; amount: string; currency: string };
}

const rand = () => randomBytes(9).toString('base64url').replace(/[-_]/g, 'x');

/**
 * Stands in for Stripe in tests and when no Stripe key is configured (never in production).
 * Webhooks are signed like Stripe's: `t=<unix>,v1=<hmac-sha256(secret, "t.body")>`.
 */
export class FakeGateway implements PaymentGateway {
  readonly name = 'fake' as const;
  readonly checkouts: CheckoutRequest[] = [];
  readonly refunds: RefundRequest[] = [];
  /** tests: make the next refund call fail */
  failNextRefund = false;

  constructor(private readonly opts: { secret: string; checkoutBaseUrl: string }) {}

  async createCheckout(req: CheckoutRequest): Promise<CheckoutSession> {
    this.checkouts.push(req);
    const id = `fcs_${req.invoiceId}_${rand()}`;
    return { id, url: `${this.opts.checkoutBaseUrl}/${id}` };
  }

  /** Invoice id encoded in a fake checkout session id, or null. */
  static invoiceIdFromSession(sessionId: string): string | null {
    const m = /^fcs_([a-z0-9]+)_[A-Za-z0-9]+$/.exec(sessionId);
    return m?.[1] ?? null;
  }

  sign(rawBody: string, timestamp = Math.floor(Date.now() / 1000)): string {
    const mac = createHmac('sha256', this.opts.secret)
      .update(`${timestamp}.${rawBody}`)
      .digest('hex');
    return `t=${timestamp},v1=${mac}`;
  }

  /** Build a signed webhook body + headers, as the gateway would send it. */
  webhook(input: {
    type?: FakePayload['type'];
    invoiceId: string;
    amount: string;
    currency: string;
    paymentRef?: string;
    eventId?: string;
  }): { body: string; headers: Record<string, string> } {
    const payload: FakePayload = {
      id: input.eventId ?? `fevt_${rand()}`,
      type: input.type ?? 'payment.succeeded',
      data: {
        invoiceId: input.invoiceId,
        paymentRef: input.paymentRef ?? `fpi_${rand()}`,
        amount: input.amount,
        currency: input.currency,
      },
    };
    const body = JSON.stringify(payload);
    return {
      body,
      headers: { 'content-type': 'application/json', [FAKE_SIGNATURE_HEADER]: this.sign(body) },
    };
  }

  async parseWebhook(rawBody: Buffer, headers: WebhookHeaders): Promise<GatewayEvent> {
    const sig = header(headers, FAKE_SIGNATURE_HEADER);
    const m = sig ? /^t=(\d+),v1=([0-9a-f]{64})$/.exec(sig) : null;
    if (!m) throw new WebhookSignatureError();
    const t = Number(m[1]);
    if (Math.abs(Date.now() / 1000 - t) > TOLERANCE_SECONDS) {
      throw new WebhookSignatureError('Webhook timestamp outside tolerance');
    }
    const expected = Buffer.from(this.sign(rawBody.toString('utf8'), t).split('v1=')[1]!, 'hex');
    const given = Buffer.from(m[2]!, 'hex');
    if (!timingSafeEqual(expected, given)) throw new WebhookSignatureError();

    let p: FakePayload;
    try {
      p = JSON.parse(rawBody.toString('utf8')) as FakePayload;
    } catch {
      throw new WebhookSignatureError('Malformed webhook body');
    }
    if (p.type !== 'payment.succeeded' && p.type !== 'payment.failed') {
      return { kind: 'ignored', eventId: String(p.id), type: String(p.type) };
    }
    return {
      kind: p.type === 'payment.succeeded' ? 'payment_succeeded' : 'payment_failed',
      eventId: p.id,
      invoiceId: p.data.invoiceId,
      gatewayRef: p.data.paymentRef,
      amount: p.data.amount,
      currency: p.data.currency.toUpperCase(),
      receiptUrl: null,
    };
  }

  async refund(req: RefundRequest): Promise<RefundResult> {
    if (this.failNextRefund) {
      this.failNextRefund = false;
      throw new GatewayError('Refund declined by gateway');
    }
    this.refunds.push(req);
    return { refundRef: `fre_${rand()}`, status: 'succeeded' };
  }
}
