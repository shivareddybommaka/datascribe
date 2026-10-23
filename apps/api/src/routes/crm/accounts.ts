import type { Prisma } from '@datascribe/db';
import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requirePermission } from '../../auth/middleware';
import type { Deps } from '../../context';
import { notFound } from '../../lib/errors';
import { parse } from '../../lib/validate';
import { Pagination, ownerSelect, requireInternal, serializeLead } from './common';

/**
 * §5.5 Accounts = client Organizations, seen from the CRM. Read-only here: accounts are created by
 * lead conversion or self-registration, and edited in the admin console (M2). No case or PHI data.
 */
export function accountsRouter(deps: Deps): Router {
  const { prisma } = deps;
  const r = Router();
  r.use('/accounts', authenticate(deps), requireInternal, requirePermission('crm', 'view'));

  r.get('/accounts', async (req, res) => {
    const q = parse(
      Pagination.extend({
        q: z.string().trim().min(1).max(100).optional(),
        status: z.enum(['active', 'suspended', 'closed']).optional(),
      }),
      req.query,
    );
    const where: Prisma.OrganizationWhereInput = {
      type: 'client',
      ...(q.status ? { status: q.status } : {}),
      ...(q.q ? { name: { contains: q.q, mode: 'insensitive' } } : {}),
    };
    const [orgs, total] = await Promise.all([
      prisma.organization.findMany({
        where,
        include: {
          plan: { select: { id: true, name: true } },
          _count: { select: { contacts: true, users: true } },
          convertedFrom: { select: { id: true, ownerId: true }, take: 1 },
        },
        orderBy: { name: 'asc' },
        take: q.limit,
        skip: q.offset,
      }),
      prisma.organization.count({ where }),
    ]);
    res.json({
      total,
      items: orgs.map((o) => ({
        id: o.id,
        name: o.name,
        status: o.status,
        currency: o.currency,
        plan: o.plan,
        contactCount: o._count.contacts,
        userCount: o._count.users,
        leadId: o.convertedFrom[0]?.id ?? null,
        createdAt: o.createdAt,
      })),
    });
  });

  r.get('/accounts/:id', async (req, res) => {
    const org = await prisma.organization.findFirst({
      where: { id: String(req.params.id), type: 'client' },
      include: {
        plan: { select: { id: true, name: true, priceMonthly: true, currency: true } },
        contacts: { orderBy: { name: 'asc' } },
        activities: { orderBy: { createdAt: 'desc' }, take: 100, include: { user: ownerSelect } },
        convertedFrom: { include: { owner: ownerSelect } },
        users: {
          select: {
            id: true,
            name: true,
            email: true,
            status: true,
            roles: { select: { role: { select: { key: true } } } },
          },
        },
      },
    });
    if (!org) throw notFound();
    res.json({
      id: org.id,
      name: org.name,
      status: org.status,
      currency: org.currency,
      plan: org.plan,
      createdAt: org.createdAt,
      contacts: org.contacts,
      activities: org.activities,
      users: org.users.map((u) => ({ ...u, roles: u.roles.map((r) => r.role.key) })),
      leads: org.convertedFrom.map(serializeLead),
    });
  });

  return r;
}
