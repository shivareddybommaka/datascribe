import type { Prisma } from '@datascribe/db';
import { notifyCaseSubmitted } from '@datascribe/db/notifications';
import {
  CASE_STATUSES,
  CASE_TYPES,
  PRIORITIES,
  broadestScope,
  decrypt,
  encrypt,
  type Action,
  type Module,
} from '@datascribe/shared';
import { Router, type Request } from 'express';
import { z } from 'zod';
import type { AuthContext } from '../auth/context';
import { authenticate, requireAuth, requirePermission } from '../auth/middleware';
import { canOnCase, caseScopeWhere } from '../auth/scoping';
import type { Deps } from '../context';
import { HttpError, badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { safeNotify } from '../lib/notify';
import { decryptOptional, encryptOptional } from '../lib/phi';
import { parse } from '../lib/validate';
import {
  CLOSED_STATUSES,
  TIMELINE_ACTIONS,
  UPLOADABLE_STATUSES,
  nextCaseNumber,
} from '../services/cases';
import { serializeDocument } from './documents';

const REQUESTABLE = ['index', 'chronology', 'summary'] as const;

const Text = (max: number) => z.string().trim().min(1).max(max);
const OptionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => v || null);

const DateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), 'Not a valid date');

const CaseFields = z.object({
  matterName: Text(200),
  reference: OptionalText(100),
  patientName: Text(200),
  incidentDate: DateOnly.refine(
    (v) => new Date(`${v}T00:00:00Z`) <= new Date(),
    'The incident date cannot be in the future',
  )
    .nullish()
    .transform((v) => (v ? new Date(`${v}T00:00:00Z`) : null)),
  caseType: z.enum(CASE_TYPES),
  requested: z
    .array(z.enum(REQUESTABLE))
    .min(1, 'Choose at least one deliverable')
    .transform((v) => [...new Set(v)]),
  priority: z.enum(PRIORITIES).default('normal'),
  dueAt: z
    .union([DateOnly, z.string().datetime({ offset: true })])
    .nullish()
    .transform((v) => (v ? new Date(v.length === 10 ? `${v}T23:59:59Z` : v) : null)),
  notes: OptionalText(5000),
});

const CreateCase = CaseFields.extend({ organizationId: z.string().min(1).max(40).optional() });
const PatchCase = CaseFields.partial().refine(
  (v) => Object.keys(v).length > 0,
  'Nothing to update',
);

const caseInclude = {
  shares: { select: { userId: true, user: { select: { id: true, name: true, email: true } } } },
  createdBy: { select: { id: true, name: true } },
  organization: { select: { id: true, name: true } },
} satisfies Prisma.CaseInclude;

type CaseRow = Prisma.CaseGetPayload<{ include: typeof caseInclude }>;

const scopeAtLeastFirm = (auth: AuthContext, module: Module, action: Action) => {
  const s = broadestScope(auth.permissions, module, action);
  return s === 'all' || s === 'firm';
};

/**
 * Sharing (§5.3) is managed by the case's creator, or by someone holding cases:edit for the whole
 * firm (client_admin) or every firm (staff). A user the case is merely shared with cannot re-share.
 */
const canManageShares = (auth: AuthContext, c: CaseRow) =>
  canOnCase(auth, 'edit', 'cases', c) &&
  (c.createdById === auth.user.id || scopeAtLeastFirm(auth, 'cases', 'edit'));

/**
 * §5.3 / §9 case routes. Every route: Zod input, permission check, org scoping (caseScopeWhere +
 * a CASL check on the loaded row; not-visible = 404), and an audit row where §4.4 asks for one.
 * Patient name, notes and message bodies are encrypted at rest (D-013, audit L5).
 */
