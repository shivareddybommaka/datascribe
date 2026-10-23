import { z } from 'zod';

const bool = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

const secret = z.string().min(32, 'must be at least 32 characters');

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
