import type { Prisma } from '@datascribe/db';
import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requirePermission } from '../../auth/middleware';
import type { Deps } from '../../context';
import { toCsv } from '../../lib/csv';
import { badRequest } from '../../lib/errors';
import { parse } from '../../lib/validate';
import { Pagination, requireInternal } from '../crm/common';

export const AUDIT_EXPORT_MAX = 10_000;

const DateParam = z
  .union([z.string().datetime({ offset: true }), z.string().date()])
  .transform((v) => new Date(v));

const Filters = z.object({
  /** actor id, or text matched against the actor's (or impersonator's) name / email */
  actorId: z.string().min(1).max(64).optional(),
  user: z.string().trim().min(1).max(100).optional(),
  /** "admin.user" matches every admin.user.* action */
  action: z.string().trim().min(1).max(100).optional(),
  entity: z.string().trim().min(1).max(60).optional(),
  entityId: z.string().trim().min(1).max(64).optional(),
  organizationId: z.string().min(1).max(64).optional(),
  impersonatedOnly: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  from: DateParam.optional(),
  /** inclusive: a plain date means the end of that day (UTC) */
  to: z
    .union([z.string().datetime({ offset: true }), z.string().date()])
    .transform((v) => (v.length === 10 ? new Date(`${v}T23:59:59.999Z`) : new Date(v)))
    .optional(),
});

function whereFor(f: z.infer<typeof Filters>): Prisma.AuditLogWhereInput {
  if (f.from && f.to && f.from > f.to) throw badRequest('bad_range', '"from" is after "to"');
  const person = (q: string): Prisma.UserWhereInput => ({
    OR: [
      { name: { contains: q, mode: 'insensitive' } },
      { email: { contains: q, mode: 'insensitive' } },
    ],
  });
  return {
    AND: [
      f.actorId ? { actorId: f.actorId } : {},
      f.user ? { OR: [{ actor: person(f.user) }, { impersonator: person(f.user) }] } : {},
      f.action ? { action: { startsWith: f.action } } : {},
      f.entity ? { entity: f.entity } : {},
      f.entityId ? { entityId: f.entityId } : {},
      f.organizationId ? { organizationId: f.organizationId } : {},
      f.impersonatedOnly ? { impersonatorId: { not: null } } : {},
      f.from || f.to
        ? { createdAt: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) } }
        : {},
    ],
  };
}

const include = {
  actor: { select: { id: true, name: true, email: true } },
  impersonator: { select: { id: true, name: true, email: true } },
  organization: { select: { id: true, name: true } },
} satisfies Prisma.AuditLogInclude;

/**
 * §5.7 audit log viewer: read-only (AuditLog is append-only, D-008). Internal staff with
 * audit_log:view (super_admin, ops_manager); CSV export needs audit_log:export (super_admin).
 */
export function auditRouter(deps: Deps): Router {
  const { prisma } = deps;
  const r = Router();
  r.use('/admin/audit-logs', authenticate(deps), requireInternal);

  r.get('/admin/audit-logs', requirePermission('audit_log', 'view'), async (req, res) => {
    const q = parse(Filters.merge(Pagination), req.query);
    const where = whereFor(q);
    const [items, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        include,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: q.limit,
        skip: q.offset,
      }),
      prisma.auditLog.count({ where }),
    ]);
    res.json({ total, items });
  });

  r.get('/admin/audit-logs/export', requirePermission('audit_log', 'export'), async (req, res) => {
    const q = parse(Filters, req.query);
    const where = whereFor(q);
    const total = await prisma.auditLog.count({ where });
    if (total > AUDIT_EXPORT_MAX) {
      throw badRequest(
        'too_many_rows',
        `${total} entries match; narrow the filters to ${AUDIT_EXPORT_MAX.toLocaleString('en')} or fewer`,
      );
    }
    const logs = await prisma.auditLog.findMany({
      where,
      include,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    const headers = [
      'createdAt',
      'action',
      'entity',
      'entityId',
      'actorEmail',
      'actorId',
      'impersonatorEmail',
      'organization',
      'organizationId',
      'ip',
      'metadata',
      'id',
    ];
    const rows = logs.map((l) => ({
      createdAt: l.createdAt,
      action: l.action,
      entity: l.entity,
      entityId: l.entityId,
      actorEmail: l.actor?.email,
      actorId: l.actorId,
      impersonatorEmail: l.impersonator?.email,
      organization: l.organization?.name,
      organizationId: l.organizationId,
      ip: l.ip,
      metadata: JSON.stringify(l.metadata ?? {}),
      id: l.id,
    }));
    await req.audit({
      action: 'admin.audit.export',
      entity: 'AuditLog',
      metadata: { count: rows.length, filters: Object.keys(req.query).sort() },
    });
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', 'attachment; filename="audit-log.csv"');
    res.setHeader('cache-control', 'private, no-store');
    res.send(toCsv(headers, rows));
  });

  return r;
}
