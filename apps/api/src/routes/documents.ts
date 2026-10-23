import type { Prisma } from '@datascribe/db';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { authenticate, requireAuth, requirePermission } from '../auth/middleware';
import { canOnCase, caseScopeWhere } from '../auth/scoping';
import type { Env } from '../config/env';
import type { Deps } from '../context';
import { HttpError, conflict, notFound } from '../lib/errors';
import {
  MAX_UPLOAD_BYTES,
  SNIFF_BYTES,
  UPLOAD_MIMES,
  cleanFileName,
  detectFileType,
} from '../lib/filetype';
import { parse } from '../lib/validate';
import { UPLOADABLE_STATUSES } from '../services/cases';
import { documentKey, partCountFor, partSizeFor, verifyDocument } from '../services/documents';

/** §2: signed download URLs live 5 minutes. Part URLs get longer: a slow link uploads 8 MiB. */
export const DOWNLOAD_URL_TTL_S = 5 * 60;
export const PART_URL_TTL_S = 30 * 60;

const docInclude = {
  uploadedBy: { select: { id: true, name: true } },
} satisfies Prisma.DocumentInclude;

type DocRow = Prisma.DocumentGetPayload<{ include: typeof docInclude }>;

export function serializeDocument(d: DocRow, env: Pick<Env, 'UPLOAD_PART_SIZE_MB'>) {
  const size = Number(d.sizeBytes);
  const partSize = partSizeFor(size, env.UPLOAD_PART_SIZE_MB * 1024 * 1024);
  return {
    id: d.id,
    caseId: d.caseId,
    fileName: d.fileName,
    mimeType: d.mimeType,
    sizeBytes: size,
    pageCount: d.pageCount,
    sha256: d.sha256,
    scanStatus: d.scanStatus,
    /** uploading → (pending scan) → clean | infected | error */
    state: d.uploadedAt ? d.scanStatus : 'uploading',
    uploadedAt: d.uploadedAt,
    createdAt: d.createdAt,
    uploadedBy: d.uploadedBy,
    partSize,
    partCount: partCountFor(size, partSize),
  };
}

const NewUpload = z.object({
  fileName: z.string().min(1).max(500),
  mimeType: z.enum(UPLOAD_MIMES, {
    errorMap: () => ({ message: 'Upload PDF, PNG, JPEG or TIFF files' }),
  }),
  sizeBytes: z
    .number()
    .int()
    .min(1, 'The file is empty')
    .max(MAX_UPLOAD_BYTES, 'Files can be up to 500 MB'),
});

/**
 * §9 documents: resumable S3 multipart uploads straight from the browser, then server-side checks
 * (size, magic bytes, SHA-256, page count, virus scan) before a document can be downloaded.
 * Access follows the parent case (D-006): documents:<action> scoped through caseScopeWhere.
 * Every create, view, download, edit and delete writes an AuditLog row (§4.4). Audit metadata
 * never includes file names, which may contain patient names.
 */
