import type { Prisma } from '@datascribe/db';
import { UPSTREAMS } from '@datascribe/medical-data';
import { PRIORITIES, SETTINGS_EVENTS } from '@datascribe/shared';
import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requirePermission } from '../../auth/middleware';
import type { Deps } from '../../context';
import { HttpError, notFound } from '../../lib/errors';
import {
  ALL_ENABLED,
  MEDICAL_SETTING,
  togglesFrom,
  type MedicalToggles,
} from '../../lib/medical-switches';
import {
  EMAIL_TEMPLATES,
  TEMPLATE_KEYS,
  isTemplateKey,
  loadTemplateOverrides,
  renderTemplate,
  saveTemplateOverrides,
  templateProblems,
  type TemplateKey,
} from '../../lib/templates';
import { parse } from '../../lib/validate';
import { requireInternal } from '../crm/common';

/** §5.8 events; per-event email / in-app switches. Security emails are not listed: never muted. */
export const NOTIFICATION_EVENTS = SETTINGS_EVENTS;

const Percent = z
  .union([z.number(), z.string().trim()])
  .transform((v) => Number(v))
  .refine((n) => Number.isFinite(n) && n >= 0 && n <= 100, 'Between 0 and 100');

const TaxRule = z.object({ label: z.string().trim().min(1).max(30), ratePercent: Percent });

/** Setting "company": company details + invoice settings, read by billing (getBillingSettings). */
const Company = z
  .object({
    name: z.string().trim().min(1).max(200),
    address: z.string().trim().max(500).default(''),
    email: z.union([z.string().trim().email().max(254), z.literal('')]).default(''),
    taxId: z.string().trim().max(60).default(''),
    taxLabel: z.string().trim().min(1).max(30),
    taxRatePercent: Percent,
    taxByCurrency: z
      .record(
        z
          .string()
          .regex(/^[A-Za-z]{3}$/)
          .transform((c) => c.toUpperCase()),
        TaxRule,
      )
      .default({}),
    invoicePrefix: z
      .string()
      .trim()
      .regex(/^[A-Z0-9]{1,10}$/, '1–10 capital letters or digits')
      .default('INV'),
    paymentTermsDays: z.number().int().min(0).max(120).default(14),
  })
  .strict();

const PriorityDays = z.object(
  Object.fromEntries(PRIORITIES.map((p) => [p, z.number().int().min(1).max(365)])) as Record<
    (typeof PRIORITIES)[number],
    z.ZodNumber
  >,
);

/** Setting "sla": default due dates per priority and the amber "due soon" window (§5.4). */
const Sla = z
  .object({ turnaroundDays: PriorityDays, dueSoonHours: z.number().int().min(1).max(168) })
  .strict();

const Notifications = z
  .object({
    rules: z.object(
      Object.fromEntries(
        NOTIFICATION_EVENTS.map((e) => [
          e,
          z.object({ email: z.boolean(), inApp: z.boolean() }).strict(),
        ]),
      ) as unknown as Record<(typeof NOTIFICATION_EVENTS)[number], z.ZodTypeAny>,
    ),
  })
  .strict();

const Medical = z
  .object({
    enabled: z
      .object(
        Object.fromEntries(UPSTREAMS.map((u) => [u, z.boolean()])) as Record<
          (typeof UPSTREAMS)[number],
          z.ZodBoolean
        >,
      )
      .strict(),
  })
  .strict();

const DEFAULTS = {
  company: {
    name: 'Datascribe',
    address: '',
    email: '',
    taxId: '',
    taxLabel: 'Tax',
    taxRatePercent: 0,
    taxByCurrency: {},
    invoicePrefix: 'INV',
    paymentTermsDays: 14,
  },
  sla: { turnaroundDays: { urgent: 1, high: 3, normal: 7, low: 14 }, dueSoonHours: 24 },
  notifications: {
    rules: Object.fromEntries(NOTIFICATION_EVENTS.map((e) => [e, { email: true, inApp: true }])),
  },
};

const SECTIONS = {
  company: Company,
  sla: Sla,
  notifications: Notifications,
} as const;
type Section = keyof typeof SECTIONS;

/**
 * §5.7 Settings + email templates (D-063). system_settings is super-admin only: the built-in
 * super_admin role is the only holder, and custom roles can't be granted it (D-060).
 */
