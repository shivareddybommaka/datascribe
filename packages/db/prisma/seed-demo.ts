/**
 * `pnpm db:seed:demo` — SYNTHETIC CRM demo data for looking around the console (dev only).
 * Idempotent: leads are keyed by company name and skipped if they already exist.
 */
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { PrismaClient, type LeadStage } from '../generated/client/index.js';

config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });
if (process.env.NODE_ENV === 'production') process.exit(1);
const dbPort =
  new URL(process.env.DATABASE_URL ?? 'postgresql://x@localhost:5433/x').port || '5432';
if (dbPort === '5432') {
  console.error('Refusing to seed a database on port 5432. Datascribe uses 5433.');
  process.exit(1);
}

const prisma = new PrismaClient();
const day = 86_400_000;

const LEADS: {
  company: string;
  contact: string;
  stage: LeadStage;
  value: number;
  source: string;
  owner: string;
  followUpDays?: number;
  lostReason?: string;
}[] = [
  {
    company: 'Northgate Injury Lawyers (synthetic)',
    contact: 'Alex Rivera',
    stage: 'new',
    value: 18000,
    source: 'website_demo',
    owner: 'sales',
    followUpDays: 1,
  },
  {
    company: 'Bayside Med-Mal Partners (synthetic)',
    contact: 'Priya Natarajan',
    stage: 'new',
    value: 9500,
    source: 'website_contact',
    owner: 'sales',
  },
  {
    company: 'Summit Workers Comp Group (synthetic)',
    contact: 'Jordan Lee',
    stage: 'contacted',
    value: 12000,
    source: 'referral',
    owner: 'sales',
    followUpDays: 0,
  },
  {
    company: 'Redwood Trial Attorneys (synthetic)',
    contact: 'Morgan Chen',
    stage: 'contacted',
    value: 24000,
    source: 'event',
    owner: 'ops_manager',
    followUpDays: 3,
  },
  {
    company: 'Lakeshore Legal (synthetic)',
    contact: 'Sam Okafor',
    stage: 'qualified',
    value: 30000,
    source: 'manual',
    owner: 'sales',
    followUpDays: 2,
  },
  {
    company: 'Granite State PI Firm (synthetic)',
    contact: 'Taylor Brooks',
    stage: 'qualified',
    value: 15500,
    source: 'website_demo',
    owner: 'sales',
  },
  {
    company: 'Meridian Health Law (synthetic)',
    contact: 'Casey Patel',
    stage: 'proposal',
    value: 42000,
    source: 'referral',
    owner: 'sales',
    followUpDays: -1,
  },
  {
    company: 'Pacific Claims Counsel (synthetic)',
    contact: 'Riley Kim',
    stage: 'proposal',
    value: 21000,
    source: 'manual',
    owner: 'ops_manager',
    followUpDays: 5,
  },
  {
    company: 'Old Mill Law Office (synthetic)',
    contact: 'Drew Santos',
    stage: 'lost',
    value: 8000,
    source: 'import',
    owner: 'sales',
    lostReason: 'Chose an in-house paralegal team',
  },
];

async function main() {
  const users = new Map(
    (await prisma.user.findMany({ where: { organization: { type: 'internal' } } })).map((u) => [
      u.email.split('@')[0]!.replace('.', '_'),
      u.id,
    ]),
  );
  const salesId = users.get('sales')!;
  let created = 0;
  for (const l of LEADS) {
    if (await prisma.lead.findFirst({ where: { companyName: l.company } })) continue;
    const slug = l.company.split(' ')[0]!.toLowerCase();
    const lead = await prisma.lead.create({
      data: {
        source: l.source,
        companyName: l.company,
        contactName: l.contact,
        email: `${l.contact.split(' ')[0]!.toLowerCase()}@${slug}.example`,
        stage: l.stage,
        value: l.value.toFixed(2),
        ownerId: users.get(l.owner) ?? salesId,
        nextFollowUpAt:
          l.followUpDays === undefined ? null : new Date(Date.now() + l.followUpDays * day),
        lostReason: l.lostReason ?? null,
        notes: 'Synthetic demo lead.',
        contacts: {
          create: {
            name: l.contact,
            title: 'Managing Partner',
            email: `${l.contact.split(' ')[0]!.toLowerCase()}@${slug}.example`,
          },
        },
      },
    });
    await prisma.activity.create({
      data: {
        type: 'call',
        subject: `Intro call with ${l.contact}`,
        userId: lead.ownerId!,
        leadId: lead.id,
        doneAt: new Date(Date.now() - 2 * day),
      },
    });
    if (l.followUpDays !== undefined) {
      await prisma.activity.create({
        data: {
          type: 'task',
          subject: `Follow up with ${l.company.replace(' (synthetic)', '')}`,
          userId: lead.ownerId!,
          leadId: lead.id,
          dueAt: new Date(Date.now() + l.followUpDays * day),
        },
      });
    }
    created += 1;
  }
  console.log(
    `Demo CRM data: ${created} leads created (${LEADS.length - created} already present).`,
  );
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : 'Demo seed failed');
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
