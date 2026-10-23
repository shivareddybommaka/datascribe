import type { Prisma, PrismaClient } from '@datascribe/db';

/**
 * Editable email templates (§5.7, D-063). Plain-text only (mail goes out as `text`), so there is
 * no HTML to inject into. Rendering is one pass of `{{name}}` substitution: only the template's
 * declared variables exist, values are inserted literally (a value containing `{{x}}` is not
 * expanded again), and subjects lose line breaks so a value can't add mail headers.
 */
export interface TemplateDef {
  label: string;
  description: string;
  variables: readonly string[];
  /** must appear in the body, or the email would be useless (e.g. the accept link) */
  required: readonly string[];
  subject: string;
  body: string;
}

export const EMAIL_TEMPLATES = {
  invite: {
    label: 'Invitation',
    description: 'Sent when staff or a client admin invites someone (expires in 72 hours).',
    variables: ['inviterName', 'organizationName', 'acceptUrl'],
    required: ['acceptUrl'],
    subject: "You're invited to Datascribe ({{organizationName}})",
    body: '{{inviterName}} invited you to join {{organizationName}} on Datascribe.\nAccept: {{acceptUrl}}\nThis link expires in 72 hours.',
  },
  password_reset: {
    label: 'Password reset',
    description: 'Sent from "Forgot password" (link valid for 1 hour).',
    variables: ['name', 'resetUrl'],
    required: ['resetUrl'],
    subject: 'Reset your Datascribe password',
    body: "Reset your password:\n{{resetUrl}}\nThis link expires in 1 hour. If you didn't ask for this, ignore this email.",
  },
  mfa_reset: {
    label: 'Two-factor reset',
    description: 'Sent when an administrator resets a user’s two-factor authentication.',
    variables: ['name'],
    required: [],
    subject: 'Your Datascribe two-factor authentication was reset',
    body: "An administrator reset two-factor authentication on your account and signed out all sessions. You will set it up again at your next sign-in. If you didn't expect this, contact Datascribe support.",
  },
} as const satisfies Record<string, TemplateDef>;

export type TemplateKey = keyof typeof EMAIL_TEMPLATES;
export const TEMPLATE_KEYS = Object.keys(EMAIL_TEMPLATES) as TemplateKey[];
export const isTemplateKey = (k: string): k is TemplateKey => k in EMAIL_TEMPLATES;

export const TEMPLATES_SETTING = 'email_templates';

const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g;

/** Variable names used in a text, and whether any `{{`/`}}` is left that isn't a placeholder. */
function scan(text: string): { names: string[]; stray: boolean } {
  const names = [...text.matchAll(PLACEHOLDER)].map((m) => m[1]!);
  const rest = text.replace(PLACEHOLDER, '');
  return { names, stray: rest.includes('{{') || rest.includes('}}') };
}

/** Problems with an edited template, as field messages (empty = valid). */
export function templateProblems(
  key: TemplateKey,
  tpl: { subject: string; body: string },
): { path: string; message: string }[] {
  const def = EMAIL_TEMPLATES[key];
  const problems: { path: string; message: string }[] = [];
  for (const field of ['subject', 'body'] as const) {
    const { names, stray } = scan(tpl[field]);
    const unknown = [...new Set(names.filter((n) => !def.variables.includes(n as never)))];
    if (unknown.length) {
      problems.push({
        path: field,
        message: `Unknown variable(s): ${unknown.map((n) => `{{${n}}}`).join(', ')}`,
      });
    }
    if (stray) problems.push({ path: field, message: 'Unmatched {{ or }}' });
  }
  const used = scan(tpl.body).names;
  const missing = def.required.filter((r) => !used.includes(r));
  if (missing.length) {
    problems.push({
      path: 'body',
      message: `Must include ${missing.map((n) => `{{${n}}}`).join(', ')}`,
    });
  }
  return problems;
}

export function renderText(text: string, vars: Record<string, string>): string {
  return text.replace(PLACEHOLDER, (_m, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : '',
  );
}

export function renderTemplate(
  tpl: { subject: string; body: string },
  vars: Record<string, string>,
): { subject: string; text: string } {
  return {
    subject: renderText(tpl.subject, vars)
      .replace(/[\r\n]+/g, ' ')
      .trim(),
    text: renderText(tpl.body, vars),
  };
}

type Overrides = Partial<
  Record<TemplateKey, { subject: string; body: string; updatedAt?: string }>
>;

export async function loadTemplateOverrides(prisma: PrismaClient): Promise<Overrides> {
  const row = await prisma.setting.findUnique({ where: { key: TEMPLATES_SETTING } });
  const value = (row?.value ?? {}) as Record<string, unknown>;
  const out: Overrides = {};
  for (const key of TEMPLATE_KEYS) {
    const v = value[key] as { subject?: unknown; body?: unknown; updatedAt?: unknown } | undefined;
    if (v && typeof v.subject === 'string' && typeof v.body === 'string') {
      // a stored override that no longer validates falls back to the default
      if (templateProblems(key, { subject: v.subject, body: v.body }).length === 0) {
        out[key] = {
          subject: v.subject,
          body: v.body,
          updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : undefined,
        };
      }
    }
  }
  return out;
}

export async function saveTemplateOverrides(prisma: PrismaClient, overrides: Overrides) {
  const value = overrides as Prisma.InputJsonValue;
  await prisma.setting.upsert({
    where: { key: TEMPLATES_SETTING },
    update: { value },
    create: { key: TEMPLATES_SETTING, value },
  });
}

/** The current subject/body for a template (admin override or default), rendered. */
export async function renderEmail(
  prisma: PrismaClient,
  key: TemplateKey,
  vars: Record<string, string>,
): Promise<{ subject: string; text: string }> {
  const override = (await loadTemplateOverrides(prisma))[key];
  return renderTemplate(override ?? EMAIL_TEMPLATES[key], vars);
}