export function settingsRouter(deps: Deps): Router {
  const { prisma } = deps;
  const r = Router();
  r.use(['/admin/settings', '/admin/email-templates'], authenticate(deps), requireInternal);
  const canView = requirePermission('system_settings', 'view');
  const canEdit = requirePermission('system_settings', 'edit');

  async function read(section: Section) {
    const row = await prisma.setting.findUnique({ where: { key: section } });
    // merge over defaults, then validate: a hand-edited row never breaks the screen
    const merged = { ...DEFAULTS[section], ...((row?.value ?? {}) as object) };
    const parsed = SECTIONS[section].safeParse(merged);
    return parsed.success ? parsed.data : DEFAULTS[section];
  }

  async function medicalStatus() {
    const row = await prisma.setting.findUnique({ where: { key: MEDICAL_SETTING } });
    const enabled: MedicalToggles = row ? togglesFrom(row.value) : { ...ALL_ENABLED };
    return {
      provider: deps.medical?.provider ?? 'mock',
      openFdaApiKeyConfigured: Boolean(deps.env.OPENFDA_API_KEY),
      enabled,
      usage24h: deps.medical?.usageStats(24 * 60 * 60 * 1000) ?? [],
    };
  }

  r.get('/admin/settings', canView, async (_req, res) => {
    res.json({
      company: await read('company'),
      sla: await read('sla'),
      notifications: await read('notifications'),
      notificationEvents: NOTIFICATION_EVENTS,
      medical: await medicalStatus(),
    });
  });

  for (const section of Object.keys(SECTIONS) as Section[]) {
    r.put(`/admin/settings/${section}`, canEdit, async (req, res) => {
      const schema: z.ZodType<unknown, z.ZodTypeDef, unknown> = SECTIONS[section];
      const value = parse(schema, req.body) as Prisma.InputJsonValue;
      await prisma.setting.upsert({
        where: { key: section },
        update: { value },
        create: { key: section, value },
      });
      await req.audit({
        action: 'admin.settings.updated',
        entity: 'Setting',
        entityId: section,
        metadata: { fields: Object.keys(req.body as object).sort() },
      });
      res.json(await read(section));
    });
  }

  r.get('/admin/settings/medical', canView, async (_req, res) => {
    res.json(await medicalStatus());
  });

  r.put('/admin/settings/medical', canEdit, async (req, res) => {
    const body = parse(Medical, req.body);
    await prisma.setting.upsert({
      where: { key: MEDICAL_SETTING },
      update: { value: body },
      create: { key: MEDICAL_SETTING, value: body },
    });
    deps.medicalSwitches?.set(body.enabled);
    await req.audit({
      action: 'admin.settings.updated',
      entity: 'Setting',
      entityId: MEDICAL_SETTING,
      metadata: {
        disabled: Object.entries(body.enabled)
          .filter(([, on]) => !on)
          .map(([u]) => u),
      },
    });
    res.json(await medicalStatus());
  });

  // ── Email templates ──────────────────────────────────────────────
  const templateView = async (key: TemplateKey) => {
    const override = (await loadTemplateOverrides(prisma))[key];
    const def = EMAIL_TEMPLATES[key];
    return {
      key,
      label: def.label,
      description: def.description,
      variables: def.variables,
      required: def.required,
      subject: override?.subject ?? def.subject,
      body: override?.body ?? def.body,
      customized: !!override,
      updatedAt: override?.updatedAt ?? null,
    };
  };

  const keyParam = (raw: unknown): TemplateKey => {
    const key = String(raw);
    if (!isTemplateKey(key)) throw notFound();
    return key;
  };

  const TemplateBody = z.object({
    subject: z.string().trim().min(1).max(200),
    body: z.string().min(1).max(10_000),
  });

  const validTemplate = (key: TemplateKey, tpl: z.infer<typeof TemplateBody>) => {
    const problems = templateProblems(key, tpl);
    if (problems.length) {
      throw new HttpError(400, 'validation_failed', 'Invalid template', problems);
    }
    return tpl;
  };

  r.get('/admin/email-templates', canView, async (_req, res) => {
    res.json({ items: await Promise.all(TEMPLATE_KEYS.map(templateView)) });
  });

  r.put('/admin/email-templates/:key', canEdit, async (req, res) => {
    const key = keyParam(req.params.key);
    const tpl = validTemplate(key, parse(TemplateBody, req.body));
    const overrides = await loadTemplateOverrides(prisma);
    overrides[key] = { ...tpl, updatedAt: new Date().toISOString() };
    await saveTemplateOverrides(prisma, overrides);
    await req.audit({ action: 'admin.email_template.updated', entity: 'Setting', entityId: key });
    res.json(await templateView(key));
  });

  // Back to the built-in text.
  r.delete('/admin/email-templates/:key', canEdit, async (req, res) => {
    const key = keyParam(req.params.key);
    const overrides = await loadTemplateOverrides(prisma);
    delete overrides[key];
    await saveTemplateOverrides(prisma, overrides);
    await req.audit({ action: 'admin.email_template.reset', entity: 'Setting', entityId: key });
    res.json(await templateView(key));
  });

  // Render a draft with sample values, without saving it.
  r.post('/admin/email-templates/:key/preview', canView, async (req, res) => {
    const key = keyParam(req.params.key);
    const tpl = validTemplate(key, parse(TemplateBody, req.body));
    const sample: Record<string, string> = {
      inviterName: 'Alex Example',
      organizationName: 'Acme Injury Law (synthetic)',
      acceptUrl: `${deps.env.APP_URL}/invite/accept?token=example`,
      name: 'Sam Synthetic',
      resetUrl: `${deps.env.APP_URL}/reset-password?token=example`,
    };
    res.json(renderTemplate(tpl, sample));
  });

  return r;
}
