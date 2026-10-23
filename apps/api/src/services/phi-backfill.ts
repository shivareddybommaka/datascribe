import type { PrismaClient } from '@datascribe/db';
import { encrypt, isEnvelope } from '@datascribe/shared';

const CONSTRAINTS = [
  ['Case', 'Case_patientName_encrypted'],
  ['Case', 'Case_notes_encrypted'],
  ['Message', 'Message_body_encrypted'],
] as const;

/**
 * Audit L5 backfill: encrypt Case.notes / Message.body rows written in plaintext before M4, then
 * validate the CHECK constraints added by the 20261024090000 migration. Idempotent and cheap when
 * there is nothing left to do, so the API runs it at every startup.
 */
export async function encryptLegacyPhi(prisma: PrismaClient, key: Buffer) {
  let cases = 0;
  let messages = 0;
  const legacyCases = await prisma.case.findMany({
    where: { notes: { not: null } },
    select: { id: true, notes: true },
  });
  for (const c of legacyCases) {
    if (c.notes && !isEnvelope(c.notes)) {
      await prisma.case.update({ where: { id: c.id }, data: { notes: encrypt(c.notes, key) } });
      cases += 1;
    }
  }
  const legacyMessages = await prisma.message.findMany({
    where: { NOT: { body: { startsWith: 'v1:' } } },
    select: { id: true, body: true },
  });
  for (const m of legacyMessages) {
    if (!isEnvelope(m.body)) {
      await prisma.message.update({ where: { id: m.id }, data: { body: encrypt(m.body, key) } });
      messages += 1;
    }
  }

  const pending = await prisma.$queryRaw<{ table: string; name: string }[]>`
    SELECT rel.relname AS "table", con.conname AS "name"
    FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
    WHERE con.contype = 'c' AND NOT con.convalidated`;
  let validated = 0;
  for (const [table, name] of CONSTRAINTS) {
    if (pending.some((p) => p.table === table && p.name === name)) {
      // identifiers come from the constant list above, never from input
      await prisma.$executeRawUnsafe(`ALTER TABLE "${table}" VALIDATE CONSTRAINT "${name}"`);
      validated += 1;
    }
  }
  return { cases, messages, validated };
}
