/**
 * Stage runner (REQUIREMENTS.md §7, M5b step 3). One job per case per stage: each stage reads what the
 * previous one stored, writes its own output, records a `ProcessingJob` row and names the next stage.
 * When the last attempt of a stage fails the case goes `on_hold` (§7: 3 attempts, exponential backoff).
 *
 * PHI (page text, event descriptions, deliverable content, the patient name) is encrypted before it
 * reaches the store and never logged; job rows and logs carry counts and error classes only.
 * Persistence is behind `PipelineStore` (Prisma in production, an in-memory fake in tests).
 */
import type { OcrProvider, SummaryOutput, SummaryProvider } from '@datascribe/medical-data';
import { decrypt, encrypt } from '@datascribe/shared';
import { PIPELINE_QUEUES, nextStage, type PipelineQueue } from '../queues';
import { classifyPage, RECORD_TYPES, type RecordType } from './classify';
import { CaseCoder, type Coders, type EventCode } from './code-events';
import {
  buildChronology,
  buildIndex,
  summaryInput,
  type DocumentInfo,
  type EventInfo,
} from './deliverables';
import { extractEvent } from './extract-events';
import { extractImagePage, extractPdfPages, type ExtractResult } from './extract-text';

/** Every §7 stage, stage 1 (scan) included (D-081). */
export type RunnerStage = PipelineQueue;
export const RUNNER_STAGES: readonly RunnerStage[] = PIPELINE_QUEUES;
export const FIRST_RUNNER_STAGE: RunnerStage = 'scan';

/** Outcome of scanning one document (Document.scanStatus after the scan). */
export type ScanOutcome = 'pending' | 'clean' | 'infected' | 'error';

export type CaseState =
  | 'draft'
  | 'submitted'
  | 'processing'
  | 'in_review'
  | 'qa'
  | 'changes_requested'
  | 'approved'
  | 'delivered'
  | 'closed'
  | 'on_hold'
  | 'cancelled';

/** Case states in which pipeline stages run; anything else (cancelled, on_hold…) stops the chain. */
export const RUNNABLE_STATES: readonly CaseState[] = ['submitted', 'processing'];

/**
 * Stage 1 only starts a submitted case and claims it (`submitted → processing`), so a duplicate
 * scan job for a case that is already being processed ends there instead of starting a second chain.
 */
const runnableIn = (stage: RunnerStage): readonly CaseState[] =>
  stage === 'scan' ? ['submitted'] : RUNNABLE_STATES;

export const DELIVERABLE_TYPES = ['index', 'chronology', 'summary'] as const;
export type PipelineDeliverable = (typeof DELIVERABLE_TYPES)[number];

export interface PipelineJobData {
  caseId: string;
}

export interface CaseRecord {
  id: string;
  number: string;
  matterName: string;
  reference: string | null;
  /** encrypted */
  patientName: string;
  status: CaseState;
  /** Case.requested, e.g. ["index","chronology","summary"] */
  requested: unknown;
}

export interface DocumentRecord {
  id: string;
  fileName: string;
  mimeType: string;
  s3Key: string;
  pageCount: number | null;
}

export interface PageRecord {
  documentId: string;
  pageNumber: number;
  /** encrypted */
  text: string | null;
  recordType: string | null;
}

export interface EventRecord {
  id: string;
  documentId: string;
  pageNumber: number;
  eventDate: string | null;
  provider: string | null;
  facility: string | null;
  eventType: string | null;
  /** encrypted */
  description: string;
  codes: EventCode[];
}

export interface PipelineStore {
  getCase(caseId: string): Promise<CaseRecord | null>;
  /** uploaded, clean documents of the case, in upload order */
  listDocuments(caseId: string): Promise<DocumentRecord[]>;
  /** ids of the case's uploaded documents still waiting for their virus scan */
  listUnscanned(caseId: string): Promise<string[]>;
  startJob(caseId: string, stage: PipelineQueue, attempt: number): Promise<string>;
  finishJob(jobId: string, outcome: { ok: true } | { ok: false; error: string }): Promise<void>;
  /** replaces the document's pages and sets its page count */
  savePages(
    documentId: string,
    pages: { pageNumber: number; text: string; ocrConfidence: number | null }[],
  ): Promise<void>;
  listPages(caseId: string): Promise<PageRecord[]>;
  setRecordTypes(
    updates: { documentId: string; pageNumber: number; recordType: RecordType }[],
  ): Promise<void>;
  /** replaces the case's events (a re-run must not duplicate them) */
  replaceEvents(caseId: string, events: Omit<EventRecord, 'id' | 'codes'>[]): Promise<void>;
  listEvents(caseId: string): Promise<EventRecord[]>;
  setEventCodes(updates: { id: string; codes: EventCode[] }[]): Promise<void>;
  /** stores a draft per type: overwrites the latest version while it is still a draft, else adds one */
  saveDeliverables(
    caseId: string,
    items: { type: PipelineDeliverable; content: string }[],
  ): Promise<void>;
  /** compare-and-set: only moves the case when it is in one of `from` */
  transitionCase(caseId: string, from: readonly CaseState[], to: CaseState): Promise<boolean>;
}

