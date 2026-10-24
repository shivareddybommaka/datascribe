import { deployProfileIssues, resolveDeployEnv, type DeployEnv } from '@datascribe/shared/deploy';
import { z } from 'zod';

const bool = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

const profileOf = (env: { NODE_ENV: string; DEPLOY_ENV?: string }): DeployEnv =>
  resolveDeployEnv({ NODE_ENV: env.NODE_ENV, DEPLOY_ENV: env.DEPLOY_ENV });

const secret = z.string().min(32, 'must be at least 32 characters');

/** `KEY=` in .env arrives as ""; treat it as unset. */
const optionalString = z
  .string()
  .optional()
  .transform((v) => (v ? v : undefined));

export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    /** local | staging | production; unset = production when NODE_ENV=production (D-120) */
    DEPLOY_ENV: optionalString,
    /** smoke test of a staging build on http://localhost only (D-120); never set otherwise */
    STAGING_ALLOW_HTTP_FOR_SMOKE: optionalString,
    API_PORT: z.coerce.number().int().positive().default(4000),
    /** interface the API listens on; unset = all. Staging binds 127.0.0.1 (behind the tunnel) */
    API_HOST: optionalString,
    APP_URL: z.string().url().default('http://localhost:3010'),
    /** Extra browser origins trusted for CORS/CSRF (comma-separated), e.g. a local preview proxy. */
    EXTRA_TRUSTED_ORIGINS: z
      .string()
      .optional()
      .transform((v) =>
        (v ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      )
      .pipe(z.array(z.string().url())),
    DATABASE_URL: z.string().url(),
    /** rate-limit counters (D-111) and medical usage stats (D-112), shared by every process */
    REDIS_URL: z.string().url().default('redis://localhost:6379'),
    /** namespaces those keys, so e2e runs and checkouts sharing a Redis DB don't mix counts */
    REDIS_KEY_PREFIX: z
      .string()
      .regex(/^[A-Za-z0-9:_-]*$/)
      .default('ds:'),
    JWT_ACCESS_SECRET: secret,
    JWT_REFRESH_SECRET: secret,
    PHI_ENCRYPTION_KEY: z.string().min(1),
    SMTP_HOST: z.string().default('localhost'),
    SMTP_PORT: z.coerce.number().int().positive().default(1025),
    MAIL_FROM: z.string().default('no-reply@datascribe.example'),
    /** Datascribe's own email domains (comma-separated); unset = MAIL_FROM's domain (audit L10) */
    STAFF_EMAIL_DOMAINS: z
      .string()
      .optional()
      .transform((v) =>
        (v ?? '')
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean),
      ),
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
    /** M4 document storage (§2: private buckets, SSE, signed URLs). Unset endpoint = AWS S3. */
    S3_ENDPOINT: optionalString.pipe(z.string().url().optional()),
    S3_REGION: z.string().min(1).default('ap-south-1'),
    S3_BUCKET_DOCUMENTS: z.string().min(3).default('ds-documents'),
    S3_BUCKET_DELIVERABLES: z.string().min(3).default('ds-deliverables'),
    /** unset = the AWS default credential chain (instance role in production) */
    S3_ACCESS_KEY_ID: optionalString,
    S3_SECRET_ACCESS_KEY: optionalString,
    /** AES256 (SSE-S3) | aws:kms (SSE-KMS) | none (local SeaweedFS only, D-070) */
    S3_SSE: z.enum(['AES256', 'aws:kms', 'none']).default('AES256'),
    S3_SSE_KMS_KEY_ID: optionalString,
    /**
     * direct: browsers use presigned S3 URLs. relay: same-origin URLs the API streams, for
     * staging, whose S3 (local SeaweedFS) browsers behind the tunnel can't reach (D-122).
     */
    S3_BROWSER_ACCESS: z.enum(['direct', 'relay']).default('direct'),
    /** multipart part size; S3 needs ≥ 5 MiB for every part but the last */
    UPLOAD_PART_SIZE_MB: z.coerce.number().int().min(5).max(512).default(8),
    /** clamd (ClamAV) host; unset = mock scanner (EICAR test string only), refused in production */
    CLAMAV_HOST: optionalString,
    CLAMAV_PORT: z.coerce.number().int().positive().default(3310),
    /** per-IP requests per 15 min: login/MFA/refresh, and register/forgot/invite-accept (D-017) */
    RATE_LIMIT_AUTH: z.coerce.number().int().min(1).default(30),
    RATE_LIMIT_PUBLIC: z.coerce.number().int().min(1).default(10),
    /** per-account requests per 15 min on login/MFA/forgot/register, whatever the IP (audit M6) */
    RATE_LIMIT_ACCOUNT: z.coerce.number().int().min(1).default(10),
    /** minimum response time of login / register / forgot, hiding which accounts exist (audit L9) */
    AUTH_RESPONSE_FLOOR_MS: z.coerce.number().int().min(0).max(5000).default(400),
    /**
     * Express `trust proxy`: which hops may set X-Forwarded-For (audit M6). `loopback` (default)
     * trusts the local Next.js proxy only; behind a load balancer give its hop count or CIDRs.
     * `true` is refused: it lets any client choose its own IP and dodge the per-IP limits.
     */
    TRUST_PROXY: z
      .string()
      .default('loopback')
      .transform((v) => v.trim())
      .refine((v) => v !== 'true', 'trusting every hop lets clients spoof their IP')
      .transform((v): string | number | false =>
        v === 'false' || v === '' ? false : /^\d+$/.test(v) ? Number(v) : v,
      ),
    /**
     * Behind a Cloudflare tunnel: client IP from CF-Connecting-IP, honoured only from a hop that
     * TRUST_PROXY trusts (D-121). Refused in production, where no Cloudflare sits in front.
     */
    TRUST_CF_CONNECTING_IP: bool,
    SUMMARY_PROVIDER: z.enum(['mock', 'anthropic', 'openai']).default('mock'),
    PHI_LLM_BAA_CONFIRMED: bool,
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
  })
  .superRefine((env, ctx) => {
    // D-120: staging is a production build with its own, narrower allowances and refusals.
    for (const issue of deployProfileIssues({
      NODE_ENV: env.NODE_ENV,
      DEPLOY_ENV: env.DEPLOY_ENV,
      STAGING_ALLOW_HTTP_FOR_SMOKE: env.STAGING_ALLOW_HTTP_FOR_SMOKE,
      APP_URL: env.APP_URL,
      DATABASE_URL: env.DATABASE_URL,
      SMTP_HOST: env.SMTP_HOST,
      SUMMARY_PROVIDER: env.SUMMARY_PROVIDER,
      STRIPE_SECRET_KEY: env.STRIPE_SECRET_KEY,
      S3_SSE: env.S3_SSE,
      S3_ENDPOINT: env.S3_ENDPOINT,
    })) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [issue.path], message: issue.message });
    }
    const production = profileOf(env) === 'production';
    // Production hands browsers presigned S3 URLs; the API doesn't carry file bytes (D-122).
    if (production && env.S3_BROWSER_ACCESS === 'relay') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['S3_BROWSER_ACCESS'],
        message: 'relay is for staging on the Mac; production uses presigned S3 URLs',
      });
    }
    // On AWS the ALB is the only proxy; a client could send this header straight through it.
    if (production && env.TRUST_CF_CONNECTING_IP) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TRUST_CF_CONNECTING_IP'],
        message: 'is for staging behind the Cloudflare tunnel; not allowed in production',
      });
    }
    if (env.NODE_ENV === 'production' && env.EXTRA_TRUSTED_ORIGINS.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['EXTRA_TRUSTED_ORIGINS'],
        message: 'is for local previews only; not allowed in production',
      });
    }
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
    // §10: documents are encrypted at rest and virus-scanned for real in production. Staging
    // (synthetic data on the Mac) may use local SeaweedFS without SSE and the mock scanner.
    if (production && env.S3_SSE === 'none') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['S3_SSE'],
        message: 'production needs server-side encryption (AES256 or aws:kms)',
      });
    }
    if (production && !env.CLAMAV_HOST) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CLAMAV_HOST'],
        message: 'production needs a real virus scanner (set CLAMAV_HOST)',
      });
    }
    // The fake gateway marks invoices paid without money changing hands: never in production
    // (staging has no real money, so it may).
    const fake =
      env.PAYMENT_GATEWAY === 'fake' ||
      (env.PAYMENT_GATEWAY === 'stripe' && !env.STRIPE_SECRET_KEY);
    if (production && fake) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PAYMENT_GATEWAY'],
        message: 'production needs a real payment gateway (set STRIPE_SECRET_KEY)',
      });
    }
  })
  .transform((env) => ({ ...env, DEPLOY_ENV: profileOf(env) }));

export type Env = z.infer<typeof EnvSchema>;

/** STAFF_EMAIL_DOMAINS, or the domain of MAIL_FROM when it is unset. */
export function staffEmailDomains(env: Pick<Env, 'STAFF_EMAIL_DOMAINS' | 'MAIL_FROM'>): string[] {
  if (env.STAFF_EMAIL_DOMAINS.length) return env.STAFF_EMAIL_DOMAINS;
  const at = env.MAIL_FROM.lastIndexOf('@');
  return at >= 0
    ? [
        env.MAIL_FROM.slice(at + 1)
          .replace(/>.*$/, '')
          .toLowerCase(),
      ]
    : [];
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    // Report variable names only — never values.
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${problems}`);
  }
  return parsed.data;
}
