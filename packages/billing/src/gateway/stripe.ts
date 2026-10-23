import Stripe from 'stripe';
import { fromMinorUnits, toMinorUnits } from '../money';
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

/** Test-mode keys only. Live keys are refused at construction (AUTOPILOT: never live Stripe). */
export const isStripeTestKey = (key: string) => /^(sk|rk)_test_/.test(key);

/**
 * Stripe Checkout (one-off payment per invoice). The PaymentIntent id is the Payment.gatewayRef,
 * so a webhook delivered twice maps onto the same row.
 */
export class StripeGateway implements PaymentGateway {
  readonly name = 'stripe' as const;
  private readonly stripe: Stripe;

  constructor(
    private readonly opts: {
      secretKey: string;
      webhookSecret?: string;
      /** look up the charge's receipt URL after a payment (one extra API call) */
      fetchReceipts?: boolean;
    },
  ) {
    if (!isStripeTestKey(opts.secretKey)) {
      throw new Error('StripeGateway accepts test-mode keys only (sk_test_… or rk_test_…)');
    }
    this.stripe = new Stripe(opts.secretKey, { maxNetworkRetries: 2, timeout: 10_000 });
  }

  async createCheckout(req: CheckoutRequest): Promise<CheckoutSession> {
    const session = await this.stripe.checkout.sessions.create({
      mode: 'payment',
      client_reference_id: req.invoiceId,
      ...(req.customerEmail ? { customer_email: req.customerEmail } : {}),
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: req.currency.toLowerCase(),
            unit_amount: toMinorUnits(req.amount, req.currency),
            product_data: { name: `Datascribe invoice ${req.invoiceNumber}` },
          },
        },
      ],
      metadata: { invoiceId: req.invoiceId, invoiceNumber: req.invoiceNumber },
      payment_intent_data: { metadata: { invoiceId: req.invoiceId } },
      success_url: req.successUrl,
      cancel_url: req.cancelUrl,
    });
    if (!session.url) throw new GatewayError('Stripe did not return a checkout URL');
    return { id: session.id, url: session.url };
  }

  async parseWebhook(rawBody: Buffer, headers: WebhookHeaders): Promise<GatewayEvent> {
    const sig = header(headers, 'stripe-signature');
    if (!sig || !this.opts.webhookSecret) throw new WebhookSignatureError();
    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(rawBody, sig, this.opts.webhookSecret);
    } catch {
      throw new WebhookSignatureError();
    }

    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded':
      case 'checkout.session.async_payment_failed': {
        const s = event.data.object;
        const invoiceId = s.metadata?.invoiceId ?? s.client_reference_id;
        const pi = typeof s.payment_intent === 'string' ? s.payment_intent : s.payment_intent?.id;
        const failed = event.type === 'checkout.session.async_payment_failed';
        // "completed" with payment_status unpaid = async method still pending; wait for the next event
        if (!invoiceId || !pi || (!failed && s.payment_status !== 'paid')) {
          return { kind: 'ignored', eventId: event.id, type: event.type };
        }
        const currency = (s.currency ?? 'usd').toUpperCase();
        return {
          kind: failed ? 'payment_failed' : 'payment_succeeded',
          eventId: event.id,
          invoiceId,
          gatewayRef: pi,
          amount: fromMinorUnits(s.amount_total ?? 0, currency),
          currency,
          receiptUrl: failed ? null : await this.receiptUrl(pi),
        };
      }
      default:
        return { kind: 'ignored', eventId: event.id, type: event.type };
    }
  }

  private async receiptUrl(paymentIntentId: string): Promise<string | null> {
    if (this.opts.fetchReceipts === false) return null;
    try {
      const pi = await this.stripe.paymentIntents.retrieve(paymentIntentId, {
        expand: ['latest_charge'],
      });
      const charge = pi.latest_charge;
      return typeof charge === 'object' && charge ? (charge.receipt_url ?? null) : null;
    } catch {
      return null; // a receipt link is nice to have; never fail the webhook over it
    }
  }

  async refund(req: RefundRequest): Promise<RefundResult> {
    try {
      const r = await this.stripe.refunds.create({
        payment_intent: req.gatewayRef,
        amount: toMinorUnits(req.amount, req.currency),
      });
      return { refundRef: r.id, status: r.status === 'succeeded' ? 'succeeded' : 'pending' };
    } catch (err) {
      throw new GatewayError(`Stripe refund failed: ${(err as Error).message}`);
    }
  }

  /** Tests: sign a payload exactly as Stripe would. */
  static testSignature(payload: string, secret: string): string {
    return Stripe.webhooks.generateTestHeaderString({ payload, secret });
  }
}
