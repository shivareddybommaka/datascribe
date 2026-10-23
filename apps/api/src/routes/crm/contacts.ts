import type { Prisma, PrismaClient } from '@datascribe/db';
import express, { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireAuth, requirePermission } from '../../auth/middleware';
import type { Deps } from '../../context';
import { parseCsv, toCsv } from '../../lib/csv';
import { badRequest, notFound } from '../../lib/errors';
import { parse } from '../../lib/validate';
import { Email } from '../auth';
import { Pagination, Phone, requireInternal } from './common';

const MAX_IMPORT_ROWS = 5000;
export const CONTACT_CSV_COLUMNS = [
  'name',
  'title',
  'email',
  'phone',
  'accountId',
  'leadId',
] as const;

const ContactFields = z.object({
  name: z.string().trim().min(1).max(200),
  title: z.string().trim().max(200).nullish(),
  email: Email.nullish(),
  phone: Phone.nullish(),
  /** account = client Organization */
  organizationId: z.string().min(1).nullish(),
  leadId: z.string().min(1).nullish(),
});

async function assertLinks(
  prisma: PrismaClient,
  links: { organizationId?: string | null; leadId?: string | null },
) {
  if (links.organizationId) {
    const org = await prisma.organization.findUnique({ where: { id: links.organizationId } });
    if (!org || org.type !== 'client')
      throw badRequest('invalid_account', 'Unknown client account');
  }
  if (links.leadId && !(await prisma.lead.findUnique({ where: { id: links.leadId } }))) {
    throw badRequest('invalid_lead', 'Unknown lead');
  }
}