export function casesRouter(deps: Deps): Router {
  const { prisma, phiKey } = deps;
  const r = Router();
  r.use('/cases', authenticate(deps));

  /** Load a case the caller may act on for module:action, or 404 (existence is not leaked). */
  async function loadCase(req: Request, module: Module, action: Action = 'view') {
    const auth = requireAuth(req);
    const c = await prisma.case.findFirst({
      where: { AND: [{ id: String(req.params.id) }, caseScopeWhere(auth, module, action)] },
      include: caseInclude,
    });
    if (!c || !canOnCase(auth, action, module, c)) throw notFound();
    return c;
  }

  const summary = (c: Prisma.CaseGetPayload<object>) => ({
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
    submittedAt: c.submittedAt,
    createdAt: c.createdAt,
  });

  async function detail(req: Request, c: CaseRow) {
    const auth = requireAuth(req);
    const events = await prisma.auditLog.findMany({
      where: { entity: 'Case', entityId: c.id, action: { in: [...TIMELINE_ACTIONS] } },
      orderBy: { createdAt: 'asc' },
      select: { action: true, createdAt: true, metadata: true },
    });
    const canEdit = canOnCase(auth, 'edit', 'cases', c);
    return {
      ...summary(c),
      organization: c.organization,
      incidentDate: c.incidentDate,
      requested: c.requested,
      notes: decryptOptional(c.notes, phiKey),
      createdBy: c.createdBy,
      createdById: c.createdById,
      caseManagerId: c.caseManagerId,
      summarizerId: c.summarizerId,
      qaReviewerId: c.qaReviewerId,
      deliveredAt: c.deliveredAt,
      closedAt: c.closedAt,
      updatedAt: c.updatedAt,
      shares: c.shares.map((s) => s.user),
      timeline: events.map((e) => ({
        at: e.createdAt,
        status: ((e.metadata ?? {}) as { to?: string }).to ?? null,
        action: e.action,
      })),
      // UI hints only; every action is checked again by its own route
      can: {
        edit: canEdit && c.status === 'draft',
        submit: canEdit && c.status === 'draft',
        share: canManageShares(auth, c),
        upload: canOnCase(auth, 'create', 'documents', c) && UPLOADABLE_STATUSES.includes(c.status),
        deleteDocuments:
          canOnCase(auth, 'delete', 'documents', c) && UPLOADABLE_STATUSES.includes(c.status),
        message: true,
        internalMessages: auth.user.orgType === 'internal',
      },
    };
  }

  // ── List / filter ─────────────────────────────────────────────────────
  r.get('/cases', requirePermission('cases', 'view'), async (req, res) => {
    const auth = requireAuth(req);
    const q = parse(
      z.object({
        status: z
          .string()
          .optional()
          .transform((v) => (v ? v.split(',') : undefined))
          .pipe(z.array(z.enum(CASE_STATUSES)).optional()),
        open: z.enum(['true', 'false']).optional(),
        caseType: z.enum(CASE_TYPES).optional(),
        priority: z.enum(PRIORITIES).optional(),
        q: z.string().trim().min(1).max(100).optional(),
        sort: z.enum(['created', 'due']).default('created'),
        limit: z.coerce.number().int().min(1).max(100).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      }),
      req.query,
    );
    const where: Prisma.CaseWhereInput = {
      AND: [
        caseScopeWhere(auth, 'cases', 'view'),
        q.status ? { status: { in: q.status } } : {},
        q.open === 'true' ? { status: { notIn: [...CLOSED_STATUSES] } } : {},
        q.caseType ? { caseType: q.caseType } : {},
        q.priority ? { priority: q.priority } : {},
        // patient names are encrypted, so search covers matter, reference and number only
        q.q
          ? {
              OR: [
                { matterName: { contains: q.q, mode: 'insensitive' } },
                { reference: { contains: q.q, mode: 'insensitive' } },
                { number: { contains: q.q, mode: 'insensitive' } },
              ],
            }
          : {},
      ],
    };
    const [rows, total] = await Promise.all([
      prisma.case.findMany({
        where,
        orderBy:
          q.sort === 'due'
            ? [{ dueAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }]
            : { createdAt: 'desc' },
        take: q.limit,
        skip: q.offset,
      }),
      prisma.case.count({ where }),
    ]);
    // Lists show patient names, so they are audited too (audit finding L4).
    await req.audit({
      action: 'case.list',
      entity: 'Case',
      organizationId: auth.user.orgType === 'client' ? auth.user.organizationId : null,
      metadata: { count: rows.length, total },
    });
    res.json({ total, items: rows.map(summary) });
  });

  // ── Create ────────────────────────────────────────────────────────────
  r.post('/cases', requirePermission('cases', 'create'), async (req, res) => {
    const auth = requireAuth(req);
    const body = parse(CreateCase, req.body);
    let organizationId = auth.user.organizationId;
    if (auth.user.orgType === 'internal') {
      // staff create cases on a firm's behalf
      if (broadestScope(auth.permissions, 'cases', 'create') !== 'all') throw forbidden();
      if (!body.organizationId) throw badRequest('organization_required', 'Choose a client firm');
      organizationId = body.organizationId;
    } else if (body.organizationId && body.organizationId !== organizationId) {
      throw notFound();
    }
    const org = await prisma.organization.findFirst({
      where: { id: organizationId, type: 'client', status: 'active' },
    });
    if (!org) throw notFound();

    const created = await prisma.$transaction(async (tx) =>
      tx.case.create({
        data: {
          number: await nextCaseNumber(tx, new Date().getUTCFullYear()),
          organizationId,
          matterName: body.matterName,
          reference: body.reference,
          patientName: encrypt(body.patientName, phiKey),
          incidentDate: body.incidentDate,
          caseType: body.caseType,
          requested: body.requested,
          priority: body.priority,
          dueAt: body.dueAt,
          notes: encryptOptional(body.notes, phiKey),
          createdById: auth.user.id,
          status: 'draft',
        },
        include: caseInclude,
      }),
    );
    await req.audit({
      action: 'case.create',
      entity: 'Case',
      entityId: created.id,
      organizationId,
      metadata: { number: created.number, to: 'draft' },
    });
    res.status(201).json(await detail(req, created));
  });

  // ── Detail / edit / submit ────────────────────────────────────────────
  r.get('/cases/:id', requirePermission('cases', 'view'), async (req, res) => {
    const c = await loadCase(req, 'cases');
    await req.audit({
      action: 'case.view',
      entity: 'Case',
      entityId: c.id,
      organizationId: c.organizationId,
    });
    res.json(await detail(req, c));
  });

  r.patch('/cases/:id', requirePermission('cases', 'edit'), async (req, res) => {
    const body = parse(PatchCase, req.body);
    const c = await loadCase(req, 'cases', 'edit');
    if (c.status !== 'draft') {
      throw conflict('case_locked', 'Only draft cases can be edited; message Datascribe instead');
    }
    const data: Prisma.CaseUpdateInput = {
      ...body,
      ...(body.patientName !== undefined ? { patientName: encrypt(body.patientName, phiKey) } : {}),
      ...(body.notes !== undefined ? { notes: encryptOptional(body.notes, phiKey) } : {}),
    };
    // compare-and-set on the status so a concurrent submit can't be overwritten
    const { count } = await prisma.case.updateMany({
      where: { id: c.id, status: 'draft' },
      data: data as Prisma.CaseUpdateManyMutationInput,
    });
    if (count !== 1) throw conflict('case_locked', 'Only draft cases can be edited');
    await req.audit({
      action: 'case.edit',
      entity: 'Case',
      entityId: c.id,
      organizationId: c.organizationId,
      metadata: { fields: Object.keys(body).sort() },
    });
    const fresh = await prisma.case.findUniqueOrThrow({
      where: { id: c.id },
      include: caseInclude,
    });
    res.json(await detail(req, fresh));
  });

  r.post('/cases/:id/submit', requirePermission('cases', 'edit'), async (req, res) => {
    const c = await loadCase(req, 'cases', 'edit');
    if (c.status !== 'draft') throw conflict('not_draft', `A ${c.status} case cannot be submitted`);
    const ready = await prisma.document.count({
      where: { caseId: c.id, uploadedAt: { not: null }, scanStatus: { not: 'infected' } },
    });
    if (ready === 0) {
      throw new HttpError(409, 'no_documents', 'Upload at least one record before submitting');
    }
    const { count } = await prisma.case.updateMany({
      where: { id: c.id, status: 'draft' },
      data: { status: 'submitted', submittedAt: new Date() },
    });
    if (count !== 1) throw conflict('not_draft', 'This case was already submitted');
    await req.audit({
      action: 'case.submit',
      entity: 'Case',
      entityId: c.id,
      organizationId: c.organizationId,
      metadata: { from: 'draft', to: 'submitted', documents: ready },
    });
    await safeNotify(deps.logger, 'case_submitted', () => notifyCaseSubmitted(prisma, c.id));
    const fresh = await prisma.case.findUniqueOrThrow({
      where: { id: c.id },
      include: caseInclude,
    });
    res.json(await detail(req, fresh));
  });

  // ── Documents and deliverables (lists) ────────────────────────────────
  r.get('/cases/:id/documents', requirePermission('documents', 'view'), async (req, res) => {
    const c = await loadCase(req, 'documents');
    const docs = await prisma.document.findMany({
      where: { caseId: c.id, organizationId: c.organizationId },
      include: { uploadedBy: { select: { id: true, name: true } } },
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
    res.json({ items: docs.map((d) => serializeDocument(d, deps.env)) });
  });

  r.get('/cases/:id/deliverables', requirePermission('deliverables', 'view'), async (req, res) => {
    const c = await loadCase(req, 'deliverables');
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

  // ── Sharing (CaseShare, same firm only) ───────────────────────────────
  r.get('/cases/:id/share-candidates', requirePermission('cases', 'edit'), async (req, res) => {
    const auth = requireAuth(req);
    const c = await loadCase(req, 'cases', 'edit');
    if (!canManageShares(auth, c)) throw forbidden('Only the case owner or a firm admin can share');
    const users = await prisma.user.findMany({
      where: {
        organizationId: c.organizationId,
        status: 'active',
        id: { notIn: [c.createdById, ...c.shares.map((s) => s.userId)] },
      },
      select: { id: true, name: true, email: true },
      orderBy: { name: 'asc' },
      take: 500,
    });
    res.json({ items: users });
  });

  r.post('/cases/:id/shares', requirePermission('cases', 'edit'), async (req, res) => {
    const auth = requireAuth(req);
    const body = parse(z.object({ userId: z.string().min(1).max(40) }), req.body);
    const c = await loadCase(req, 'cases', 'edit');
    if (!canManageShares(auth, c)) throw forbidden('Only the case owner or a firm admin can share');
    const user = await prisma.user.findFirst({
      where: { id: body.userId, organizationId: c.organizationId, status: 'active' },
    });
    // users of other firms are indistinguishable from unknown ids
    if (!user) throw badRequest('unknown_user', 'Choose an active user in the same firm');
    if (user.id === c.createdById) throw badRequest('owner', 'The case owner already has access');
    await prisma.caseShare.upsert({
      where: { caseId_userId: { caseId: c.id, userId: user.id } },
      update: {},
      create: { caseId: c.id, userId: user.id },
    });
    await req.audit({
      action: 'case.share',
      entity: 'Case',
      entityId: c.id,
      organizationId: c.organizationId,
      metadata: { userId: user.id },
    });
    const fresh = await prisma.case.findUniqueOrThrow({
      where: { id: c.id },
      include: caseInclude,
    });
    res.status(201).json({ shares: fresh.shares.map((s) => s.user) });
  });

  r.delete('/cases/:id/shares/:userId', requirePermission('cases', 'edit'), async (req, res) => {
    const auth = requireAuth(req);
    const c = await loadCase(req, 'cases', 'edit');
    if (!canManageShares(auth, c)) throw forbidden('Only the case owner or a firm admin can share');
    const userId = String(req.params.userId);
    const { count } = await prisma.caseShare.deleteMany({ where: { caseId: c.id, userId } });
    if (count === 0) throw notFound();
    await req.audit({
      action: 'case.unshare',
      entity: 'Case',
      entityId: c.id,
      organizationId: c.organizationId,
      metadata: { userId },
    });
    res.status(204).end();
  });

  // ── Messages with Datascribe staff ────────────────────────────────────
  r.get('/cases/:id/messages', requirePermission('cases', 'view'), async (req, res) => {
    const auth = requireAuth(req);
    const c = await loadCase(req, 'cases');
    const internal = auth.user.orgType === 'internal';
    const rows = await prisma.message.findMany({
      // internal-only notes never leave the API for client users
      where: { caseId: c.id, ...(internal ? {} : { internalOnly: false }) },
      include: {
        author: { select: { id: true, name: true, organization: { select: { type: true } } } },
      },
      orderBy: { createdAt: 'asc' },
      take: 500,
    });
    res.json({
      items: rows.map((m) => ({
        id: m.id,
        body: decrypt(m.body, phiKey),
        internalOnly: m.internalOnly,
        createdAt: m.createdAt,
        author: {
          id: m.author.id,
          name: m.author.name,
          staff: m.author.organization.type === 'internal',
        },
      })),
    });
  });

  r.post('/cases/:id/messages', requirePermission('cases', 'view'), async (req, res) => {
    const auth = requireAuth(req);
    const body = parse(
      z.object({ body: Text(5000), internalOnly: z.boolean().default(false) }),
      req.body,
    );
    const c = await loadCase(req, 'cases');
    if (body.internalOnly && auth.user.orgType !== 'internal') {
      throw forbidden('Only Datascribe staff can write internal notes');
    }
    const m = await prisma.message.create({
      data: {
        caseId: c.id,
        authorId: auth.user.id,
        body: encrypt(body.body, phiKey),
        internalOnly: body.internalOnly,
      },
    });
    await req.audit({
      action: 'message.create',
      entity: 'Message',
      entityId: m.id,
      organizationId: c.organizationId,
      metadata: { caseId: c.id, internalOnly: m.internalOnly },
    });
    res.status(201).json({
      id: m.id,
      body: body.body,
      internalOnly: m.internalOnly,
      createdAt: m.createdAt,
      author: { id: auth.user.id, name: auth.user.name, staff: auth.user.orgType === 'internal' },
    });
  });

  return r;
}
