import type { Prisma } from '@datascribe/db';
import { LEAD_STAGES, broadestScope, type LeadStage } from '@datascribe/shared';
import express, { Router, type Request } from 'express';
import { z } from 'zod';
import { authenticate, requireAuth, requirePermission } from '../../auth/middleware';
import { staffEmailDomains } from '../../config/env';
import type { Deps } from '../../context';
import { parseCsv, toCsv } from '../../lib/csv';
import { HttpError, badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { parse } from '../../lib/validate';
import { Email } from '../auth';
import { issueInvite } from '../invites';
import {
  LEAD_SOURCES,
  LeadStageSchema,
  MoneySchema,
  OptionalDate,
  Pagination,
  Phone,
  assertInternalUser,
  ownerSelect,
  requireInternal,
  serializeLead,
} from './common';

const MAX_IMPORT_ROWS = 5000;

const domainOf = (email: string) => email.slice(email.lastIndexOf('@') + 1).toLowerCase();

export const LEAD_CSV_COLUMNS = [
  'companyName',
  'contactName',
  'email',
  'phone',
  'source',
  'stage',
  'value',
  'currency',
  'nextFollowUpAt',
  'lostReason',
  'notes',
  'ownerEmail',
] as const;

const LeadFields = z.object({
  source: z.enum(LEAD_SOURCES).default('manual'),
  companyName: z.string().trim().min(1).max(200),
  contactName: z.string().trim().min(1).max(200),
  email: Email.nullish(),
  phone: Phone.nullish(),
  stage: LeadStageSchema.default('new'),
  ownerId: z.string().min(1).nullish(),
  value: MoneySchema.nullish(),
  currency: z.string().trim().length(3).toUpperCase().default('USD'),
  nextFollowUpAt: OptionalDate.optional(),
  lostReason: z.string().trim().max(500).nullish(),
  notes: z.string().trim().max(5000).nullish(),
});

const LeadPatch = LeadFields.partial()
  .omit({ source: true })
  .extend({
    source: z.enum(LEAD_SOURCES).optional(),
  });

/** §5.5: a lost reason is required when a lead is marked lost. Won is only reachable via convert. */
function checkStage(stage: LeadStage | undefined, lostReason: string | null | undefined) {
  if (stage === 'won') {
    throw badRequest('use_convert', 'Mark a lead as won by converting it to a client');
  }
  if (stage === 'lost' && !lostReason?.trim()) {
    throw badRequest('lost_reason_required', 'A lost reason is required when marking a lead lost');
  }
}

const ListQuery = Pagination.extend({
  stage: z
    .string()
    .transform((s) => s.split(',').filter(Boolean))
    .pipe(z.array(LeadStageSchema))
    .optional(),
  ownerId: z.string().min(1).optional(), // "me" = current user
  source: z.enum(LEAD_SOURCES).optional(),
  q: z.string().trim().min(1).max(100).optional(),
  followUpBefore: z.string().datetime({ offset: true }).optional(),
});

function leadWhere(req: Request, q: z.infer<typeof ListQuery>): Prisma.LeadWhereInput {
  const auth = requireAuth(req);
  const and: Prisma.LeadWhereInput[] = [];
  if (q.stage?.length) and.push({ stage: { in: q.stage } });
  if (q.ownerId) and.push({ ownerId: q.ownerId === 'me' ? auth.user.id : q.ownerId });
  if (q.source) and.push({ source: q.source });
  if (q.followUpBefore) and.push({ nextFollowUpAt: { lte: new Date(q.followUpBefore) } });
  if (q.q) {
    and.push({
      OR: [
        { companyName: { contains: q.q, mode: 'insensitive' } },
        { contactName: { contains: q.q, mode: 'insensitive' } },
        { email: { contains: q.q, mode: 'insensitive' } },
      ],
    });
  }
  return { AND: and };
}

export function leadsRouter(deps: Deps): Router {
  const { prisma } = deps;
  const r = Router();
  r.use(['/leads', '/pipeline', '/crm'], authenticate(deps), requireInternal);

  /** Staff who can own leads / be assigned tasks (pickers in the CRM UI). Names and emails only. */
  r.get('/crm/staff', requirePermission('crm', 'view'), async (_req, res) => {
    const items = await prisma.user.findMany({
      where: { status: 'active', organization: { type: 'internal' } },
      select: { id: true, name: true, email: true },
      orderBy: { name: 'asc' },
    });
    res.json({ items });
  });

  /** Stage changes and conversions are kept as note activities, so the lead history survives. */
  const historyNote = (
    tx: Prisma.TransactionClient,
    userId: string,
    leadId: string,
    subject: string,
    organizationId?: string,
  ) =>
    tx.activity.create({
      data: {
        type: 'note',
        subject,
        userId,
        leadId,
        organizationId: organizationId ?? null,
        doneAt: new Date(),
      },
    });

  r.get('/leads', requirePermission('crm', 'view'), async (req, res) => {
    const q = parse(ListQuery, req.query);
    const where = leadWhere(req, q);
    const [items, total] = await Promise.all([
      prisma.lead.findMany({
        where,
        include: { owner: ownerSelect },
        orderBy: { updatedAt: 'desc' },
        take: q.limit,
        skip: q.offset,
      }),
      prisma.lead.count({ where }),
    ]);
    res.json({ items: items.map(serializeLead), total });
  });

  r.get('/pipeline/summary', requirePermission('crm', 'view'), async (_req, res) => {
    const groups = await prisma.lead.groupBy({
      by: ['stage'],
      _count: { _all: true },
      _sum: { value: true },
    });
    const byStage = LEAD_STAGES.map((stage) => {
      const g = groups.find((x) => x.stage === stage);
      return { stage, count: g?._count._all ?? 0, value: (g?._sum.value ?? 0).toString() };
    });
    const won = byStage.find((s) => s.stage === 'won')!.count;
    const lost = byStage.find((s) => s.stage === 'lost')!.count;
    const open = byStage.filter((s) => !['won', 'lost'].includes(s.stage));
    res.json({
      byStage,
      openCount: open.reduce((n, s) => n + s.count, 0),
      openValue: open.reduce((n, s) => n + Number(s.value), 0).toFixed(2),
      conversionRate: won + lost === 0 ? null : Number((won / (won + lost)).toFixed(4)),
    });
  });

  r.get('/leads/export', requirePermission('crm', 'export'), async (req, res) => {
    const q = parse(ListQuery.omit({ limit: true, offset: true }), req.query);
    const leads = await prisma.lead.findMany({
      where: leadWhere(req, { ...q, limit: 0, offset: 0 }),
      include: { owner: ownerSelect },
      orderBy: { createdAt: 'asc' },
      take: 50_000,
    });
    const headers = ['id', ...LEAD_CSV_COLUMNS, 'convertedOrgId', 'createdAt'] as const;
    const rows = leads.map((l) => ({
      ...serializeLead(l),
      ownerEmail: l.owner?.email ?? '',
    }));
    await req.audit({
      action: 'crm.leads.export',
      entity: 'Lead',
      metadata: { count: rows.length },
    });
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', 'attachment; filename="leads.csv"');
    res.send(toCsv(headers, rows));
  });

  r.post(
    '/leads/import',
    requirePermission('crm', 'create'),
    express.text({ type: ['text/csv', 'text/plain'], limit: '5mb' }),
    async (req, res) => {
      const auth = requireAuth(req);
      const csv =
        typeof req.body === 'string'
          ? req.body
          : parse(z.object({ csv: z.string() }), req.body).csv;
      let parsed;
      try {
        parsed = parseCsv(csv, LEAD_CSV_COLUMNS);
      } catch {
        throw badRequest('csv_invalid', 'The file is not valid CSV');
      }
      if (!parsed.headers.includes('companyName') || !parsed.headers.includes('contactName')) {
        throw badRequest('csv_columns', 'CSV needs at least companyName and contactName columns');
      }
      if (parsed.rows.length > MAX_IMPORT_ROWS) {
        throw badRequest('csv_too_large', `Import at most ${MAX_IMPORT_ROWS} rows at a time`);
      }

      const owners = new Map(
        (
          await prisma.user.findMany({
            where: { status: 'active', organization: { type: 'internal' } },
            select: { id: true, email: true },
          })
        ).map((u) => [u.email.toLowerCase(), u.id]),
      );

      const errors: { row: number; message: string }[] = [];
      const data: Prisma.LeadCreateManyInput[] = [];
      parsed.rows.forEach((raw, i) => {
        const rowNo = i + 2; // 1-based, after the header
        const blankToNull = (v: string | undefined) => (v === undefined || v === '' ? null : v);
        const result = LeadFields.safeParse({
          companyName: raw.companyName,
          contactName: raw.contactName,
          email: blankToNull(raw.email),
          phone: blankToNull(raw.phone),
          source: raw.source || 'import',
          stage: raw.stage || 'new',
          value: blankToNull(raw.value),
          currency: raw.currency || 'USD',
          nextFollowUpAt: blankToNull(raw.nextFollowUpAt),
          lostReason: blankToNull(raw.lostReason),
          notes: blankToNull(raw.notes),
        });
        if (!result.success) {
          const issue = result.error.issues[0]!;
          errors.push({ row: rowNo, message: `${issue.path.join('.')}: ${issue.message}` });
          return;
        }
        const lead = result.data;
        if (lead.stage === 'won') {
          errors.push({ row: rowNo, message: 'stage: won leads must be converted, not imported' });
          return;
        }
        if (lead.stage === 'lost' && !lead.lostReason) {
          errors.push({ row: rowNo, message: 'lostReason: required when stage is lost' });
          return;
        }
        let ownerId: string | null = null;
        if (raw.ownerEmail) {
          ownerId = owners.get(raw.ownerEmail.toLowerCase()) ?? null;
          if (!ownerId) {
            errors.push({ row: rowNo, message: 'ownerEmail: not an active Datascribe staff user' });
            return;
          }
        }
        data.push({
          ...lead,
          email: lead.email ?? null,
          phone: lead.phone ?? null,
          value: lead.value ?? null,
          nextFollowUpAt: lead.nextFollowUpAt ?? null,
          lostReason: lead.lostReason ?? null,
          notes: lead.notes ?? null,
          ownerId,
        });
      });

      // All-or-nothing: a partial import is harder to fix than a rejected one (D-018).
      if (errors.length) {
        res.status(422).json({
          error: {
            code: 'csv_rows_invalid',
            message: `${errors.length} row(s) need fixing; nothing was imported`,
          },
          errors: errors.slice(0, 100),
        });
        return;
      }
      const created = await prisma.lead.createMany({ data });
      await req.audit({
        action: 'crm.leads.import',
        entity: 'Lead',
        actorId: auth.user.id,
        metadata: { count: created.count },
      });
      res.status(201).json({ created: created.count });
    },
  );

  r.post('/leads', requirePermission('crm', 'create'), async (req, res) => {
    const auth = requireAuth(req);
    const body = parse(LeadFields, req.body);
    checkStage(body.stage, body.lostReason);
    if (body.ownerId) await assertInternalUser(prisma, body.ownerId, 'ownerId');
    const lead = await prisma.lead.create({
      data: {
        ...body,
        ownerId: body.ownerId ?? auth.user.id,
        email: body.email ?? null,
        phone: body.phone ?? null,
        value: body.value ?? null,
        nextFollowUpAt: body.nextFollowUpAt ?? null,
        lostReason: body.stage === 'lost' ? (body.lostReason ?? null) : null,
        notes: body.notes ?? null,
      },
      include: { owner: ownerSelect },
    });
    await req.audit({ action: 'crm.lead.create', entity: 'Lead', entityId: lead.id });
    res.status(201).json(serializeLead(lead));
  });

  r.get('/leads/:id', requirePermission('crm', 'view'), async (req, res) => {
    const lead = await prisma.lead.findUnique({
      where: { id: String(req.params.id) },
      include: {
        owner: ownerSelect,
        contacts: { orderBy: { createdAt: 'asc' } },
        activities: { orderBy: { createdAt: 'desc' }, include: { user: ownerSelect } },
        convertedOrg: { select: { id: true, name: true, status: true } },
      },
    });
    if (!lead) throw notFound();
    res.json({
      ...serializeLead(lead),
      contacts: lead.contacts,
      activities: lead.activities,
      convertedOrg: lead.convertedOrg,
    });
  });

  r.patch('/leads/:id', requirePermission('crm', 'edit'), async (req, res) => {
    const auth = requireAuth(req);
    const body = parse(LeadPatch, req.body);
    const existing = await prisma.lead.findUnique({ where: { id: String(req.params.id) } });
    if (!existing) throw notFound();
    const stageChanging = body.stage !== undefined && body.stage !== existing.stage;
    if (stageChanging && existing.convertedOrgId) {
      throw conflict('lead_converted', 'This lead was converted to a client; its stage is final');
    }
    if (stageChanging) checkStage(body.stage, body.lostReason ?? existing.lostReason);
    if (body.ownerId) await assertInternalUser(prisma, body.ownerId, 'ownerId');

    const nextStage = body.stage ?? existing.stage;
    const lead = await prisma.$transaction(async (tx) => {
      const updated = await tx.lead.update({
        where: { id: existing.id },
        data: {
          ...body,
          // a lost reason only means something while the lead is lost
          lostReason: nextStage === 'lost' ? (body.lostReason ?? existing.lostReason) : null,
        },
        include: { owner: ownerSelect },
      });
      if (stageChanging) {
        await historyNote(
          tx,
          auth.user.id,
          existing.id,
          `Stage changed: ${existing.stage} → ${nextStage}`,
        );
      }
      return updated;
    });
    await req.audit({
      action: 'crm.lead.update',
      entity: 'Lead',
      entityId: lead.id,
      metadata: {
        fields: Object.keys(body),
        ...(stageChanging ? { from: existing.stage, to: nextStage } : {}),
      },
    });
    res.json(serializeLead(lead));
  });

  r.delete('/leads/:id', requirePermission('crm', 'delete'), async (req, res) => {
    const lead = await prisma.lead.findUnique({ where: { id: String(req.params.id) } });
    if (!lead) throw notFound();
    if (lead.convertedOrgId) {
      throw conflict(
        'lead_converted',
        'Converted leads are kept as client history and cannot be deleted',
      );
    }
    await prisma.$transaction([
      prisma.activity.deleteMany({ where: { leadId: lead.id } }),
      prisma.contact.updateMany({ where: { leadId: lead.id }, data: { leadId: null } }),
      prisma.lead.delete({ where: { id: lead.id } }),
    ]);
    await req.audit({ action: 'crm.lead.delete', entity: 'Lead', entityId: lead.id });
    res.status(204).end();
  });

  /**
   * §5.5: convert lead to client: creates the client Organization, invites its first client_admin,
   * marks the lead won and keeps its contacts/activities linked to both lead and new account.
   */
  r.post('/leads/:id/convert', requirePermission('crm', 'edit'), async (req, res) => {
    const auth = requireAuth(req);
    const body = parse(
      z.object({
        organizationName: z.string().trim().min(2).max(200).optional(),
        adminEmail: Email.optional(),
        planId: z.string().min(1).nullish(),
        currency: z.string().trim().length(3).toUpperCase().optional(),
      }),
      req.body ?? {},
    );
    const lead = await prisma.lead.findUnique({ where: { id: String(req.params.id) } });
    if (!lead) throw notFound();
    if (lead.convertedOrgId) throw conflict('lead_converted', 'This lead is already a client');

    const adminEmail = body.adminEmail ?? lead.email;
    if (!adminEmail) {
      throw badRequest(
        'admin_email_required',
        'The lead has no email; provide adminEmail for the client admin',
      );
    }
    if (await prisma.user.findUnique({ where: { email: adminEmail } })) {
      throw conflict('user_exists', 'A user with this email already exists');
    }
    // Audit L10: the firm's first admin should be someone at the firm. A staff-domain address
    // would give a client account that looks like Datascribe staff; another domain than the
    // lead's needs an admin (users:create), not only crm:edit.
    const domain = domainOf(adminEmail);
    if (staffEmailDomains(deps.env).includes(domain)) {
      throw badRequest('admin_email_domain', 'The client admin cannot use a Datascribe address');
    }
    const offDomain = !lead.email || domainOf(lead.email) !== domain;
    if (offDomain && !broadestScope(auth.permissions, 'users', 'create')) {
      throw forbidden(
        "The client admin's email must be on the lead's email domain; ask an admin to convert",
      );
    }
    if (
      body.planId &&
      !(await prisma.subscriptionPlan.findFirst({ where: { id: body.planId, active: true } }))
    ) {
      throw badRequest('unknown_plan', 'Unknown or inactive plan');
    }
    const role = await prisma.role.findUniqueOrThrow({ where: { key: 'client_admin' } });

    const org = await prisma.$transaction(async (tx) => {
      // re-check inside the transaction so two concurrent converts can't both win
      const claimed = await tx.lead.updateMany({
        where: { id: lead.id, convertedOrgId: null },
        data: { stage: 'won', lostReason: null, convertedAt: new Date() },
      });
      if (claimed.count !== 1) throw conflict('lead_converted', 'This lead is already a client');
      const created = await tx.organization.create({
        data: {
          name: body.organizationName ?? lead.companyName,
          type: 'client',
          planId: body.planId ?? null,
          currency: body.currency ?? lead.currency,
        },
      });
      await tx.lead.update({ where: { id: lead.id }, data: { convertedOrgId: created.id } });
      await tx.contact.updateMany({
        where: { leadId: lead.id },
        data: { organizationId: created.id },
      });
      await tx.activity.updateMany({
        where: { leadId: lead.id },
        data: { organizationId: created.id },
      });
      if (!(await tx.contact.findFirst({ where: { leadId: lead.id } }))) {
        await tx.contact.create({
          data: {
            organizationId: created.id,
            leadId: lead.id,
            name: lead.contactName,
            email: adminEmail,
            phone: lead.phone,
          },
        });
      }
      await historyNote(
        tx,
        auth.user.id,
        lead.id,
        `Converted to client: ${created.name}`,
        created.id,
      );
      return created;
    });

    await req.audit({
      action: 'crm.lead.convert',
      entity: 'Lead',
      entityId: lead.id,
      organizationId: org.id,
      metadata: { fromStage: lead.stage, adminEmailOffDomain: offDomain },
    });
    let invite;
    try {
      invite = await issueInvite(deps, req, {
        org,
        role,
        email: adminEmail,
        inviter: { id: auth.user.id, name: auth.user.name },
      });
    } catch (err) {
      // The account exists either way; report the invite problem so sales can resend from admin.
      if (err instanceof HttpError) {
        res.status(201).json({ organization: org, invite: null, inviteError: err.code });
        return;
      }
      throw err;
    }
    res.status(201).json({ organization: org, invite });
  });

  return r;
}
