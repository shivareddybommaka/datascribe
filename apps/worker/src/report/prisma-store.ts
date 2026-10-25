/** Prisma-backed DeliveryStore (D-098). */
import { recordUsage } from '@datascribe/billing';
import type { DeliverableType, PrismaClient } from '@datascribe/db';
import type { DeliveryStore } from './deliver';

const TYPES: DeliverableType[] = ['index', 'chronology', 'summary'];

export function prismaDeliveryStore(prisma: PrismaClient): DeliveryStore {
  return {
    async getCase(caseId) {
      const c = await prisma.case.findUnique({
        where: { id: caseId },
        include: { organization: { select: { name: true } } },
      });
      return c
        ? {
            id: c.id,
            number: c.number,
            organizationId: c.organizationId,
            firmName: c.organization.name,
            matterName: c.matterName,
            reference: c.reference,
            patientName: c.patientName,
            incidentDate: c.incidentDate,
            caseType: c.caseType,
            status: c.status,
            requested: c.requested,
          }
        : null;
    },

    async lockedDeliverables(caseId) {
      const out = [];
      for (const type of TYPES) {
        const d = await prisma.deliverable.findFirst({
          where: { caseId, type },
          orderBy: { version: 'desc' },
        });
        if (d && d.status === 'approved' && d.lockedAt) {
          out.push({
            id: d.id,
            type: d.type,
            version: d.version,
            content: d.content,
            lockedAt: d.lockedAt,
          });
        }
      }
      return out;
    },

    async pagesProcessed(caseId) {
      const r = await prisma.document.aggregate({
        where: { caseId, scanStatus: 'clean', uploadedAt: { not: null } },
        _sum: { pageCount: true },
      });
      return r._sum.pageCount ?? 0;
    },

    async recordUsage(input) {
      await recordUsage(prisma, input);
    },

    async markDelivered({ caseId, organizationId, deliverableIds, pdfS3Key, at }) {
      return prisma.$transaction(async (tx) => {
        const moved = await tx.case.updateMany({
          where: { id: caseId, status: 'approved' },
          data: { status: 'delivered', deliveredAt: at },
        });
        if (moved.count !== 1) return false;
        await tx.deliverable.updateMany({
          where: { id: { in: deliverableIds }, status: 'approved' },
          data: { status: 'delivered', pdfS3Key },
        });
        // status timeline row (D-073); no actor: the system delivered it
        await tx.auditLog.create({
          data: {
            action: 'case.status',
            entity: 'Case',
            entityId: caseId,
            organizationId,
            metadata: { from: 'approved', to: 'delivered', by: 'delivery' },
          },
        });
        return true;
      });
    },
  };
}