export function documentsRouter(deps: Deps): Router {
  const { prisma, storage, env } = deps;
  const r = Router();
  r.use(['/uploads', '/documents'], authenticate(deps));

  async function loadCaseFor(req: Request, action: 'create' | 'view') {
    const auth = requireAuth(req);
    const c = await prisma.case.findFirst({
      where: { AND: [{ id: String(req.params.id) }, caseScopeWhere(auth, 'documents', action)] },
      include: { shares: { select: { userId: true } } },
    });
    if (!c || !canOnCase(auth, action, 'documents', c)) throw notFound();
    return c;
  }

  async function loadDocument(req: Request, action: 'view' | 'create' | 'edit' | 'delete') {
    const auth = requireAuth(req);
    const doc = await prisma.document.findFirst({
      where: { id: String(req.params.id), case: { is: caseScopeWhere(auth, 'documents', action) } },
      include: { ...docInclude, case: { include: { shares: { select: { userId: true } } } } },
    });
    if (!doc || !canOnCase(auth, action, 'documents', doc.case)) throw notFound();
    return doc;
  }

  const assertUploadable = (status: string) => {
    if (!(UPLOADABLE_STATUSES as readonly string[]).includes(status)) {
      throw conflict('case_locked', 'Records can no longer be changed on this case');
    }
  };

  const audit = (
    req: Request,
    action: string,
    doc: { id: string; organizationId: string; caseId: string },
    metadata: Record<string, unknown> = {},
  ) =>
    req.audit({
      action,
      entity: 'Document',
      entityId: doc.id,
      organizationId: doc.organizationId,
      metadata: { caseId: doc.caseId, ...metadata },
    });

  async function uploadState(doc: DocRow) {
    const base = serializeDocument(doc, env);
    if (doc.uploadedAt || !doc.uploadId) {
      return { ...base, uploadedParts: [] as number[], completed: !!doc.uploadedAt };
    }
    const parts = await storage.listParts(doc.s3Key, doc.uploadId);
    return { ...base, uploadedParts: parts.map((p) => p.partNumber), completed: false };
  }

  // ── Start a multipart upload ──────────────────────────────────────────
  r.post(
    '/cases/:id/uploads',
    authenticate(deps),
    requirePermission('documents', 'create'),
    async (req, res) => {
      const auth = requireAuth(req);
      const body = parse(NewUpload, req.body);
      const c = await loadCaseFor(req, 'create');
      assertUploadable(c.status);
      const key = documentKey(c.organizationId, c.id);
      const uploadId = await storage.createMultipart(key, body.mimeType);
      const doc = await prisma.document.create({
        data: {
          organizationId: c.organizationId,
          caseId: c.id,
          fileName: cleanFileName(body.fileName),
          s3Key: key,
          mimeType: body.mimeType,
          sizeBytes: BigInt(body.sizeBytes),
          uploadedById: auth.user.id,
          uploadId,
        },
        include: docInclude,
      });
      const state = await uploadState(doc);
      await audit(req, 'document.create', doc, {
        sizeBytes: body.sizeBytes,
        mimeType: body.mimeType,
        partCount: state.partCount,
      });
      res.status(201).json(state);
    },
  );

  // ── Resume: which parts S3 already has ────────────────────────────────
  r.get('/uploads/:id', requirePermission('documents', 'create'), async (req, res) => {
    const doc = await loadDocument(req, 'create');
    res.json(await uploadState(doc));
  });

  r.post('/uploads/:id/parts', requirePermission('documents', 'create'), async (req, res) => {
    const doc = await loadDocument(req, 'create');
    if (doc.uploadedAt || !doc.uploadId) {
      throw conflict('upload_completed', 'This upload is already complete');
    }
    const { partCount } = serializeDocument(doc, env);
    const body = parse(
      z.object({
        partNumbers: z
          .array(z.number().int().min(1).max(partCount))
          .min(1)
          .max(100)
          .transform((v) => [...new Set(v)].sort((a, b) => a - b)),
      }),
      req.body,
    );
    const uploadId = doc.uploadId;
    const urls = await Promise.all(
      body.partNumbers.map(async (partNumber) => ({
        partNumber,
        url: await storage.presignPart(doc.s3Key, uploadId, partNumber, PART_URL_TTL_S),
      })),
    );
    res.json({ expiresIn: PART_URL_TTL_S, parts: urls });
  });

  /** Remove a rejected or cancelled upload: S3 object/parts and the row. */
  async function discard(doc: DocRow) {
    if (doc.uploadId) await storage.abortMultipart(doc.s3Key, doc.uploadId);
    else await storage.delete(doc.s3Key);
    await prisma.document.delete({ where: { id: doc.id } });
  }

  r.post('/uploads/:id/complete', requirePermission('documents', 'create'), async (req, res) => {
    const doc = await loadDocument(req, 'create');
    if (doc.uploadedAt || !doc.uploadId) {
      res.json(await uploadState(doc)); // idempotent: a retried /complete is harmless
      return;
    }
    const size = Number(doc.sizeBytes);
    const { partCount, partSize } = serializeDocument(doc, env);
    const parts = await storage.listParts(doc.s3Key, doc.uploadId);
    const have = new Set(parts.map((p) => p.partNumber));
    const missing = Array.from({ length: partCount }, (_, i) => i + 1).filter((n) => !have.has(n));
    if (missing.length > 0) {
      throw new HttpError(409, 'upload_incomplete', 'Some parts have not been uploaded yet', {
        missingParts: missing,
      });
    }
    const inRange = parts.filter((p) => p.partNumber <= partCount);
    const wrongSize = inRange.some((p) =>
      p.partNumber < partCount ? p.size !== partSize : p.size !== size - partSize * (partCount - 1),
    );
    if (wrongSize) {
      await audit(req, 'document.rejected', doc, { reason: 'size_mismatch' });
      await discard(doc);
      throw new HttpError(422, 'size_mismatch', 'The uploaded file does not match its size');
    }
    await storage.completeMultipart(doc.s3Key, doc.uploadId, inRange);
    await prisma.document.update({ where: { id: doc.id }, data: { uploadId: null } });
    const completedDoc = { ...doc, uploadId: null };

    // §10: the type comes from the file's own first bytes, not its name or the browser's claim
    const head = await storage.getRange(doc.s3Key, 0, SNIFF_BYTES - 1);
    const detected = detectFileType(head);
    if (!detected) {
      await audit(req, 'document.rejected', doc, { reason: 'file_type' });
      await discard(completedDoc);
      throw new HttpError(
        422,
        'file_type_not_allowed',
        'This file is not a PDF, PNG, JPEG or TIFF (checked from its contents)',
      );
    }
    const updated = await prisma.document.update({
      where: { id: doc.id },
      data: { uploadedAt: new Date(), mimeType: detected },
      include: docInclude,
    });
    await audit(req, 'document.upload_complete', updated, {
      sizeBytes: size,
      mimeType: detected,
      ...(detected !== doc.mimeType ? { declaredMimeType: doc.mimeType } : {}),
    });

    if (deps.verifyUploads === 'inline') {
      await verifyDocument(deps, doc.id);
    } else {
      void verifyDocument(deps, doc.id).catch((err: Error) =>
        deps.logger.error({ err: { name: err.name, message: err.message } }, 'verify failed'),
      );
    }
    const fresh = await prisma.document.findUniqueOrThrow({
      where: { id: doc.id },
      include: docInclude,
    });
    res.json({ ...(await uploadState(fresh)) });
  });

  /** Cancel an unfinished upload (the uploader, or anyone who may delete the case's records). */
  r.delete('/uploads/:id', requirePermission('documents', 'create'), async (req, res) => {
    const auth = requireAuth(req);
    const doc = await loadDocument(req, 'create');
    if (doc.uploadedAt) throw conflict('upload_completed', 'Delete the document instead');
    if (doc.uploadedById !== auth.user.id && !canOnCase(auth, 'delete', 'documents', doc.case)) {
      throw notFound();
    }
    await discard(doc);
    await audit(req, 'document.delete', doc, { reason: 'upload_cancelled' });
    res.status(204).end();
  });

  // ── Documents ─────────────────────────────────────────────────────────
  r.get('/documents/:id', requirePermission('documents', 'view'), async (req, res) => {
    const doc = await loadDocument(req, 'view');
    await audit(req, 'document.view', doc);
    res.json(serializeDocument(doc, env));
  });

  r.patch('/documents/:id', requirePermission('documents', 'edit'), async (req, res) => {
    const body = parse(z.object({ fileName: z.string().trim().min(1).max(500) }), req.body);
    const doc = await loadDocument(req, 'edit');
    const updated = await prisma.document.update({
      where: { id: doc.id },
      data: { fileName: cleanFileName(body.fileName) },
      include: docInclude,
    });
    await audit(req, 'document.edit', doc, { fields: ['fileName'] });
    res.json(serializeDocument(updated, env));
  });

  r.delete('/documents/:id', requirePermission('documents', 'delete'), async (req, res) => {
    const doc = await loadDocument(req, 'delete');
    assertUploadable(doc.case.status);
    await discard(doc);
    await audit(req, 'document.delete', doc, { scanStatus: doc.scanStatus });
    res.status(204).end();
  });

  r.get('/documents/:id/download-url', requirePermission('documents', 'view'), async (req, res) => {
    const doc = await loadDocument(req, 'view');
    if (!doc.uploadedAt) throw conflict('upload_incomplete', 'This upload has not finished');
    if (doc.scanStatus === 'pending') {
      throw conflict('scan_pending', 'The virus scan has not finished yet');
    }
    if (doc.scanStatus === 'infected') {
      throw conflict('quarantined', 'This file failed the virus scan and is quarantined');
    }
    if (doc.scanStatus !== 'clean') {
      throw conflict('scan_failed', 'This file could not be scanned; contact Datascribe');
    }
    const url = await storage.presignDownload(doc.s3Key, {
      fileName: doc.fileName,
      contentType: doc.mimeType,
      expiresIn: DOWNLOAD_URL_TTL_S,
    });
    await audit(req, 'document.download', doc);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ url, expiresAt: new Date(Date.now() + DOWNLOAD_URL_TTL_S * 1000) });
  });

  return r;
}
