import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { PassThrough, type Readable } from 'node:stream';
import { errorInfo, type Document, type Prisma, type PrismaClient } from '@datascribe/db';
import { notifyUploadScanned } from '@datascribe/db/notifications';
import { countPages } from './pages';
import type { VirusScanner } from './scanner';

/** Files up to this size are also read into memory to count pages; larger ones keep it null. */
const PAGE_COUNT_MAX_BYTES = 150 * 1024 * 1024;

export const quarantineKey = (key: string) => `quarantine/${key}`;

/** The two object operations a scan needs (API: S3DocumentStorage, worker: its own S3 client). */
export interface ScanStorage {
  stream(key: string): Promise<Readable>;
  move(from: string, to: string): Promise<void>;
}

export interface VerifyDeps {
  prisma: PrismaClient;
  storage: ScanStorage;
  scanner: VirusScanner;
  logger: { error(obj: object, msg: string): void };
}

const running = new Set<string>();

/**
 * Pipeline stage 1 (§5.3, §7): SHA-256, page count and a virus scan in a single pass over the
 * object. Clean → downloadable and processed. Infected → moved under `quarantine/`, never
 * downloadable. Scanner failure → `error` (fails closed; nothing can download or process it).
 * Runs in the worker (D-081); the API calls it inline only in its tests.
 */
export async function verifyDocument(
  deps: VerifyDeps,
  documentId: string,
): Promise<Document | null> {
  const { prisma, storage, scanner, logger } = deps;
  if (running.has(documentId)) return null;
  running.add(documentId);
  try {
    const doc = await prisma.document.findUnique({ where: { id: documentId } });
    if (!doc || !doc.uploadedAt || doc.scanStatus !== 'pending') return doc;

    let outcome: { sha256: string; pageCount: number | null; clean: boolean; signature?: string };
    try {
      const source = await storage.stream(doc.s3Key);
      const toScanner = new PassThrough();
      let scanSettled = false;
      const scan = scanner.scan(toScanner).finally(() => {
        scanSettled = true;
      });
      // handled below with `await scan`; this keeps an early failure from being "unhandled"
      scan.catch(() => undefined);
      const hash = createHash('sha256');
      const keep = Number(doc.sizeBytes) <= PAGE_COUNT_MAX_BYTES;
      const chunks: Buffer[] = [];
      for await (const chunk of source as AsyncIterable<Buffer>) {
        hash.update(chunk);
        if (keep) chunks.push(chunk);
        if (scanSettled) continue; // scanner gave up early: finish hashing, its error wins below
        if (!toScanner.write(chunk)) {
          await Promise.race([
            once(toScanner, 'drain'),
            scan.then(
              () => undefined,
              () => undefined,
            ),
          ]);
        }
      }
      toScanner.end();
      const result = await scan;
      outcome = {
        sha256: hash.digest('hex'),
        pageCount: keep ? await countPages(doc.mimeType, Buffer.concat(chunks)) : null,
        clean: result.clean,
        signature: result.signature,
      };
    } catch (err) {
      logger.error({ err: errorInfo(err), documentId }, 'document scan failed');
      const updated = await prisma.document.update({
        where: { id: doc.id },
        data: { scanStatus: 'error' },
      });
      await systemAudit(prisma, doc, 'document.scan', { result: 'error', scanner: scanner.name });
      await safeNotify(logger, doc.id, 'error', prisma);
      return updated;
    }

    let data: Prisma.DocumentUpdateInput = {
      sha256: outcome.sha256,
      pageCount: outcome.pageCount,
      scanStatus: outcome.clean ? 'clean' : 'infected',
    };
    if (!outcome.clean) {
      const qKey = quarantineKey(doc.s3Key);
      await storage.move(doc.s3Key, qKey);
      data = { ...data, s3Key: qKey };
    }
    const updated = await prisma.document.update({ where: { id: doc.id }, data });
    await systemAudit(prisma, doc, 'document.scan', {
      result: outcome.clean ? 'clean' : 'infected',
      scanner: scanner.name,
      ...(outcome.signature ? { signature: outcome.signature } : {}),
      pageCount: outcome.pageCount,
    });
    await safeNotify(logger, doc.id, outcome.clean ? 'clean' : 'infected', prisma);
    return updated;
  } finally {
    running.delete(documentId);
  }
}

/** Tell the uploader and staff; a failed dispatch is logged and never undoes the scan (D-090). */
async function safeNotify(
  logger: VerifyDeps['logger'],
  documentId: string,
  result: 'clean' | 'infected' | 'error',
  prisma: PrismaClient,
): Promise<void> {
  try {
    await notifyUploadScanned(prisma, documentId, result);
  } catch (err) {
    logger.error(
      { event: `upload_${result}`, err: { name: (err as Error).name } },
      'notification dispatch failed',
    );
  }
}

/** Audit row written by the system (no actor), e.g. scan results. */
async function systemAudit(
  prisma: PrismaClient,
  doc: Pick<Document, 'id' | 'organizationId' | 'caseId'>,
  action: string,
  metadata: Record<string, unknown>,
) {
  await prisma.auditLog.create({
    data: {
      action,
      entity: 'Document',
      entityId: doc.id,
      organizationId: doc.organizationId,
      metadata: { caseId: doc.caseId, ...metadata } as Prisma.InputJsonValue,
    },
  });
}
