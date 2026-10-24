/**
 * Reads what the worker's pipeline stored for a case, for the M5 DoD e2e (apps/web resolves no
 * Prisma client of its own). Decrypts deliverables with the e2e PHI key; synthetic data only.
 */
import { PrismaClient } from '@datascribe/db';
import { decrypt } from '@datascribe/shared';

export interface Citation {
  documentId: string;
  fileName: string;
  pageNumber: number;
}

export async function pipelineResult(dbUrl: string, phiKey: Buffer, caseId: string) {
  const prisma = new PrismaClient({ datasourceUrl: dbUrl });
  try {
    const [jobs, deliverables, pages, notices] = await Promise.all([
      prisma.processingJob.findMany({
        where: { caseId },
        orderBy: { createdAt: 'asc' },
        select: { stage: true, status: true },
      }),
      prisma.deliverable.findMany({ where: { caseId }, select: { type: true, content: true } }),
      prisma.documentPage.findMany({
        where: { document: { caseId } },
        select: { pageNumber: true, recordType: true, text: true },
      }),
      prisma.notification.findMany({
        where: { payload: { path: ['caseId'], equals: caseId } },
        select: { type: true },
      }),
    ]);
    const content = Object.fromEntries(
      deliverables.map((d) => [d.type, JSON.parse(decrypt(d.content, phiKey)) as unknown]),
    );
    return {
      jobs,
      noticeTypes: notices.map((n) => n.type),
      types: deliverables.map((d) => d.type).sort(),
      chronology: content.chronology as { entries: { date: string | null; citation: Citation }[] },
      index: content.index as { rows: unknown[] },
      summary: content.summary as { kind: string } | undefined,
      pages: pages.map((p) => ({
        pageNumber: p.pageNumber,
        recordType: p.recordType,
        encrypted: !!p.text && /^v[0-9]+:/.test(p.text),
      })),
    };
  } finally {
    await prisma.$disconnect();
  }
}
