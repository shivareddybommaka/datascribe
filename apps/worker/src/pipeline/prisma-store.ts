/** Prisma-backed PipelineStore. Values arrive already encrypted from the runner. */
import type { DeliverableType, PrismaClient, ProcessingStage } from '@datascribe/db';
import type { PipelineQueue } from '../queues';
import type { EventCode } from './code-events';
import type { CaseState, PipelineStore } from './runner';

const toStage = (q: PipelineQueue) => q.replace(/-/g, '_') as ProcessingStage;
const isoDate = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

export function prismaPipelineStore(prisma: PrismaClient): PipelineStore {
  return {
    async getCase(caseId) {
      const c = await prisma.case.findUnique({
        where: { id: caseId },
        select: {
          id: true,
          number: true,
          matterName: true,
          reference: true,
          patientName: true,
          status: true,
          requested: true,
        },
      });
      return c ? { ...c, status: c.status as CaseState } : null;
    },

    listDocuments(caseId) {
      return prisma.document.findMany({
        where: { caseId, uploadedAt: { not: null }, scanStatus: 'clean' },
        orderBy: [{ uploadedAt: 'asc' }, { id: 'asc' }],
        select: { id: true, fileName: true, mimeType: true, s3Key: true, pageCount: true },
      });
    },

    async startJob(caseId, stage, attempt) {
      const job = await prisma.processingJob.create({
        data: {
          caseId,
          stage: toStage(stage),
          status: 'running',
          attempts: attempt,
          startedAt: new Date(),
        },
      });
      return job.id;
    },

    async finishJob(jobId, outcome) {
      await prisma.processingJob.update({
        where: { id: jobId },
        data: outcome.ok
          ? { status: 'succeeded', finishedAt: new Date() }
          : { status: 'failed', error: outcome.error, finishedAt: new Date() },
      });
    },

    async savePages(documentId, pages) {
      await prisma.$transaction([
        prisma.documentPage.deleteMany({ where: { documentId } }),
        prisma.documentPage.createMany({
          data: pages.map((p) => ({
            documentId,
            pageNumber: p.pageNumber,
            text: p.text,
            ocrConfidence: p.ocrConfidence,
          })),
        }),
        prisma.document.update({ where: { id: documentId }, data: { pageCount: pages.length } }),
      ]);
    },

    listPages(caseId) {
      return prisma.documentPage.findMany({
        where: { document: { caseId, scanStatus: 'clean' } },
        orderBy: [{ documentId: 'asc' }, { pageNumber: 'asc' }],
        select: { documentId: true, pageNumber: true, text: true, recordType: true },
      });
    },

    async setRecordTypes(updates) {
      await prisma.$transaction(
        updates.map((u) =>
          prisma.documentPage.update({
            where: {
              documentId_pageNumber: { documentId: u.documentId, pageNumber: u.pageNumber },
            },
            data: { recordType: u.recordType },
          }),
        ),
      );
    },

    async replaceEvents(caseId, events) {
      await prisma.$transaction([
        prisma.clinicalEvent.deleteMany({ where: { caseId } }),
        prisma.clinicalEvent.createMany({
          data: events.map((e) => ({
            caseId,
            documentId: e.documentId,
            pageNumber: e.pageNumber,
            eventDate: e.eventDate ? new Date(`${e.eventDate}T00:00:00Z`) : null,
            provider: e.provider,
            facility: e.facility,
            eventType: e.eventType,
            description: e.description,
          })),
        }),
      ]);
    },

    async listEvents(caseId) {
      const rows = await prisma.clinicalEvent.findMany({
        where: { caseId },
        orderBy: [{ documentId: 'asc' }, { pageNumber: 'asc' }],
      });
      return rows.map((e) => ({
        id: e.id,
        documentId: e.documentId,
        pageNumber: e.pageNumber,
        eventDate: isoDate(e.eventDate),
        provider: e.provider,
        facility: e.facility,
        eventType: e.eventType,
        description: e.description,
        codes: (Array.isArray(e.codes) ? e.codes : []) as unknown as EventCode[],
      }));
    },

    async setEventCodes(updates) {
      await prisma.$transaction(
        updates.map((u) =>
          prisma.clinicalEvent.update({
            where: { id: u.id },
            data: { codes: u.codes as unknown as object[] },
          }),
        ),
      );
    },

    async saveDeliverables(caseId, items) {
      await prisma.$transaction(async (tx) => {
        for (const item of items) {
          const type = item.type as DeliverableType;
          const latest = await tx.deliverable.findFirst({
            where: { caseId, type },
            orderBy: { version: 'desc' },
          });
          if (latest?.status === 'draft' && !latest.lockedAt) {
            await tx.deliverable.update({
              where: { id: latest.id },
              data: { content: item.content },
            });
          } else {
            await tx.deliverable.create({
              data: { caseId, type, version: (latest?.version ?? 0) + 1, content: item.content },
            });
          }
        }
      });
    },

    async transitionCase(caseId, from, to) {
      const r = await prisma.case.updateMany({
        where: { id: caseId, status: { in: [...from] } },
        data: { status: to },
      });
      return r.count === 1;
    },
  };
}
