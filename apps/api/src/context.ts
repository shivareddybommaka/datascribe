import type { ObjectStore, PaymentGateway } from '@datascribe/billing';
import type { PrismaClient } from '@datascribe/db';
import type { MedicalData } from '@datascribe/medical-data';
import type { Logger } from 'pino';
import type { Env } from './config/env';
import type { Mailer } from './lib/mailer';

export interface RateLimits {
  windowMs: number;
  /** login / MFA / refresh, per IP */
  authPerWindow: number;
  /** register / forgot / invite accept, per IP */
  publicPerWindow: number;
}

export const DEFAULT_RATE_LIMITS: RateLimits = {
  windowMs: 15 * 60 * 1000,
  authPerWindow: 30,
  publicPerWindow: 10,
};

/** Everything a request handler needs. Passed in so tests can swap DB, mailer and limits. */
export interface Deps {
  env: Env;
  prisma: PrismaClient;
  mailer: Mailer;
  logger: Logger;
  phiKey: Buffer;
  rateLimits: RateLimits;
  /** §8 adapters. Optional so tests default to the deterministic mocks. */
  medical?: MedicalData;
  /** M8 billing: Stripe (test) / Fake / Razorpay stub, and where invoice PDFs are kept */
  gateway: PaymentGateway;
  store: ObjectStore;
}
