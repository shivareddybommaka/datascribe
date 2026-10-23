import { z } from 'zod';

const bool = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

const secret = z.string().min(32, 'must be at least 32 characters');

/** `KEY=` in .env arrives as ""; treat it as unset. */
const optionalString = z
  .string()
  .optional()
  .transform((v) => (v ? v : undefined));

export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_PORT: z.coerce.number().int().positive().default(4000),
    APP_URL: z.string().url().default('http://localhost:3000'),
    DATABASE_URL: z.string().url(),
    JWT_ACCESS_SECRET: secret,
    JWT_REFRESH_SECRET: secret,
    PHI_ENCRYPTION_KEY: z.string().min(1),
    SMTP_HOST: z.string().default('localhost'),
    SMTP_PORT: z.coerce.number().int().positive().default(1025),
    MAIL_FROM: z.string().default('no-reply@datascribe.example'),
    /** website contact / demo forms notify this inbox (§5.1) */
    SALES_INBOX: z.string().email().default('sales@datascribe.example'),
    MEDICAL_DATA_PROVIDER: z.enum(['nlm', 'mock']).default('mock'),
    OPENFDA_API_KEY: optionalString,
    /** stripe (test keys only) | razorpay (stub) | fake. stripe without a key falls back to fake (D-042) */
    PAYMENT_GATEWAY: z.enum(['stripe', 'razorpay', 'fake']).default('stripe'),
    STRIPE_SECRET_KEY: optionalString.refine(
      (v) => !v || /^(sk|rk)_test_/.test(v),
      'only Stripe test-mode keys (sk_test_…) are allowed',
    ),
    STRIPE_WEBHOOK_SECRET: optionalString,
    FAKE_GATEWAY_SECRET: z.string().min(16).default('dev-only-fake-gateway-secret'),
    /** invoice PDFs (local stub until S3 in M4); relative paths resolve from the repo root */
    INVOICE_STORAGE_DIR: z.string().default('.data/invoices'),
    SUMMARY_PROVIDER: z.enum(['mock', 'anthropic', 'openai']).default('mock'),
    PHI_LLM_BAA_CONFIRMED: bool,
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
  })
  .superRefine((env, ctx) => {
    // §8.3: never run a real LLM over PHI in production without a signed BAA.
    if (
      env.NODE_ENV === 'production' &&
      env.SUMMARY_PROVIDER !== 'mock' &&
      !env.PHI_LLM_BAA_CONFIRMED
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PHI_LLM_BAA_CONFIRMED'],
        message: 'A real SUMMARY_PROVIDER in production requires PHI_LLM_BAA_CONFIRMED=true',
      });
    }
    // The fake gateway marks invoices paid without money changing hands: never in production.
    const fake =
      env.PAYMENT_GATEWAY === 'fake' ||
      (env.PAYMENT_GATEWAY === 'stripe' && !env.STRIPE_SECRET_KEY);
    if (env.NODE_ENV === 'production' && fake) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PAYMENT_GATEWAY'],
        message: 'production needs a real payment gateway (set STRIPE_SECRET_KEY)',
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    // Report variable names only — never values.
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${problems}`);
  }
  return parsed.data;
}