export interface PipelineLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface PipelineDeps {
  store: PipelineStore;
  phiKey: Buffer;
  /** stage 1 for one document: hash, page count, virus scan, quarantine (`@datascribe/scan`) */
  scanDocument(documentId: string): Promise<ScanOutcome>;
  readObject(s3Key: string): Promise<Uint8Array>;
  ocr: OcrProvider;
  renderPage?: (data: Uint8Array, pageNumber: number) => Promise<Buffer | null>;
  coders: Coders;
  summary: SummaryProvider;
  log: PipelineLogger;
  /** M9 notifications (`@datascribe/db/notifications`); a failed notification never fails a stage */
  notify?: PipelineNotifier;
}

export interface PipelineNotifier {
  /** the case reached `in_review`: its summarizer, else the case managers */
  readyForReview(caseId: string): Promise<unknown>;
  /** a stage failed after its retries and the case is `on_hold`: case manager + ops */
  processingFailed(caseId: string): Promise<unknown>;
}

async function sendNotice(deps: PipelineDeps, kind: keyof PipelineNotifier, caseId: string) {
  if (!deps.notify) return;
  try {
    await deps.notify[kind](caseId);
  } catch (err) {
    deps.log.warn({ caseId, kind, err: { name: (err as Error).name } }, 'pipeline notice not sent');
  }
}

export interface StageContext {
  /** 1-based attempt number of this run */
  attempt: number;
  maxAttempts: number;
}

export interface StageResult {
  next: RunnerStage | null;
  skipped?: boolean;
  stats?: Record<string, number>;
}

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/tiff']);

/** Error class + message, capped. Our stage errors never carry document content. */
export function jobError(err: unknown): string {
  const e = err instanceof Error ? err : new Error(String(err));
  return `${e.name}: ${e.message}`.slice(0, 300);
}

export function requestedDeliverables(requested: unknown): PipelineDeliverable[] {
  const list = Array.isArray(requested) ? requested : [];
  const wanted = DELIVERABLE_TYPES.filter((t) => list.includes(t));
  // The index and chronology are the backbone of review; build them even if not ordered.
  for (const t of ['chronology', 'index'] as const) if (!wanted.includes(t)) wanted.unshift(t);
  return wanted;
}

const asRecordType = (v: string | null): RecordType =>
  (RECORD_TYPES as readonly string[]).includes(v ?? '') ? (v as RecordType) : 'other';

type Processor = (c: CaseRecord, deps: PipelineDeps) => Promise<Record<string, number>>;

