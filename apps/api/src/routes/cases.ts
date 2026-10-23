import { CASE_STATUSES, decrypt, type Module } from '@datascribe/shared';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { authenticate, requireAuth, requirePermission } from '../auth/middleware';
import { canOnCase, caseScopeWhere } from '../auth/scoping';
import type { Deps } from '../context';
import { notFound } from '../lib/errors';
import { parse } from '../lib/validate';

/**
 * Read-only case routes (M1). They exist so org isolation and the PHI rules are enforced and
 * tested from day one. Create/edit/upload arrive in M4.
 */
export function casesRouter(deps: Deps): Router {
  const { prisma, phiKey } = deps;
  const r = Router();
  r.use('/cases', authenticate(deps));

  /** Load a case the caller may act on for module:view, or 404 (existence is not leaked). */
  async function loadVisibleCase(req: Request, module: Module) {
    const auth = requireAuth(req);
    const c = await prisma.case.findFirst({
      where: { AND: [{ id: String(req.params.id) }, caseScopeWhere(auth, module, 'view')] },
      include: { shares: { select: { userId: true } } },
    });
    if (!c || !canOnCase(auth, 'view', module, c)) throw notFound();
    return c;
  }

  r.get('/cases', requirePermission('cases', 'view'), async (req, res) => {
    const auth = requireAuth(req);
    const q = parse(
      z.object({
        status: z.enum(CASE_STATUSES).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      }),
      req.query,
    );
    const rows = await prisma.case.findMany({
      where: { AND: [caseScopeWhere(auth, 'cases', 'view'), q.status ? { status: q.status } : {}] },
      orderBy: { createdAt: 'desc' },
      take: q.limit,
    });
    res.json({
      items: rows.map((c) => ({
        id: c.id,
        number: c.number,
        organizationId: c.organizationId,
        matterName: c.matterName,
        reference: c.reference,
        patientName: decrypt(c.patientName, phiKey),
        caseType: c.caseType,
        priority: c.priority,
        status: c.status,
        dueAt: c.dueAt,
        createdAt: c.createdAt,
      })),
    });
  });

  r.get('/cases/:id', requirePermission('cases', 'view'), async (req, res) => {
    const c = await loadVisibleCase(req, 'cases');
    await req.audit({ action: 'case.view', entity: 'Case', entityId: c.id, organizationId: c.organizationId });
    res.json({
      id: c.id,
      number: c.number,
      organizationId: c.organizationId,
      matterName: c.matterName,
      reference: c.reference,
      patientName: decrypt(c.patientName, phiKey),
      incidentDate: c.incidentDate,
      caseType: c.caseType,
      requested: c.requested,
      priority: c.priority,
      status: c.status,
      dueAt: c.dueAt,
      notes: c.notes,
      createdById: c.createdById,
      caseManagerId: c.caseManagerId,
      summarizerId: c.summarizerId,
      qaReviewerId: c.qaReviewerId,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    });
  });

  r.get('/cases/:id/documents', requirePermission('documents', 'view'), async (req, res) => {
    const c = await loadVisibleCase(req, 'documents');
    const docs = await prisma.document.findMany({
      where: { caseId: c.id, organizationId: c.organizationId },
      orderBy: { createdAt: 'asc' },
    });
    // §4.4: every document view is audited (listing metadata included).
    await req.audit({
      action: 'document.list',
      entity: 'Case',
      entityId: c.id,
      organizationId: c.organizationId,
      metadata: { count: docs.length },
    });
    res.json({
      items: docs.map((d) => ({
        id: d.id,
        fileName: d.fileName,
        mimeType: d.mimeType,
        sizeBytes: Number(d.sizeBytes),
        pageCount: d.pageCount,
        scanStatus: d.scanStatus,
        uploadedAt: d.uploadedAt,
      })),
    });
  });

  r.get('/cases/:id/deliverables', requirePermission('deliverables', 'view'), async (req, res) => {
    const c = await loadVisibleCase(req, 'deliverables');
    const items = await prisma.deliverable.findMany({
      where: { caseId: c.id },
      orderBy: [{ type: 'asc' }, { version: 'desc' }],
      select: { id: true, type: true, version: true, status: true, createdAt: true },
    });
    await req.audit({
      action: 'deliverable.list',
      entity: 'Case',
      entityId: c.id,
      organizationId: c.organizationId,
      metadata: { count: items.length },
    });
    res.json({ items });
  });

  return r;
}
