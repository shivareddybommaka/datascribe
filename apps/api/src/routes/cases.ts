import type { Prisma } from '@datascribe/db';
import {
  notifyAssigned,
  notifyCaseSubmitted,
  notifyQaDecision,
} from '@datascribe/db/notifications';
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
import { effectivePermissions, type AuthContext } from '../auth/context';
import { authenticate, requireAuth, requirePermission } from '../auth/middleware';
import { canOnCase, caseScopeWhere } from '../auth/scoping';
import type { Deps } from '../context';
import { HttpError, badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { safeNotify } from '../lib/notify';
import { decryptOptional, encryptOptional } from '../lib/phi';
import { parse } from '../lib/validate';
import {
  ASSIGNABLE_BY,
  ASSIGNABLE_STATUSES,
  ASSIGNMENT_FIELD,
  ASSIGNMENT_ROLES,
  CLOSED_STATUSES,
  SLA_STATUSES,
  TIMELINE_ACTIONS,
  UPLOADABLE_STATUSES,
  nextCaseNumber,
  slaFlag,
  slaWhere,
  type AssignmentRole,
} from '../services/cases';
import {
  EDITABLE_CASE_STATUSES,
  EDITABLE_DELIVERABLE_STATUSES,
  EDITABLE_TYPES,
  QaDecisionBody,
  SUBMITTABLE_CASE_STATUSES,
  SaveDeliverableBody,
  citationProblem,
  contentCounts,
  contentSchema,
  qaProblem,
  type EditableType,
} from '../services/deliverables';
import { DOWNLOAD_URL_TTL_S, serializeDocument } from './documents';

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

const staffRef = { select: { id: true, name: true } } as const;

const caseInclude = {
  shares: { select: { userId: true, user: { select: { id: true, name: true, email: true } } } },
  createdBy: { select: { id: true, name: true } },
  organization: { select: { id: true, name: true } },
  caseManager: staffRef,
  summarizer: staffRef,
  qaReviewer: staffRef,
} satisfies Prisma.CaseInclude;

const queueInclude = {
  organization: { select: { id: true, name: true } },
  caseManager: staffRef,
  summarizer: staffRef,
  qaReviewer: staffRef,
} satisfies Prisma.CaseInclude;

const UserId = z.string().min(1).max(40);

/** Body of POST /cases/:id/assign: a user id sets the assignment, null clears it (D-083). */
const AssignBody = z
  .object({
    caseManagerId: UserId.nullable().optional(),
    summarizerId: UserId.nullable().optional(),
    qaReviewerId: UserId.nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to assign');

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

/** cases:manage (ops_manager) reassigns anything; plain case managers work their own cases. */
const canReassignAny = (auth: AuthContext) =>
  broadestScope(auth.permissions, 'cases', 'manage') === 'all';

/**
 * Assignment rights (§5.4, D-083): internal staff with cases:edit on every firm (case managers,
 * ops, super admin). Without cases:manage the caller must manage the case, or claim an unmanaged
 * one, and may set the summarizer and QA reviewer; only cases:manage moves someone else's case.
 */
const canAssign = (auth: AuthContext, c: { caseManagerId: string | null; status: string }) =>
  auth.user.orgType === 'internal' &&
  broadestScope(auth.permissions, 'cases', 'edit') === 'all' &&
  (ASSIGNABLE_STATUSES as readonly string[]).includes(c.status) &&
  (canReassignAny(auth) || c.caseManagerId === null || c.caseManagerId === auth.user.id);

/** Staff who may send the case's drafts to QA: anyone who may edit them (D-088). */
const canSubmitQa = (auth: AuthContext, c: CaseRow) =>
  auth.user.orgType === 'internal' &&
  canOnCase(auth, 'edit', 'deliverables', c) &&
  (SUBMITTABLE_CASE_STATUSES as readonly string[]).includes(c.status);

/**
 * The QA decision (D-088): the case's assigned QA reviewer, or someone holding deliverables:approve
 * on every case (super admin). Never the summarizer: four eyes, as for assignment (D-083).
 */
const canDecideQa = (auth: AuthContext, c: CaseRow) =>
  auth.user.orgType === 'internal' &&
  c.status === 'qa' &&
  canOnCase(auth, 'approve', 'deliverables', c) &&
  auth.permissions.some((p) => p.module === 'qa_reviews' && p.action === 'create') &&
  (c.qaReviewerId === auth.user.id ||
    broadestScope(auth.permissions, 'deliverables', 'approve') === 'all') &&
  c.summarizerId !== auth.user.id;

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
    sla: slaFlag(c),
    submittedAt: c.submittedAt,
    createdAt: c.createdAt,
  });

  /** Queue row for staff: adds the client firm and who is assigned (never shown to clients). */
  const staffSummary = (c: Prisma.CaseGetPayload<{ include: typeof queueInclude }>) => ({
    ...summary(c),
    organization: c.organization,
    caseManager: c.caseManager,
    summarizer: c.summarizer,
    qaReviewer: c.qaReviewer,
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
        assign: canAssign(auth, c),
        reassignAny: canAssign(auth, c) && canReassignAny(auth),
        submitQa: canSubmitQa(auth, c),
        decideQa: canDecideQa(auth, c),
        downloadReport: c.deliveredAt !== null && canOnCase(auth, 'view', 'deliverables', c),
      },
      ...(auth.user.orgType === 'internal'
        ? {
            assignees: {
              caseManager: c.caseManager,
              summarizer: c.summarizer,
              qaReviewer: c.qaReviewer,
            },
          }
        : {}),
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
        // staff queue filters (§5.4): client firm, assignee, SLA flag, due date
        organizationId: z.string().min(1).max(40).optional(),
        assigneeId: z.string().min(1).max(40).optional(),
        unassigned: z.enum(ASSIGNMENT_ROLES).optional(),
        sla: z.enum(['red', 'amber', 'any']).optional(),
        dueBefore: DateOnly.optional(),
        sort: z.enum(['created', 'due', 'priority']).default('created'),
        limit: z.coerce.number().int().min(1).max(100).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      }),
      req.query,
    );
    const staff = auth.user.orgType === 'internal';
    if (!staff && (q.organizationId || q.assigneeId || q.unassigned)) {
      throw badRequest('staff_only_filter', 'These filters are for Datascribe staff');
    }
    const assignee = q.assigneeId === 'me' ? auth.user.id : q.assigneeId;
    const now = new Date();
    const where: Prisma.CaseWhereInput = {
      AND: [
        caseScopeWhere(auth, 'cases', 'view'),
        q.status ? { status: { in: q.status } } : {},
        q.open === 'true' ? { status: { notIn: [...CLOSED_STATUSES] } } : {},
        q.caseType ? { caseType: q.caseType } : {},
        q.priority ? { priority: q.priority } : {},
        q.organizationId ? { organizationId: q.organizationId } : {},
        assignee
          ? {
              OR: [
                { caseManagerId: assignee },
                { summarizerId: assignee },
                { qaReviewerId: assignee },
              ],
            }
          : {},
        q.unassigned
          ? { [ASSIGNMENT_FIELD[q.unassigned]]: null, status: { in: [...SLA_STATUSES] } }
          : {},
        q.sla === 'any'
          ? { OR: [slaWhere('red', now), slaWhere('amber', now)] }
          : q.sla
            ? slaWhere(q.sla, now)
            : {},
        q.dueBefore ? { dueAt: { lte: new Date(`${q.dueBefore}T23:59:59Z`) } } : {},
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
            : q.sort === 'priority'
              ? // Priority enum order is low < normal < high < urgent
                [
                  { priority: 'desc' },
                  { dueAt: { sort: 'asc', nulls: 'last' } },
                  { createdAt: 'desc' },
                ]
              : { createdAt: 'desc' },
        take: q.limit,
        skip: q.offset,
        include: staff ? queueInclude : undefined,
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
    res.json({
      total,
      items: staff
        ? (rows as Prisma.CaseGetPayload<{ include: typeof queueInclude }>[]).map(staffSummary)
        : rows.map(summary),
    });
  });

  // ── Assignment (§5.4, D-083) ──────────────────────────────────────────
  /** Active internal users who can fill a role, with their open workload, for the assign picker. */
  r.get('/cases/assignable-staff', requirePermission('cases', 'edit'), async (req, res) => {
    const auth = requireAuth(req);
    if (
      auth.user.orgType !== 'internal' ||
      broadestScope(auth.permissions, 'cases', 'edit') !== 'all'
    ) {
      throw forbidden();
    }
    const { role } = parse(z.object({ role: z.enum(ASSIGNMENT_ROLES) }), req.query);
    const people = await eligibleStaff(role);
    const field = ASSIGNMENT_FIELD[role];
    const load = await prisma.case.groupBy({
      by: [field],
      where: { [field]: { in: people.map((p) => p.id) }, status: { in: [...SLA_STATUSES] } },
      _count: { _all: true },
    });
    const openCount = new Map(load.map((l) => [l[field] as string, l._count._all]));
    res.json({
      role,
      items: people.map((p) => ({ ...p, openCases: openCount.get(p.id) ?? 0 })),
    });
  });

  /** Internal active users whose permissions fit the role (by grant, so custom roles count). */
  async function eligibleStaff(role: AssignmentRole, ids?: string[]) {
    const need = ASSIGNABLE_BY[role];
    const users = await prisma.user.findMany({
      where: {
        ...(ids ? { id: { in: ids } } : {}),
        status: 'active',
        organization: { type: 'internal', status: 'active' },
        roles: {
          some: {
            role: {
              permissions: {
                some: {
                  permission: {
                    module: need.module,
                    action: need.action,
                    scope: { in: need.scopes },
                  },
                },
              },
            },
          },
        },
      },
      select: {
        id: true,
        name: true,
        email: true,
        roles: {
          include: { role: { include: { permissions: { include: { permission: true } } } } },
        },
      },
      orderBy: { name: 'asc' },
    });
    // the SQL filter is a pre-check; effectivePermissions is the same rule the request path uses
    return users
      .filter((u) =>
        effectivePermissions(
          u.roles.flatMap((ur) => ur.role.permissions.map((rp) => rp.permission)),
          'internal',
        ).some(
          (p) =>
            p.module === need.module && p.action === need.action && need.scopes.includes(p.scope),
        ),
      )
      .map((u) => ({ id: u.id, name: u.name, email: u.email }));
  }

  r.post('/cases/:id/assign', requirePermission('cases', 'edit'), async (req, res) => {
    const auth = requireAuth(req);
    const body = parse(AssignBody, req.body);
    const c = await loadCase(req, 'cases', 'edit');
    if (!canAssign(auth, c)) {
      if (!(ASSIGNABLE_STATUSES as readonly string[]).includes(c.status)) {
        throw conflict('not_assignable', `A ${c.status} case cannot be assigned`);
      }
      throw forbidden();
    }
    const any = canReassignAny(auth);
    const changes: { role: AssignmentRole; from: string | null; to: string | null }[] = [];
    for (const role of ASSIGNMENT_ROLES) {
      const field = ASSIGNMENT_FIELD[role];
      const to = body[field];
      if (to === undefined || to === c[field]) continue;
      changes.push({ role, from: c[field], to });
    }
    if (changes.length === 0) {
      res.json(await detail(req, c));
      return;
    }
    // Without cases:manage, the case manager slot can only be claimed (empty → me) or released (me → empty)
    const cm = changes.find((ch) => ch.role === 'case_manager');
    if (
      cm &&
      !any &&
      !(cm.from === null && cm.to === auth.user.id) &&
      !(cm.from === auth.user.id && cm.to === null)
    ) {
      throw forbidden('Only an operations manager can move a case to another case manager');
    }
    const next = {
      caseManagerId: body.caseManagerId !== undefined ? body.caseManagerId : c.caseManagerId,
      summarizerId: body.summarizerId !== undefined ? body.summarizerId : c.summarizerId,
      qaReviewerId: body.qaReviewerId !== undefined ? body.qaReviewerId : c.qaReviewerId,
    };
    // four eyes: the person who wrote the deliverables cannot QA them (D-083)
    if (next.summarizerId && next.summarizerId === next.qaReviewerId) {
      throw conflict('same_person', 'The summarizer and the QA reviewer must be different people');
    }
    for (const ch of changes) {
      if (ch.to === null) continue;
      const ok = await eligibleStaff(ch.role, [ch.to]);
      if (ok.length !== 1) {
        throw badRequest(
          'not_eligible',
          `That person cannot be the case's ${ch.role.replace('_', ' ')}`,
        );
      }
    }
    // compare-and-set on the previous assignment so two managers can't overwrite each other
    const { count } = await prisma.case.updateMany({
      where: {
        id: c.id,
        status: { in: [...ASSIGNABLE_STATUSES] },
        caseManagerId: c.caseManagerId,
        summarizerId: c.summarizerId,
        qaReviewerId: c.qaReviewerId,
      },
      data: next,
    });
    if (count !== 1)
      throw conflict('assignment_changed', 'Someone else changed this case; reload it');
    for (const ch of changes) {
      await req.audit({
        action: 'case.assign',
        entity: 'Case',
        entityId: c.id,
        organizationId: c.organizationId,
        metadata: { role: ch.role, from: ch.from, to: ch.to },
      });
    }
    for (const ch of changes) {
      if (!ch.to) continue;
      const to = ch.to;
      await safeNotify(deps.logger, 'assigned_to_you', () =>
        notifyAssigned(prisma, c.id, to, ch.role, auth.user.id),
      );
    }
    const fresh = await prisma.case.findUniqueOrThrow({
      where: { id: c.id },
      include: caseInclude,
    });
    res.json(await detail(req, fresh));
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
    const auth = requireAuth(req);
    const c = await loadCase(req, 'deliverables');
    const items = await prisma.deliverable.findMany({
      // clients see only what was delivered; drafts and QA versions are staff-only (D-099)
      where: {
        caseId: c.id,
        ...(auth.user.orgType === 'internal' ? {} : { status: 'delivered' as const }),
      },
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

  /**
   * The delivered report (M6 part 5b, §5.4, D-099): a 5-minute signed URL to the latest report PDF
   * the worker stored (D-098). Anyone who may view the case's deliverables: the client's users the
   * case is visible to, and staff. Audited like a document download.
   */
  r.get(
    '/cases/:id/report/download-url',
    requirePermission('deliverables', 'view'),
    async (req, res) => {
      const c = await loadCase(req, 'deliverables');
      const d = await prisma.deliverable.findFirst({
        where: { caseId: c.id, status: 'delivered', pdfS3Key: { not: null } },
        orderBy: [{ updatedAt: 'desc' }, { type: 'asc' }],
        select: { id: true, pdfS3Key: true },
      });
      if (!d?.pdfS3Key) throw notFound('This case has no delivered report yet');
      const url = await deps.storage.presignDownload(d.pdfS3Key, {
        fileName: `${c.number}-report.pdf`,
        contentType: 'application/pdf',
        expiresIn: DOWNLOAD_URL_TTL_S,
      });
      await req.audit({
        action: 'report.download',
        entity: 'Case',
        entityId: c.id,
        organizationId: c.organizationId,
        metadata: { deliverableId: d.id },
      });
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({ url, expiresAt: new Date(Date.now() + DOWNLOAD_URL_TTL_S * 1000) });
    },
  );

  // ── Staff workspace (M6 part 2, §5.4, D-084) ──────────────────────────
  /**
   * Everything the workspace page shows at once: the case's documents (for the viewer), the
   * latest version of each deliverable with its decrypted content, and the clinical events with
   * their citations. Internal staff only; drafts are never shown to clients.
   */
  r.get('/cases/:id/workspace', requirePermission('deliverables', 'view'), async (req, res) => {
    const auth = requireAuth(req);
    if (auth.user.orgType !== 'internal') throw notFound();
    const c = await loadCase(req, 'deliverables');
    if (!canOnCase(auth, 'view', 'documents', c)) throw notFound();
    const [docs, deliverables, events] = await Promise.all([
      prisma.document.findMany({
        where: { caseId: c.id, organizationId: c.organizationId, uploadedAt: { not: null } },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          fileName: true,
          mimeType: true,
          pageCount: true,
          scanStatus: true,
          purgedAt: true,
        },
      }),
      prisma.deliverable.findMany({
        where: { caseId: c.id },
        orderBy: [{ type: 'asc' }, { version: 'desc' }],
        include: { editedBy: staffRef },
      }),
      prisma.clinicalEvent.findMany({
        where: { caseId: c.id },
        orderBy: [{ eventDate: 'asc' }, { documentId: 'asc' }, { pageNumber: 'asc' }],
      }),
    ]);
    const latest = deliverables.filter(
      (d, i) => deliverables.findIndex((o) => o.type === d.type) === i,
    );
    await req.audit({
      action: 'case.workspace_view',
      entity: 'Case',
      entityId: c.id,
      organizationId: c.organizationId,
      metadata: { documents: docs.length, deliverables: latest.length, events: events.length },
    });
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      case: await detail(req, c),
      documents: docs.map((d) => ({
        id: d.id,
        fileName: d.fileName,
        mimeType: d.mimeType,
        pageCount: d.pageCount,
        state: d.purgedAt ? 'purged' : d.scanStatus,
      })),
      deliverables: latest.map((d) => ({
        id: d.id,
        type: d.type,
        version: d.version,
        status: d.status,
        lockedAt: d.lockedAt,
        createdAt: d.createdAt,
        editedBy: d.editedBy,
        content: JSON.parse(decrypt(d.content, phiKey)) as unknown,
      })),
      clinicalEvents: events.map((e) => ({
        id: e.id,
        documentId: e.documentId,
        pageNumber: e.pageNumber,
        eventDate: e.eventDate,
        provider: e.provider,
        facility: e.facility,
        eventType: e.eventType,
        description: decryptOptional(e.description, phiKey),
        codes: e.codes,
        version: e.version,
      })),
    });
  });

  // ── Versioned edits (M6 part 3, §5.4, D-086) ──────────────────────────
  const editableType = (req: Request): EditableType => {
    const t = String(req.params.type);
    if (!(EDITABLE_TYPES as readonly string[]).includes(t)) throw notFound();
    return t as EditableType;
  };

  /** Internal staff who may see the case's drafts (workspace rule, D-084). */
  async function loadDraftCase(req: Request, action: Action) {
    const auth = requireAuth(req);
    if (auth.user.orgType !== 'internal') throw notFound();
    const c = await loadCase(req, 'deliverables', action);
    if (!canOnCase(auth, 'view', 'documents', c)) throw notFound();
    return c;
  }

  r.get(
    '/cases/:id/deliverables/:type/versions',
    requirePermission('deliverables', 'view'),
    async (req, res) => {
      const type = editableType(req);
      const c = await loadDraftCase(req, 'view');
      const items = await prisma.deliverable.findMany({
        where: { caseId: c.id, type },
        orderBy: { version: 'desc' },
        select: {
          id: true,
          version: true,
          status: true,
          lockedAt: true,
          createdAt: true,
          editedBy: staffRef,
        },
      });
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({ items });
    },
  );

  r.get(
    '/cases/:id/deliverables/:type/versions/:version',
    requirePermission('deliverables', 'view'),
    async (req, res) => {
      const type = editableType(req);
      const version = Number(req.params.version);
      if (!Number.isInteger(version) || version < 1) throw badRequest('bad_version', 'Bad version');
      const c = await loadDraftCase(req, 'view');
      const d = await prisma.deliverable.findUnique({
        where: { caseId_type_version: { caseId: c.id, type, version } },
        include: { editedBy: staffRef },
      });
      if (!d) throw notFound();
      await req.audit({
        action: 'deliverable.version_view',
        entity: 'Deliverable',
        entityId: d.id,
        organizationId: c.organizationId,
        metadata: { caseId: c.id, type, version },
      });
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({
        id: d.id,
        type: d.type,
        version: d.version,
        status: d.status,
        lockedAt: d.lockedAt,
        createdAt: d.createdAt,
        editedBy: d.editedBy,
        content: JSON.parse(decrypt(d.content, phiKey)) as unknown,
      });
    },
  );

  /**
   * Save an edit as a new version. `baseVersion` must be the latest version (optimistic lock: a
   * stale editor gets 409 and reloads). Only drafts of a case in review can change; QA-submitted,
   * approved or locked versions are read-only. Earlier versions are kept, so an edit is undone by
   * saving an older version's content again.
   */
  r.put(
    '/cases/:id/deliverables/:type',
    requirePermission('deliverables', 'edit'),
    async (req, res) => {
      const auth = requireAuth(req);
      const type = editableType(req);
      const body = parse(SaveDeliverableBody, req.body);
      const content = parse(contentSchema(type), body.content);
      const c = await loadDraftCase(req, 'edit');
      if (!(EDITABLE_CASE_STATUSES as readonly string[]).includes(c.status)) {
        throw conflict(
          'case_not_editable',
          'Deliverables can only be edited while the case is in review',
        );
      }
      const docs = await prisma.document.findMany({
        where: { caseId: c.id, organizationId: c.organizationId, uploadedAt: { not: null } },
        select: { id: true, pageCount: true },
      });
      const problem = citationProblem(content, new Map(docs.map((d) => [d.id, d.pageCount])));
      if (problem) throw badRequest('bad_citation', problem);

      const saved = await prisma
        .$transaction(async (tx) => {
          const latest = await tx.deliverable.findFirst({
            where: { caseId: c.id, type },
            orderBy: { version: 'desc' },
          });
          if (!latest) throw notFound();
          if (latest.version !== body.baseVersion) {
            throw conflict('version_conflict', 'Someone saved a newer version; reload to continue');
          }
          if (
            latest.lockedAt ||
            !(EDITABLE_DELIVERABLE_STATUSES as readonly string[]).includes(latest.status)
          ) {
            throw conflict('deliverable_locked', 'This version is with QA or approved');
          }
          return tx.deliverable.create({
            data: {
              caseId: c.id,
              type,
              version: latest.version + 1,
              status: 'draft',
              content: encrypt(JSON.stringify(content), phiKey),
              editedById: auth.user.id,
            },
            include: { editedBy: staffRef },
          });
        })
        .catch((err: unknown) => {
          // two saves on the same base: the unique (caseId, type, version) lets one win
          if ((err as { code?: string }).code === 'P2002') {
            throw conflict('version_conflict', 'Someone saved a newer version; reload to continue');
          }
          throw err;
        });
      await req.audit({
        action: 'deliverable.edit',
        entity: 'Deliverable',
        entityId: saved.id,
        organizationId: c.organizationId,
        metadata: { caseId: c.id, type, version: saved.version, ...contentCounts(content) },
      });
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({
        id: saved.id,
        type: saved.type,
        version: saved.version,
        status: saved.status,
        lockedAt: saved.lockedAt,
        createdAt: saved.createdAt,
        editedBy: saved.editedBy,
        content,
      });
    },
  );

  // ── QA (M6 part 4, §5.4, D-088) ───────────────────────────────────────
  /** Latest version of each editable deliverable of the case (the report is built after QA). */
  async function latestDrafts(db: Prisma.TransactionClient | typeof prisma, caseId: string) {
    const all = await db.deliverable.findMany({
      where: { caseId, type: { in: [...EDITABLE_TYPES] } },
      orderBy: [{ type: 'asc' }, { version: 'desc' }],
    });
    return all.filter((d, i) => all.findIndex((o) => o.type === d.type) === i);
  }

  const versionsOf = (ds: { type: string; version: number }[]) =>
    Object.fromEntries(ds.map((d) => [d.type, d.version]));

  async function freshDetail(req: Request, caseId: string) {
    const fresh = await prisma.case.findUniqueOrThrow({
      where: { id: caseId },
      include: caseInclude,
    });
    return detail(req, fresh);
  }

  /**
   * Submit for QA: the latest version of every draft goes to `in_qa` and the case to `qa`. Needs a
   * QA reviewer on the case and a citation on every chronology entry. While in QA nothing can be
   * edited (the PUT above refuses `qa` cases and `in_qa` versions).
   */
  r.post('/cases/:id/submit-qa', requirePermission('deliverables', 'edit'), async (req, res) => {
    const auth = requireAuth(req);
    const c = await loadDraftCase(req, 'edit');
    if (!canSubmitQa(auth, c)) {
      throw conflict('case_not_in_review', `A ${c.status} case cannot be sent to QA`);
    }
    if (!c.qaReviewerId) throw conflict('no_qa_reviewer', 'Assign a QA reviewer first');
    const latest = await latestDrafts(prisma, c.id);
    if (latest.length === 0) throw conflict('no_deliverables', 'There is nothing to review yet');
    for (const d of latest) {
      if (d.lockedAt || !(EDITABLE_DELIVERABLE_STATUSES as readonly string[]).includes(d.status)) {
        throw conflict('deliverable_locked', `The ${d.type} is already with QA or approved`);
      }
      const problem = qaProblem(d.type as EditableType, JSON.parse(decrypt(d.content, phiKey)));
      if (problem) throw conflict('not_ready', problem);
    }
    await prisma.$transaction(async (tx) => {
      const moved = await tx.case.updateMany({
        where: { id: c.id, status: c.status },
        data: { status: 'qa' },
      });
      if (moved.count !== 1) throw conflict('case_changed', 'Someone else changed this case');
      const sent = await tx.deliverable.updateMany({
        where: {
          id: { in: latest.map((d) => d.id) },
          status: { in: [...EDITABLE_DELIVERABLE_STATUSES] },
          lockedAt: null,
        },
        data: { status: 'in_qa' },
      });
      // a version saved since we read `latest` would otherwise stay behind as an unreviewed draft
      const newer = await tx.deliverable.count({
        where: {
          caseId: c.id,
          OR: latest.map((d) => ({ type: d.type, version: { gt: d.version } })),
        },
      });
      if (sent.count !== latest.length || newer > 0) {
        throw conflict('version_conflict', 'Someone saved a newer version; reload to continue');
      }
    });
    await req.audit({
      action: 'case.status',
      entity: 'Case',
      entityId: c.id,
      organizationId: c.organizationId,
      metadata: { from: c.status, to: 'qa', by: 'submit_qa', versions: versionsOf(latest) },
    });
    res.json(await freshDetail(req, c.id));
  });

  /**
   * QA decision: approve (locks the reviewed versions, case `approved`) or request changes (comments
   * required, case `changes_requested`, the summarizer edits on top). One QaReview row per reviewed
   * version; comments are encrypted (they may quote the records) and never audited.
   */
  r.post(
    '/cases/:id/qa',
    requirePermission('deliverables', 'approve'),
    requirePermission('qa_reviews', 'create'),
    async (req, res) => {
      const auth = requireAuth(req);
      const body = parse(QaDecisionBody, req.body);
      const c = await loadDraftCase(req, 'approve');
      if (c.status !== 'qa') throw conflict('not_in_qa', `A ${c.status} case is not with QA`);
      if (!canDecideQa(auth, c)) {
        throw forbidden(
          c.summarizerId === auth.user.id
            ? 'You summarized this case, so someone else must QA it'
            : "Only the case's QA reviewer can decide",
        );
      }
      const latest = await latestDrafts(prisma, c.id);
      if (latest.length === 0 || latest.some((d) => d.status !== 'in_qa')) {
        throw conflict('qa_changed', 'The drafts changed after they were sent to QA; reload');
      }
      const ownEdits = await prisma.deliverable.count({
        where: { caseId: c.id, editedById: auth.user.id },
      });
      if (ownEdits > 0) {
        throw forbidden('You edited these deliverables, so someone else must QA them');
      }
      const approved = body.result === 'approved';
      if (approved) {
        for (const d of latest) {
          const problem = qaProblem(d.type as EditableType, JSON.parse(decrypt(d.content, phiKey)));
          if (problem) throw conflict('not_ready', problem);
        }
      }
      const to = approved ? 'approved' : 'changes_requested';
      await prisma.$transaction(async (tx) => {
        const moved = await tx.case.updateMany({
          where: { id: c.id, status: 'qa' },
          data: { status: to },
        });
        if (moved.count !== 1) throw conflict('case_changed', 'Someone else decided this case');
        const done = await tx.deliverable.updateMany({
          where: { id: { in: latest.map((d) => d.id) }, status: 'in_qa' },
          data: { status: to, ...(approved ? { lockedAt: new Date() } : {}) },
        });
        if (done.count !== latest.length) {
          throw conflict('qa_changed', 'The drafts changed after they were sent to QA; reload');
        }
        await tx.qaReview.createMany({
          data: latest.map((d) => ({
            deliverableId: d.id,
            reviewerId: auth.user.id,
            result: body.result,
            comments: encryptOptional(body.comments, phiKey),
          })),
        });
      });
      await req.audit({
        action: 'case.status',
        entity: 'Case',
        entityId: c.id,
        organizationId: c.organizationId,
        metadata: {
          from: 'qa',
          to,
          by: 'qa_decision',
          versions: versionsOf(latest),
          comments: !!body.comments,
        },
      });
      await safeNotify(deps.logger, approved ? 'approved' : 'qa_changes_requested', () =>
        notifyQaDecision(prisma, c.id, approved),
      );
      res.json(await freshDetail(req, c.id));
    },
  );

  /** QA history of the case, newest first, for the summarizer, the reviewer and managers. */
  r.get('/cases/:id/qa-reviews', requirePermission('deliverables', 'view'), async (req, res) => {
    const c = await loadDraftCase(req, 'view');
    const reviews = await prisma.qaReview.findMany({
      where: { deliverable: { caseId: c.id } },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      include: { reviewer: staffRef, deliverable: { select: { type: true, version: true } } },
    });
    await req.audit({
      action: 'qa_review.list',
      entity: 'Case',
      entityId: c.id,
      organizationId: c.organizationId,
      metadata: { count: reviews.length },
    });
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      items: reviews.map((q) => ({
        id: q.id,
        result: q.result,
        comments: decryptOptional(q.comments, phiKey),
        createdAt: q.createdAt,
        reviewer: q.reviewer,
        deliverable: q.deliverable,
      })),
    });
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