const PROCESSORS: Record<RunnerStage, Processor> = {
  async scan(c, deps) {
    // Uploads are normally scanned as they complete (the dispatcher); this catches any left over.
    const stats = { scanned: 0, clean: 0, infected: 0, failed: 0, busy: 0 };
    for (const id of await deps.store.listUnscanned(c.id)) {
      const outcome = await deps.scanDocument(id);
      stats.scanned++;
      if (outcome === 'clean') stats.clean++;
      else if (outcome === 'infected') stats.infected++;
      else if (outcome === 'error') stats.failed++;
      else stats.busy++;
    }
    // a scan of the same file is still running (its upload job): retry rather than leave it out
    if (stats.busy > 0) throw new Error('Documents are still being scanned');
    // Infected or unscannable files are left out (never processed); nothing clean left = a failure.
    if ((await deps.store.listDocuments(c.id)).length === 0) {
      throw new Error('No clean documents to process');
    }
    return stats;
  },

  async extract(c, deps) {
    const stats = { documents: 0, pages: 0, ocrPages: 0, needsOcr: 0 };
    for (const doc of await deps.store.listDocuments(c.id)) {
      const data = await deps.readObject(doc.s3Key);
      let result: ExtractResult;
      if (doc.mimeType === 'application/pdf') {
        result = await extractPdfPages(data, {
          ocr: deps.ocr,
          renderPage: deps.renderPage ? (n) => deps.renderPage!(data, n) : undefined,
        });
      } else if (IMAGE_TYPES.has(doc.mimeType)) {
        result = await extractImagePage(Buffer.from(data), deps.ocr);
      } else {
        throw new Error(`Unsupported document type ${doc.mimeType}`);
      }
      await deps.store.savePages(
        doc.id,
        result.pages.map((p) => ({ ...p, text: encrypt(p.text, deps.phiKey) })),
      );
      stats.documents++;
      stats.pages += result.pages.length;
      stats.ocrPages += result.ocrPages;
      stats.needsOcr += result.needsOcr;
    }
    return stats;
  },

  async classify(c, deps) {
    const pages = await deps.store.listPages(c.id);
    const updates = pages.map((p) => ({
      documentId: p.documentId,
      pageNumber: p.pageNumber,
      recordType: classifyPage(p.text ? decrypt(p.text, deps.phiKey) : null),
    }));
    await deps.store.setRecordTypes(updates);
    return { pages: updates.length };
  },

  async 'extract-events'(c, deps) {
    const events = [];
    for (const p of await deps.store.listPages(c.id)) {
      const e = extractEvent({
        documentId: p.documentId,
        pageNumber: p.pageNumber,
        text: p.text ? decrypt(p.text, deps.phiKey) : null,
        recordType: asRecordType(p.recordType),
      });
      if (!e) continue;
      events.push({
        documentId: e.documentId,
        pageNumber: e.pageNumber,
        eventDate: e.eventDate,
        provider: e.provider,
        facility: e.facility,
        eventType: e.eventType,
        description: encrypt(e.description, deps.phiKey),
      });
    }
    await deps.store.replaceEvents(c.id, events);
    return { events: events.length };
  },

  async code(c, deps) {
    const identifiers = [decrypt(c.patientName, deps.phiKey), c.number, c.matterName];
    if (c.reference) identifiers.push(c.reference);
    const coder = new CaseCoder(deps.coders, identifiers);
    // Terms aren't stored (D-080): re-derive them from the cited page, which is deterministic.
    const pages = new Map(
      (await deps.store.listPages(c.id)).map((p) => [`${p.documentId}#${p.pageNumber}`, p]),
    );
    const updates = [];
    for (const ev of await deps.store.listEvents(c.id)) {
      const p = pages.get(`${ev.documentId}#${ev.pageNumber}`);
      const extracted = p
        ? extractEvent({
            documentId: p.documentId,
            pageNumber: p.pageNumber,
            text: p.text ? decrypt(p.text, deps.phiKey) : null,
            recordType: asRecordType(p.recordType),
          })
        : null;
      const codes = extracted ? await coder.codeTerms(extracted.terms) : [];
      updates.push({ id: ev.id, codes });
    }
    await deps.store.setEventCodes(updates);
    return { events: updates.length, ...coder.stats };
  },

  async 'build-deliverables'(c, deps) {
    const docs = await deps.store.listDocuments(c.id);
    const pages = await deps.store.listPages(c.id);
    const documents: DocumentInfo[] = docs.map((d) => ({
      id: d.id,
      fileName: d.fileName,
      pageCount: d.pageCount ?? pages.filter((p) => p.documentId === d.id).length,
    }));
    const events: EventInfo[] = (await deps.store.listEvents(c.id)).map((e) => ({
      ...e,
      description: decrypt(e.description, deps.phiKey),
    }));
    const items: { type: PipelineDeliverable; content: string }[] = [];
    for (const type of requestedDeliverables(c.requested)) {
      let content: object;
      if (type === 'index') {
        content = buildIndex(
          documents,
          pages.map((p) => ({ ...p, recordType: asRecordType(p.recordType) })),
          events,
        );
      } else if (type === 'chronology') {
        content = buildChronology(documents, events);
      } else {
        const out: SummaryOutput = await deps.summary.summarize(summaryInput(c.id, events));
        content = { kind: 'summary', ...out };
      }
      items.push({ type, content: encrypt(JSON.stringify(content), deps.phiKey) });
    }
    await deps.store.saveDeliverables(c.id, items);
    return { deliverables: items.length, events: events.length };
  },

  async 'ready-for-review'(c, deps) {
    const moved = await deps.store.transitionCase(c.id, ['processing'], 'in_review');
    // only the run that moved the case notifies, so a retried stage 7 doesn't notify twice
    if (moved) await sendNotice(deps, 'readyForReview', c.id);
    return { moved: moved ? 1 : 0 };
  },
};

/**
 * Runs one stage for one case. Returns the next stage to enqueue (null at the end, or when the case
 * left the runnable states, e.g. cancelled mid-run). Throws on failure so the queue retries; on the
 * final attempt the case is put on hold first.
 */
export async function runStage(
  stage: RunnerStage,
  data: PipelineJobData,
  ctx: StageContext,
  deps: PipelineDeps,
): Promise<StageResult> {
  const c = await deps.store.getCase(data.caseId);
  if (!c || !runnableIn(stage).includes(c.status)) {
    deps.log.info(
      { stage, caseId: data.caseId, status: c?.status ?? 'missing' },
      'pipeline stage skipped',
    );
    return { next: null, skipped: true };
  }
  const jobId = await deps.store.startJob(c.id, stage, ctx.attempt);
  try {
    const stats = await PROCESSORS[stage](c, deps);
    const claimed =
      stage !== 'scan' || (await deps.store.transitionCase(c.id, ['submitted'], 'processing'));
    await deps.store.finishJob(jobId, { ok: true });
    deps.log.info({ stage, caseId: c.id, attempt: ctx.attempt, ...stats }, 'pipeline stage done');
    if (!claimed) return { next: null, skipped: true, stats };
    return { next: nextStage(stage), stats };
  } catch (err) {
    const error = jobError(err);
    await deps.store.finishJob(jobId, { ok: false, error });
    const final = ctx.attempt >= ctx.maxAttempts;
    if (final && (await deps.store.transitionCase(c.id, RUNNABLE_STATES, 'on_hold'))) {
      await sendNotice(deps, 'processingFailed', c.id);
    }
    deps.log.warn(
      { stage, caseId: c.id, attempt: ctx.attempt, final, error: error.split(':')[0] },
      'pipeline stage failed',
    );
    throw err;
  }
}
