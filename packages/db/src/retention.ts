/**
 * Retention / hard-delete job (§10, D-128), run by the worker's `retention` queue.
 *
 * Per organization with a valid `settings.retentionDays`, the SOURCE documents of cases closed more
 * than that many days ago are hard-deleted: the S3 object (or an unfinished multipart upload) and
 * the encrypted page text (`DocumentPage` rows). The `Document` row stays as a tombstone
 * (`purgedAt`) so the portal can say "Deleted by retention" and chronology citations keep their
 * document id. Cases, clinical events and deliverables are kept.
 *
 * Safe to rerun: purged documents are skipped, S3 deletes are idempotent, and a document is only
 * marked purged after its object is gone, so a failed delete is retried on the next run. One
 * `AuditLog` row per deleted file (actor = system, no file names: they may hold patient names).
 */
import type { PrismaClient } from '../generated/client/index.js';
import { errorInfo } from './index';

export const RETENTION_ACTION = 'document.retention_delete';
/** Same bounds as the admin console (D-062). */
export const RETENTION_MIN_DAYS = 30;
export const RETENTION_MAX_DAYS = 3650;
export const DEFAULT_RETENTION_BATCH = 500;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The org's retention period, or null when it is unset or invalid. Null means "delete nothing":
 * the job never falls back to a default on its own (D-128).
 */
export function retentionDaysOf(settings: unknown): number | null {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return null;
  const days = (settings as { retentionDays?: unknown }).retentionDays;
  if (typeof days !== 'number' || !Number.isInteger(days)) return null;
  if (days < RETENTION_MIN_DAYS || days > RETENTION_MAX_DAYS) return null;
  return days;
}

export interface SourceObject {
  s3Key: string;
  /** set while a multipart upload never finished: abort it instead of deleting an object */
  uploadId: string | null;
}

interface Log {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface RetentionOptions {
  /** Delete the document's S3 object; must succeed (or be a no-op) when it is already gone. */
  deleteObject(doc: SourceObject): Promise<void>;
  now?: Date;
  /** Most documents deleted in one run; the rest wait for the next run. */
  batchSize?: number;
  /** Count what would be deleted, change nothing. */
  dryRun?: boolean;
  /** Limit the run to these organizations (tests, one-off runs); default all. */
  organizationIds?: string[];
  log?: Log;
}

export interface RetentionResult {
  dryRun: boolean;
  /** orgs with a valid retentionDays */
  orgs: number;
  /** orgs skipped: retentionDays unset or invalid */
  skippedOrgs: number;
  /** documents past retention at the start of the run */
  eligible: number;
  deleted: number;
  failed: number;
}

const silent: Log = { info() {}, warn() {} };

export async function runRetention(
  db: PrismaClient,
  opts: RetentionOptions,
): Promise<RetentionResult> {
  const now = opts.now ?? new Date();
  const dryRun = opts.dryRun ?? false;
  const log = opts.log ?? silent;
  let budget = Math.max(0, Math.floor(opts.batchSize ?? DEFAULT_RETENTION_BATCH));
  const result: RetentionResult = {
    dryRun,
    orgs: 0,
    skippedOrgs: 0,
    eligible: 0,
    deleted: 0,
    failed: 0,
  };

  const orgs = await db.organization.findMany({
    where: opts.organizationIds ? { id: { in: opts.organizationIds } } : {},
    select: { id: true, settings: true },
    orderBy: { createdAt: 'asc' },
  });
  for (const org of orgs) {
    const days = retentionDaysOf(org.settings);
    if (days === null) {
      result.skippedOrgs++;
      continue;
    }
    result.orgs++;
    const cutoff = new Date(now.getTime() - days * DAY_MS);
    // Only cases that are closed now and were closed before the cutoff (a case without closedAt
    // is never old enough).
    const where = {
      organizationId: org.id,
      purgedAt: null,
      case: { organizationId: org.id, status: 'closed' as const, closedAt: { lt: cutoff } },
    };
    const eligible = await db.document.count({ where });
    result.eligible += eligible;
    if (eligible === 0) continue;
    if (dryRun) {
      log.info({ organizationId: org.id, retentionDays: days, eligible }, 'retention dry run');
      continue;
    }
    if (budget === 0) continue;

    const docs = await db.document.findMany({
      where,
      select: { id: true, caseId: true, s3Key: true, uploadId: true },
      orderBy: { createdAt: 'asc' },
      take: budget,
    });
    budget -= docs.length;
    for (const doc of docs) {
      try {
        // re-check right before deleting: the case may have been reopened since the query
        const still = await db.document.count({ where: { ...where, id: doc.id } });
        if (still === 0) continue;
        await opts.deleteObject({ s3Key: doc.s3Key, uploadId: doc.uploadId });
        const done = await db.$transaction(async (tx) => {
          const { count } = await tx.document.updateMany({
            where: { id: doc.id, purgedAt: null },
            data: { purgedAt: now, uploadId: null },
          });
          if (count === 0) return false; // another run got there first
          const pages = await tx.documentPage.deleteMany({ where: { documentId: doc.id } });
          await tx.auditLog.create({
            data: {
              actorId: null,
              organizationId: org.id,
              action: RETENTION_ACTION,
              entity: 'Document',
              entityId: doc.id,
              metadata: {
                actor: 'system',
                caseId: doc.caseId,
                retentionDays: days,
                pagesDeleted: pages.count,
              },
            },
          });
          return true;
        });
        if (done) result.deleted++;
      } catch (err) {
        result.failed++;
        log.warn(
          { organizationId: org.id, documentId: doc.id, err: errorInfo(err) },
          'retention delete failed; retried next run',
        );
      }
    }
  }
  if (!dryRun && (result.deleted > 0 || result.failed > 0)) {
    log.info({ ...result }, 'retention run done');
  }
  return result;
}
