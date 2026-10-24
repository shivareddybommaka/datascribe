/** Prisma-backed PipelineStore. Values arrive already encrypted from the runner. */
import type { DeliverableType, PrismaClient, ProcessingStage } from '@datascribe/db';
import type { PipelineQueue } from '../queues';
import type { EventCode } from './code-events';
import type { DispatchSource } from './dispatch';
import type { CaseState, PipelineStore } from './runner';

const toStage = (q: PipelineQueue) => q.replace(/-/g, '_') as ProcessingStage;
const isoDate = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

export function prismaDispatchSource(prisma: PrismaClient): DispatchSource {
  return {
    pendingUploads(limit) {
      return prisma.document.findMany({
        where: { uploadedAt: { not: null }, scanStatus: 'pending' },
        orderBy: { uploadedAt: 'asc' },
        take: limit,
        select: { id: true },
      });
    },
    submittedCases(limit) {
      return prisma.case.findMany({
        where: { status: 'submitted' },
        orderBy: { updatedAt: 'asc' },
        take: limit,
        select: { id: true, updatedAt: true },
      });
    },
  };
}

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
        // purged by retention (D-128): no object left to read
        where: { caseId, uploadedAt: { not: null }, scanStatus: 'clean', purgedAt: null },
        orderBy: [{ uploadedAt: 'asc' }, { id: 'asc' }],
        select: { id: true, fileName: true, mimeType: true, s3Key: true, pageCount: true },
      });
    },

    async listUnscanned(caseId) {
      const rows = await prisma.document.findMany({
        where: { caseId, uploadedAt: { not: null }, scanStatus: 'pending' },
        orderBy: [{ uploadedAt: 'asc' }, { id: 'asc' }],
        select: { id: true },
      });
      return rows.map((r) => r.id);
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
          // a staff edit (D-086) is never overwritten: reprocessing then adds a version on top
          if (latest?.status === 'draft' && !latest.lockedAt && !latest.editedById) {
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
      return prisma.$transaction(async (tx) => {
        const c = await tx.case.findUnique({
          where: { id: caseId },
          select: { status: true, organizationId: true },
        });
        if (!c || !from.includes(c.status as CaseState)) return false;
        const r = await tx.case.updateMany({
          where: { id: caseId, status: c.status },
          data: { status: to },
        });
        if (r.count !== 1) return false;
        // the case's status timeline is built from these rows (D-073); no actor: the system did it
        await tx.auditLog.create({
          data: {
            action: 'case.status',
            entity: 'Case',
            entityId: caseId,
            organizationId: c.organizationId,
            metadata: { from: c.status, to, by: 'pipeline' },
          },
        });
        return true;
      });
    },
  };
}
