import type { Prisma, PrismaClient } from '@datascribe/db';
import {
  EMAIL_TEMPLATES,
  TEMPLATES_SETTING,
  parseTemplateOverrides,
  renderTemplate,
  type AccountTemplateKey,
  type TemplateOverrides,
} from '@datascribe/shared/email-templates';

/**
 * Editable email templates (§5.7, D-063, D-097). The templates, validation and rendering live in
 * `@datascribe/shared/email-templates` (the worker's notification outbox uses them too); this file
 * only loads and saves the admin's overrides.
 */
export {
  EMAIL_TEMPLATES,
  TEMPLATE_KEYS,
  TEMPLATES_SETTING,
  isTemplateKey,
  previewTemplate,
  renderTemplate,
  renderText,
  templateProblems,
  type TemplateDef,
  type TemplateKey,
} from '@datascribe/shared/email-templates';

export async function loadTemplateOverrides(prisma: PrismaClient): Promise<TemplateOverrides> {
  const row = await prisma.setting.findUnique({ where: { key: TEMPLATES_SETTING } });
  return parseTemplateOverrides(row?.value);
}

export async function saveTemplateOverrides(prisma: PrismaClient, overrides: TemplateOverrides) {
  const value = overrides as Prisma.InputJsonValue;
  await prisma.setting.upsert({
    where: { key: TEMPLATES_SETTING },
    update: { value },
    create: { key: TEMPLATES_SETTING, value },
  });
}

/** The current subject/body for an account email (admin override or default), rendered. */
export async function renderEmail(
  prisma: PrismaClient,
  key: AccountTemplateKey,
  vars: Record<string, string>,
): Promise<{ subject: string; text: string }> {
  const override = (await loadTemplateOverrides(prisma))[key];
  return renderTemplate(override ?? EMAIL_TEMPLATES[key], vars);
}
