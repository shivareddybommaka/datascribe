import type { ObjectStore, PaymentGateway } from '@datascribe/billing';
import type { PrismaClient } from '@datascribe/db';
import type { MedicalData } from '@datascribe/medical-data';
import type { Store } from 'express-rate-limit';
import type { Logger } from 'pino';
import type { Env } from './config/env';
import type { Mailer } from './lib/mailer';
import type { MedicalSwitches } from './lib/medical-switches';
import type { VirusScanner } from '@datascribe/scan';
import type { DocumentStorage } from './lib/storage';

export interface RateLimits {
  windowMs: number;
  /** login / MFA / refresh, per IP */
  authPerWindow: number;
  /** register / forgot / invite accept, per IP */
  publicPerWindow: number;
  /** login / MFA / forgot / register, per target account whatever the IP (audit M6) */
  accountPerWindow?: number;
}

export const DEFAULT_RATE_LIMITS: Required<RateLimits> = {
  windowMs: 15 * 60 * 1000,
  authPerWindow: 30,
  publicPerWindow: 10,
  accountPerWindow: 10,
};

/** Everything a request handler needs. Passed in so tests can swap DB, mailer and limits. */
export interface Deps {
  env: Env;
  prisma: PrismaClient;
  mailer: Mailer;
  logger: Logger;
  phiKey: Buffer;
  rateLimits: RateLimits;
  /**
   * Counter store per named limiter: Redis in the server, so every API process shares one count
   * (D-111). Unset = express-rate-limit's in-process memory store (unit tests).
   */
  rateLimitStore?: (limiter: string) => Store;
  /** §8 adapters. Optional so tests default to the deterministic mocks. */
  medical?: MedicalData;
  /** admin on/off per medical upstream (M2 settings); the adapters read it on every call */
  medicalSwitches?: MedicalSwitches;
  /** M8 billing: Stripe (test) / Fake / Razorpay stub, and where invoice PDFs are kept */
  gateway: PaymentGateway;
  store: ObjectStore;
  /** M4 uploaded records: S3 (SeaweedFS locally) */
  storage: DocumentStorage;
  /**
   * Tests only: hash and scan each completed upload with this scanner before /complete responds,
   * so results are deterministic. Otherwise the worker's scan stage picks it up (D-081) and the
   * client polls the document.
   */
  inlineScan?: VirusScanner;
}
