import {
  GatewayError,
  type CheckoutSession,
  type GatewayEvent,
  type PaymentGateway,
  type RefundResult,
} from './types';

/**
 * Placeholder for India (§2, §14: "Razorpay stub behind the same interface"). Implementation
 * needs Razorpay Orders + Checkout, webhook HMAC (X-Razorpay-Signature) and the Refunds API.
 */
export class RazorpayGateway implements PaymentGateway {
  readonly name = 'razorpay' as const;

  private notYet(): never {
    throw new GatewayError('Razorpay is not implemented yet');
  }

  async createCheckout(): Promise<CheckoutSession> {
    return this.notYet();
  }

  async parseWebhook(): Promise<GatewayEvent> {
    return this.notYet();
  }

  async refund(): Promise<RefundResult> {
    return this.notYet();
  }
}
