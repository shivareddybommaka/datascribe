import type { Prisma } from '@datascribe/db';
import { ACTIVITY_TYPES } from '@datascribe/shared';
import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireAuth, requirePermission } from '../../auth/middleware';
import type { Deps } from '../../context';
import { badRequest, notFound } from '../../lib/errors';
import { parse } from '../../lib/validate';
import {
  OptionalDate,
  Pagination,
  assertInternalUser,
  ownerSelect,
  requireInternal,
} from './common';

const ActivityFields = z.object({
  type: z.enum(ACTIVITY_TYPES),
  subject: z.string().trim().min(1).max(300),
  body: z.string().trim().max(10_000).nullish(),
  dueAt: OptionalDate.optional(),
  /** assignee; defaults to the current user */
  userId: z.string().min(1).optional(),
  leadId: z.string().min(1).nullish(),
  organizationId: z.string().min(1).nullish(),
});

function endOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));
}

export function activitiesRouter(deps: Deps): Router {
  const { prisma } = deps;
  const r = Router();
  r.use('/activities', authenticate(deps), requireInternal);

  async function assertLinks(links: { leadId?: string | null; organizationId?: string | null }) {
    if (links.leadId && !(await prisma.lead.findUnique({ where: { id: links.leadId } }))) {
      throw badRequest('invalid_lead', 'Unknown lead');
    }
    if (links.organizationId) {
      const org = await prisma.organization.findUnique({ where: { id: links.organizationId } });
      if (!org || org.type !== 'client') {
        throw badRequest('invalid_account', 'Unknown client account');
      }
    }
  }

  /**
   * "My tasks today" widget (§5.5): open tasks assigned to me, due before `dueBefore`
   * (the client sends the end of its local day), overdue ones included.
   */
  r.get('/activities/my-tasks', requirePermission('crm', 'view'), async (req, res) => {
    const auth = requireAuth(req);
    const { dueBefore } = parse(
      z.object({ dueBefore: z.string().datetime({ offset: true }).optional() }),
      req.query,
    );
    const end = dueBefore ? new Date(dueBefore) : endOfUtcDay(new Date());
    const items = await prisma.activity.findMany({
      where: { userId: auth.user.id, type: 'task', doneAt: null, dueAt: { lte: end } },
      include: {
        lead: { select: { id: true, companyName: true } },
        organization: { select: { id: true, name: true } },
      },
      orderBy: { dueAt: 'asc' },
      take: 200,
    });
    const now = Date.now();
    res.json({
      items: items.map((a) => ({ ...a, overdue: !!a.dueAt && a.dueAt.getTime() < now })),
    });
  });

  r.get('/activities', requirePermission('crm', 'view'), async (req, res) => {
    const auth = requireAuth(req);
    const q = parse(
      Pagination.extend({
        leadId: z.string().min(1).optional(),
        organizationId: z.string().min(1).optional(),
        userId: z.string().min(1).optional(), // "me" = current user
        type: z.enum(ACTIVITY_TYPES).optional(),
        open: z.enum(['true', 'false']).optional(),
      }),
      req.query,
    );
    const where: Prisma.ActivityWhereInput = {
      ...(q.leadId ? { leadId: q.leadId } : {}),
      ...(q.organizationId ? { organizationId: q.organizationId } : {}),
      ...(q.userId ? { userId: q.userId === 'me' ? auth.user.id : q.userId } : {}),
      ...(q.type ? { type: q.type } : {}),
      ...(q.open === 'true' ? { doneAt: null } : {}),
      ...(q.open === 'false' ? { doneAt: { not: null } } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.activity.findMany({
        where,
        include: { user: ownerSelect },
        orderBy: [{ dueAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }],
        take: q.limit,
        skip: q.offset,
      }),
      prisma.activity.count({ where }),
    ]);
    res.json({ items, total });
  });

  r.post('/activities', requirePermission('crm', 'create'), async (req, res) => {
    const auth = requireAuth(req);
    const body = parse(ActivityFields, req.body);
    if (body.type === 'task' && !body.dueAt) {
      throw badRequest('due_date_required', 'Tasks need a due date');
    }
    if (body.userId) await assertInternalUser(prisma, body.userId, 'userId');
    await assertLinks(body);
    const activity = await prisma.activity.create({
      data: {
        type: body.type,
        subject: body.subject,
        body: body.body ?? null,
        dueAt: body.dueAt ?? null,
        userId: body.userId ?? auth.user.id,
        leadId: body.leadId ?? null,
        organizationId: body.organizationId ?? null,
        // calls, emails, meetings and notes are logged after the fact; tasks start open
        doneAt: body.type === 'task' ? null : new Date(),
      },
      include: { user: ownerSelect },
    });
    await req.audit({ action: 'crm.activity.create', entity: 'Activity', entityId: activity.id });
    res.status(201).json(activity);
  });

  r.patch('/activities/:id', requirePermission('crm', 'edit'), async (req, res) => {
    const body = parse(
      ActivityFields.omit({ type: true }).partial().extend({ done: z.boolean().optional() }),
      req.body,
    );
    const existing = await prisma.activity.findUnique({ where: { id: String(req.params.id) } });
    if (!existing) throw notFound();
    if (body.userId) await assertInternalUser(prisma, body.userId, 'userId');
    await assertLinks(body);
    const { done, ...fields } = body;
    const doneAt = done === undefined ? undefined : done ? (existing.doneAt ?? new Date()) : null;
    const activity = await prisma.activity.update({
      where: { id: existing.id },
      data: { ...fields, ...(doneAt === undefined ? {} : { doneAt }) },
      include: { user: ownerSelect },
    });
    await req.audit({
      action: 'crm.activity.update',
      entity: 'Activity',
      entityId: activity.id,
      metadata: { fields: Object.keys(body) },
    });
    res.json(activity);
  });

  r.delete('/activities/:id', requirePermission('crm', 'delete'), async (req, res) => {
    const existing = await prisma.activity.findUnique({ where: { id: String(req.params.id) } });
    if (!existing) throw notFound();
    await prisma.activity.delete({ where: { id: existing.id } });
    await req.audit({ action: 'crm.activity.delete', entity: 'Activity', entityId: existing.id });
    res.status(204).end();
  });

  return r;
}
