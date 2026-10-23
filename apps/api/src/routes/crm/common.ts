import type { Lead, Prisma, PrismaClient } from '@datascribe/db';
import { LEAD_STAGES } from '@datascribe/shared';
import type { RequestHandler } from 'express';
import { z } from 'zod';
import { badRequest, forbidden, unauthorized } from '../../lib/errors';

/**
 * CRM records (leads, contacts, activities, accounts) belong to Datascribe, not to a client firm,
 * so they have no firm scope. Only users in the internal organisation may use CRM routes, whatever
 * their roles say. A client-org custom role with crm grants still gets 403 (D-018).
 */
export const requireInternal: RequestHandler = (req, _res, next) => {
  if (!req.auth) throw unauthorized();
  if (req.auth.user.orgType !== 'internal') throw forbidden();
  next();
};

export const LEAD_SOURCES = [
  'website_contact',
  'website_demo',
  'manual',
  'import',
  'referral',
  'event',
  'other',
] as const;

export const LeadStageSchema = z.enum(LEAD_STAGES);

/** Accepts 1234.5 or "1234.50"; stored as Decimal(12,2). */
export const MoneySchema = z
  .union([z.number(), z.string().trim()])
  .transform((v) => String(v))
  .refine((v) => /^\d{1,10}(\.\d{1,2})?$/.test(v), 'Use a positive amount with up to 2 decimals');

export const OptionalDate = z
  .union([z.string().datetime({ offset: true }), z.string().date(), z.null()])
  .transform((v) => (v === null ? null : new Date(v)));

export const Phone = z.string().trim().max(40);

/** Lead owners and activity assignees must be active internal users. */
export async function assertInternalUser(prisma: PrismaClient, userId: string, field: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { organization: true },
  });
  if (!user || user.status !== 'active' || user.organization.type !== 'internal') {
    throw badRequest('invalid_user', `${field} must be an active Datascribe staff user`);
  }
}

export function serializeLead(
  lead: Lead & { owner?: { id: string; name: string; email: string } | null },
) {
  return {
    id: lead.id,
    source: lead.source,
    companyName: lead.companyName,
    contactName: lead.contactName,
    email: lead.email,
    phone: lead.phone,
    stage: lead.stage,
    ownerId: lead.ownerId,
    owner: lead.owner
      ? { id: lead.owner.id, name: lead.owner.name, email: lead.owner.email }
      : null,
    value: lead.value?.toFixed(2) ?? null,
    currency: lead.currency,
    nextFollowUpAt: lead.nextFollowUpAt,
    lostReason: lead.lostReason,
    notes: lead.notes,
    convertedOrgId: lead.convertedOrgId,
    convertedAt: lead.convertedAt,
    createdAt: lead.createdAt,
    updatedAt: lead.updatedAt,
  };
}

export const ownerSelect = { select: { id: true, name: true, email: true } } as const;

export const Pagination = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export type LeadWhere = Prisma.LeadWhereInput;