export function contactsRouter(deps: Deps): Router {
  const { prisma } = deps;
  const r = Router();
  r.use('/contacts', authenticate(deps), requireInternal);

  const ListQuery = Pagination.extend({
    organizationId: z.string().min(1).optional(),
    leadId: z.string().min(1).optional(),
    q: z.string().trim().min(1).max(100).optional(),
  });

  const where = (q: Partial<z.infer<typeof ListQuery>>): Prisma.ContactWhereInput => ({
    AND: [
      q.organizationId ? { organizationId: q.organizationId } : {},
      q.leadId ? { leadId: q.leadId } : {},
      q.q
        ? {
            OR: [
              { name: { contains: q.q, mode: 'insensitive' } },
              { email: { contains: q.q, mode: 'insensitive' } },
            ],
          }
        : {},
    ],
  });

  r.get('/contacts', requirePermission('crm', 'view'), async (req, res) => {
    const q = parse(ListQuery, req.query);
    const [items, total] = await Promise.all([
      prisma.contact.findMany({
        where: where(q),
        include: {
          organization: { select: { id: true, name: true } },
          lead: { select: { id: true, companyName: true } },
        },
        orderBy: { name: 'asc' },
        take: q.limit,
        skip: q.offset,
      }),
      prisma.contact.count({ where: where(q) }),
    ]);
    res.json({ items, total });
  });

  r.get('/contacts/export', requirePermission('crm', 'export'), async (req, res) => {
    const q = parse(ListQuery.omit({ limit: true, offset: true }), req.query);
    const contacts = await prisma.contact.findMany({
      where: where(q),
      orderBy: { createdAt: 'asc' },
      take: 50_000,
    });
    const rows = contacts.map((c) => ({ ...c, accountId: c.organizationId }));
    await req.audit({
      action: 'crm.contacts.export',
      entity: 'Contact',
      metadata: { count: rows.length },
    });
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', 'attachment; filename="contacts.csv"');
    res.send(toCsv(['id', ...CONTACT_CSV_COLUMNS, 'createdAt'], rows));
  });

  r.post(
    '/contacts/import',
    requirePermission('crm', 'create'),
    express.text({ type: ['text/csv', 'text/plain'], limit: '5mb' }),
    async (req, res) => {
      const csv =
        typeof req.body === 'string'
          ? req.body
          : parse(z.object({ csv: z.string() }), req.body).csv;
      let parsed;
      try {
        parsed = parseCsv(csv, CONTACT_CSV_COLUMNS);
      } catch {
        throw badRequest('csv_invalid', 'The file is not valid CSV');
      }
      if (!parsed.headers.includes('name')) {
        throw badRequest('csv_columns', 'CSV needs at least a name column');
      }
      if (parsed.rows.length > MAX_IMPORT_ROWS) {
        throw badRequest('csv_too_large', `Import at most ${MAX_IMPORT_ROWS} rows at a time`);
      }
      const accountIds = new Set(
        (
          await prisma.organization.findMany({ where: { type: 'client' }, select: { id: true } })
        ).map((o) => o.id),
      );
      const leadIds = new Set(
        (await prisma.lead.findMany({ select: { id: true } })).map((l) => l.id),
      );

      const errors: { row: number; message: string }[] = [];
      const data: Prisma.ContactCreateManyInput[] = [];
      parsed.rows.forEach((raw, i) => {
        const rowNo = i + 2;
        const blank = (v: string | undefined) => (v ? v : null);
        const result = ContactFields.safeParse({
          name: raw.name,
          title: blank(raw.title),
          email: blank(raw.email),
          phone: blank(raw.phone),
          organizationId: blank(raw.accountId),
          leadId: blank(raw.leadId),
        });
        if (!result.success) {
          const issue = result.error.issues[0]!;
          errors.push({ row: rowNo, message: `${issue.path.join('.')}: ${issue.message}` });
          return;
        }
        const c = result.data;
        if (c.organizationId && !accountIds.has(c.organizationId)) {
          errors.push({ row: rowNo, message: 'accountId: unknown client account' });
          return;
        }
        if (c.leadId && !leadIds.has(c.leadId)) {
          errors.push({ row: rowNo, message: 'leadId: unknown lead' });
          return;
        }
        data.push({
          name: c.name,
          title: c.title ?? null,
          email: c.email ?? null,
          phone: c.phone ?? null,
          organizationId: c.organizationId ?? null,
          leadId: c.leadId ?? null,
        });
      });
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
      const created = await prisma.contact.createMany({ data });
      await req.audit({
        action: 'crm.contacts.import',
        entity: 'Contact',
        actorId: requireAuth(req).user.id,
        metadata: { count: created.count },
      });
      res.status(201).json({ created: created.count });
    },
  );

  r.post('/contacts', requirePermission('crm', 'create'), async (req, res) => {
    const body = parse(ContactFields, req.body);
    await assertLinks(prisma, body);
    const contact = await prisma.contact.create({
      data: {
        name: body.name,
        title: body.title ?? null,
        email: body.email ?? null,
        phone: body.phone ?? null,
        organizationId: body.organizationId ?? null,
        leadId: body.leadId ?? null,
      },
    });
    await req.audit({ action: 'crm.contact.create', entity: 'Contact', entityId: contact.id });
    res.status(201).json(contact);
  });

  r.patch('/contacts/:id', requirePermission('crm', 'edit'), async (req, res) => {
    const body = parse(ContactFields.partial(), req.body);
    const existing = await prisma.contact.findUnique({ where: { id: String(req.params.id) } });
    if (!existing) throw notFound();
    await assertLinks(prisma, body);
    const contact = await prisma.contact.update({ where: { id: existing.id }, data: body });
    await req.audit({
      action: 'crm.contact.update',
      entity: 'Contact',
      entityId: contact.id,
      metadata: { fields: Object.keys(body) },
    });
    res.json(contact);
  });

  r.delete('/contacts/:id', requirePermission('crm', 'delete'), async (req, res) => {
    const existing = await prisma.contact.findUnique({ where: { id: String(req.params.id) } });
    if (!existing) throw notFound();
    await prisma.contact.delete({ where: { id: existing.id } });
    await req.audit({ action: 'crm.contact.delete', entity: 'Contact', entityId: existing.id });
    res.status(204).end();
  });

  return r;
}
