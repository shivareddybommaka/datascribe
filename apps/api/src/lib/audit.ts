import type { Prisma, PrismaClient } from '@datascribe/db';
import type { Request } from 'express';

export interface AuditEntry {
  action: string;
  entity: string;
  entityId?: string | null;
  organizationId?: string | null;
  /** defaults to the authenticated user */
  actorId?: string | null;
  /** ids, counts and reasons only. Never PHI, document text or passwords. */
  metadata?: Record<string, unknown>;
}

/** Append-only: the DB trigger rejects UPDATE/DELETE on AuditLog. */
export async function writeAudit(prisma: PrismaClient, req: Request, entry: AuditEntry) {
  await prisma.auditLog.create({
    data: {
      actorId: entry.actorId ?? req.auth?.user.id ?? null,
      impersonatorId: req.auth?.impersonatorId ?? null,
      organizationId: entry.organizationId ?? null,
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId ?? null,
      ip: req.ip ?? null,
      userAgent: req.get('user-agent')?.slice(0, 255) ?? null,
      metadata: (entry.metadata ?? {}) as Prisma.InputJsonValue,
    },
  });
}
