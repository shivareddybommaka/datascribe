import { describe, expect, it } from 'vitest';
import { createGateway, FakeGateway, RazorpayGateway, StripeGateway, WebhookSignatureError } from '.';

const fake = () => new FakeGateway({ secret: 'test-secret', checkoutBaseUrl: 'http://app/checkout' });
const raw = (s: string) => Buffer.from(s, 'utf8');

describe('FakeGateway', () => {
  it('creates checkout sessions that encode the invoice id', async () => {
    const g = fake();
    const s = await g.createCheckout({
      invoiceId: 'cinv123',
      invoiceNumber: 'INV-1',
      amount: '10.00',
      currency: 'USD',
      successUrl: 'http://ok',
      cancelUrl: 'http://cancel',
    });
    expect(s.url).toBe(`http://app/checkout/${s.id}`);
    expect(FakeGateway.invoiceIdFromSession(s.id)).toBe('cinv123');
    expect(FakeGateway.invoiceIdFromSession('cs_live_x')).toBeNull();
  });

  it('accepts correctly signed webhooks and normalises them', async () => {
    const g = fake();
    const { body, headers } = g.webhook({ invoiceId: 'cinv1', amount: '5.00', currency: 'usd', paymentRef: 'fpi_1' });
    expect(await g.parseWebhook(raw(body), headers)).toMatchObject({
      kind: 'payment_succeeded',
      invoiceId: 'cinv1',
      gatewayRef: 'fpi_1',
      amount: '5.00',
      currency: 'USD',
    });
    const failed = g.webhook({ type: 'payment.failed', invoiceId: 'cinv1', amount: '5.00', currency: 'USD' });
    expect((await g.parseWebhook(raw(failed.body), failed.headers)).kind).toBe('payment_failed');
  });

  it('rejects missing, wrong, tampered and stale signatures', async () => {
    const g = fake();
    const { body, headers } = g.webhook({ invoiceId: 'cinv1', amount: '5.00', currency: 'USD' });
    await expect(g.parseWebhook(raw(body), {})).rejects.toBeInstanceOf(WebhookSignatureError);
    await expect(
      g.parseWebhook(raw(body.replace('5.00', '0.01')), headers),
    ).rejects.toBeInstanceOf(WebhookSignatureError);
    const other = new FakeGateway({ secret: 'other', checkoutBaseUrl: 'x' });
    await expect(
      g.parseWebhook(raw(body), { 'x-fake-signature': other.sign(body) }),
    ).rejects.toBeInstanceOf(WebhookSignatureError);
    const old = Math.floor(Date.now() / 1000) - 3600;
    await expect(
      g.parseWebhook(raw(body), { 'x-fake-signature': g.sign(body, old) }),
    ).rejects.toThrow(/tolerance/);
  });

  it('ignores unknown event types and records refunds', async () => {
    const g = fake();
    const body = JSON.stringify({ id: 'e1', type: 'customer.created', data: {} });
    expect(await g.parseWebhook(raw(body), { 'x-fake-signature': g.sign(body) })).toEqual({
      kind: 'ignored',
      eventId: 'e1',
      type: 'customer.created',
    });
    const r = await g.refund({ gatewayRef: 'fpi_1', amount: '1.00', currency: 'USD' });
    expect(r.status).toBe('succeeded');
    expect(g.refunds).toHaveLength(1);
    g.failNextRefund = true;
    await expect(g.refund({ gatewayRef: 'fpi_1', amount: '1.00', currency: 'USD' })).rejects.toThrow(
      /declined/,
    );
  });
});

