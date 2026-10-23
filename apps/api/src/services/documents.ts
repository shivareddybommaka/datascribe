import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import type { Document, Prisma, PrismaClient } from '@datascribe/db';
import { notifyUploadScanned } from '@datascribe/db/notifications';
import { PDFDocument } from 'pdf-lib';
import type { Logger } from 'pino';
import { tiffPageCount, type UploadMime } from '../lib/filetype';
import { safeNotify } from '../lib/notify';
import type { VirusScanner } from '../lib/scanner';
import type { DocumentStorage } from '../lib/storage';

/** S3 allows at most 10,000 parts per upload. */
const MAX_PARTS = 10_000;

/** Files up to this size are also read into memory to count pages; larger ones wait for M5. */
const PAGE_COUNT_MAX_BYTES = 150 * 1024 * 1024;

export function partSizeFor(sizeBytes: number, minPartBytes: number): number {
  let part = minPartBytes;
  while (Math.ceil(sizeBytes / part) > MAX_PARTS) part *= 2;
  return part;
}

export const partCountFor = (sizeBytes: number, partSize: number) =>
  Math.max(1, Math.ceil(sizeBytes / partSize));

/** Object keys hold ids only: file names can contain patient names (PHI). */
export const documentKey = (organizationId: string, caseId: string) =>
  `org/${organizationId}/cases/${caseId}/${randomUUID()}`;

export const quarantineKey = (key: string) => `quarantine/${key}`;

export async function countPages(mime: UploadMime, bytes: Uint8Array): Promise<number | null> {
  try {
    if (mime === 'application/pdf') {
      const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
      return pdf.getPageCount();
    }
    if (mime === 'image/tiff') return tiffPageCount(bytes);
    return 1;
  } catch {
    // unreadable structure: the pipeline (M5) decides; never fail the upload on page counting
    return null;
  }
}

export interface VerifyDeps {
  prisma: PrismaClient;
  storage: DocumentStorage;
  scanner: VirusScanner;
  logger: Logger;
}

const running = new Set<string>();

/**
 * Post-upload checks (§5.3, §7 stage 1): SHA-256, page count and a virus scan in a single pass over
 * the object. Clean → downloadable. Infected → moved under `quarantine/` and never downloadable.
 * Scanner failure → `error` (fails closed; nothing can download it). The M5b worker takes this
 * over as the pipeline's scan stage; until then the API runs it after each completed upload and
 * re-runs anything left pending at startup.
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
        pageCount: keep
          ? await countPages(doc.mimeType as UploadMime, Buffer.concat(chunks))
          : null,
        clean: result.clean,
        signature: result.signature,
      };
    } catch (err) {
      const e = err as Error;
      logger.error(
        { err: { name: e.name, message: e.message }, documentId },
        'document scan failed',
      );
      const updated = await prisma.document.update({
        where: { id: doc.id },
        data: { scanStatus: 'error' },
      });
      await systemAudit(prisma, doc, 'document.scan', { result: 'error', scanner: scanner.name });
      await safeNotify(logger, 'upload_scan_failed', () =>
        notifyUploadScanned(prisma, doc.id, 'error'),
      );
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
    const result = outcome.clean ? 'clean' : 'infected';
    await safeNotify(logger, `upload_${result}`, () => notifyUploadScanned(prisma, doc.id, result));
    return updated;
  } finally {
    running.delete(documentId);
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

/** Startup: re-run checks interrupted by a restart (completed uploads still pending). */
export async function resumePendingVerifications(deps: VerifyDeps) {
  const pending = await deps.prisma.document.findMany({
    where: { scanStatus: 'pending', uploadedAt: { not: null } },
    select: { id: true },
  });
  for (const d of pending) await verifyDocument(deps, d.id);
  return pending.length;
}
