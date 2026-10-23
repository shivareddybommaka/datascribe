import { FakeGateway } from './fake';
import { RazorpayGateway } from './razorpay';
import { StripeGateway } from './stripe';
import type { PaymentGateway } from './types';

export * from './types';
export { FakeGateway, FAKE_SIGNATURE_HEADER } from './fake';
export { RazorpayGateway } from './razorpay';
export { StripeGateway, isStripeTestKey } from './stripe';

export interface GatewayConfig {
  PAYMENT_GATEWAY: 'stripe' | 'razorpay' | 'fake';
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  FAKE_GATEWAY_SECRET: string;
  /** where the fake checkout page lives, e.g. http://localhost:3010/api/v1/payments/fake-checkout */
  fakeCheckoutBaseUrl: string;
}

/**
 * Stripe when a (test) key is configured, otherwise the Fake gateway, so dev and CI never need
 * Stripe. Production refuses the Fake gateway in env validation.
 */
export function createGateway(cfg: GatewayConfig): PaymentGateway {
  if (cfg.PAYMENT_GATEWAY === 'razorpay') return new RazorpayGateway();
  if (cfg.PAYMENT_GATEWAY === 'stripe' && cfg.STRIPE_SECRET_KEY) {
    return new StripeGateway({
      secretKey: cfg.STRIPE_SECRET_KEY,
      webhookSecret: cfg.STRIPE_WEBHOOK_SECRET,
    });
  }
  return new FakeGateway({
    secret: cfg.FAKE_GATEWAY_SECRET,
    checkoutBaseUrl: cfg.fakeCheckoutBaseUrl,
  });
}