describe('StripeGateway', () => {
  const secret = 'whsec_test_secret';
  const stripe = () =>
    new StripeGateway({ secretKey: 'sk_test_dummy', webhookSecret: secret, fetchReceipts: false });

  const sessionEvent = (type: string, paymentStatus = 'paid') =>
    JSON.stringify({
      id: 'evt_1',
      object: 'event',
      type,
      data: {
        object: {
          id: 'cs_test_1',
          object: 'checkout.session',
          amount_total: 175925,
          currency: 'usd',
          client_reference_id: 'cinv9',
          metadata: { invoiceId: 'cinv9' },
          payment_intent: 'pi_123',
          payment_status: paymentStatus,
        },
      },
    });

  it('refuses live keys', () => {
    expect(() => new StripeGateway({ secretKey: 'sk_live_abc' })).toThrow(/test-mode/);
    expect(() => new StripeGateway({ secretKey: 'pk_test_abc' })).toThrow(/test-mode/);
  });

  it('verifies the Stripe-Signature header and maps checkout.session.completed', async () => {
    const body = sessionEvent('checkout.session.completed');
    const ev = await stripe().parseWebhook(raw(body), {
      'stripe-signature': StripeGateway.testSignature(body, secret),
    });
    expect(ev).toEqual({
      kind: 'payment_succeeded',
      eventId: 'evt_1',
      invoiceId: 'cinv9',
      gatewayRef: 'pi_123',
      amount: '1759.25',
      currency: 'USD',
      receiptUrl: null,
    });
  });

  it('waits for async payments and maps their failure', async () => {
    const g = stripe();
    const pending = sessionEvent('checkout.session.completed', 'unpaid');
    expect(
      (await g.parseWebhook(raw(pending), { 'stripe-signature': StripeGateway.testSignature(pending, secret) }))
        .kind,
    ).toBe('ignored');
    const failed = sessionEvent('checkout.session.async_payment_failed', 'unpaid');
    expect(
      (await g.parseWebhook(raw(failed), { 'stripe-signature': StripeGateway.testSignature(failed, secret) }))
        .kind,
    ).toBe('payment_failed');
    const other = sessionEvent('invoice.created');
    expect(
      (await g.parseWebhook(raw(other), { 'stripe-signature': StripeGateway.testSignature(other, secret) }))
        .kind,
    ).toBe('ignored');
  });

  it('rejects bad signatures, and webhooks when no secret is configured', async () => {
    const body = sessionEvent('checkout.session.completed');
    await expect(
      stripe().parseWebhook(raw(body), { 'stripe-signature': StripeGateway.testSignature(body, 'whsec_other') }),
    ).rejects.toBeInstanceOf(WebhookSignatureError);
    await expect(stripe().parseWebhook(raw(body), {})).rejects.toBeInstanceOf(WebhookSignatureError);
    const noSecret = new StripeGateway({ secretKey: 'sk_test_dummy' });
    await expect(
      noSecret.parseWebhook(raw(body), { 'stripe-signature': StripeGateway.testSignature(body, secret) }),
    ).rejects.toBeInstanceOf(WebhookSignatureError);
  });
});

describe('createGateway', () => {
  const base = { FAKE_GATEWAY_SECRET: 's', fakeCheckoutBaseUrl: 'http://x' };
  it('uses Stripe only when a key is configured, otherwise the fake', () => {
    expect(createGateway({ ...base, PAYMENT_GATEWAY: 'stripe' }).name).toBe('fake');
    expect(
      createGateway({ ...base, PAYMENT_GATEWAY: 'stripe', STRIPE_SECRET_KEY: 'sk_test_x' }).name,
    ).toBe('stripe');
    expect(createGateway({ ...base, PAYMENT_GATEWAY: 'fake', STRIPE_SECRET_KEY: 'sk_test_x' }).name).toBe(
      'fake',
    );
    expect(createGateway({ ...base, PAYMENT_GATEWAY: 'razorpay' }).name).toBe('razorpay');
  });

  it('Razorpay is a stub that says so', async () => {
    const g = new RazorpayGateway();
    await expect(g.createCheckout()).rejects.toThrow(/not implemented/);
    await expect(g.parseWebhook()).rejects.toThrow(/not implemented/);
    await expect(g.refund()).rejects.toThrow(/not implemented/);
  });
});
