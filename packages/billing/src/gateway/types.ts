/**
 * Payment gateway abstraction (§2, §5.6). Business logic only ever talks to this interface;
 * Stripe (test mode), a Razorpay stub and a Fake gateway implement it.
 */

export type GatewayName = 'stripe' | 'razorpay' | 'fake';

export interface CheckoutRequest {
  invoiceId: string;
  invoiceNumber: string;
  /** decimal string, e.g. "1499.00" */
  amount: string;
  /** ISO-4217, upper case */
  currency: string;
  customerEmail?: string;
  successUrl: string;
  cancelUrl: string;
}

export interface CheckoutSession {
  id: string;
  url: string;
}

/** Normalised webhook event. Gateways map their own event types onto these. */
export type GatewayEvent =
  | {
      kind: 'payment_succeeded' | 'payment_failed';
      eventId: string;
      invoiceId: string;
      /** the gateway's payment id (Stripe PaymentIntent); unique per gateway → idempotency */
      gatewayRef: string;
      amount: string;
      currency: string;
      receiptUrl?: string | null;
    }
  | { kind: 'ignored'; eventId: string; type: string };

export interface RefundRequest {
  gatewayRef: string;
  amount: string;
  currency: string;
}

export interface RefundResult {
  refundRef: string;
  status: 'succeeded' | 'pending';
}

export type WebhookHeaders = Record<string, string | string[] | undefined>;

export interface PaymentGateway {
  readonly name: GatewayName;
  createCheckout(req: CheckoutRequest): Promise<CheckoutSession>;
  /** Verifies the signature first; throws WebhookSignatureError when it doesn't match. */
  parseWebhook(rawBody: Buffer, headers: WebhookHeaders): Promise<GatewayEvent>;
  refund(req: RefundRequest): Promise<RefundResult>;
}

export class WebhookSignatureError extends Error {
  constructor(message = 'Invalid webhook signature') {
    super(message);
    this.name = 'WebhookSignatureError';
  }
}

export class GatewayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GatewayError';
  }
}

export function header(headers: WebhookHeaders, name: string): string | undefined {
  const v = headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}
