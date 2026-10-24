import { randomBytes } from 'node:crypto';
import { createMedicalData, MockOcrProvider, MockSummaryProvider } from '@datascribe/medical-data';
import { decrypt, encrypt, isEnvelope } from '@datascribe/shared';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';
import type { EventCode } from './code-events';
import {
  RUNNER_STAGES,
  jobError,
  requestedDeliverables,
  runStage,
  type CaseRecord,
  type CaseState,
  type DocumentRecord,
  type EventRecord,
  type PageRecord,
  type PipelineDeps,
  type PipelineStore,
  type RunnerStage,
  type ScanOutcome,
} from './runner';

// Synthetic records only.
const OFFICE = `OFFICE VISIT - RIVERSIDE ORTHOPAEDICS
Facility: Riverside Orthopaedic Clinic
Patient: Jane Testpatient   DOB: 01/02/1980
Date of Service: 03/14/2025
Seen by: Dr. Alan Synthetic, MD
Diagnoses:
1. Lumbar radiculopathy
2. Essential hypertension
Medications: gabapentin 300 mg
Follow-up in 4 weeks.`;

const LAB = `LABORATORY RESULTS
Collected: 2025-02-01
Hemoglobin A1c 5.4 %  reference range 4.0-5.6`;

async function syntheticPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  OFFICE.split('\n').forEach((line, i) =>
    page.drawText(line, { x: 50, y: 740 - i * 16, size: 11, font }),
  );
  return doc.save();
}

interface Job {
  id: string;
  caseId: string;
  stage: string;
  attempts: number;
  status: string;
  error?: string;
}

class MemoryStore implements PipelineStore {
  pages: (PageRecord & { ocrConfidence: number | null })[] = [];
  events: EventRecord[] = [];
  jobs: Job[] = [];
  deliverables: { type: string; version: number; status: string; content: string }[] = [];
  /** uploaded documents not scanned yet (by id); `docs` holds the clean ones */
  unscanned: string[] = [];
  private seq = 0;

  constructor(
    public kase: CaseRecord,
    public docs: DocumentRecord[],
  ) {}

  async getCase(id: string) {
    return id === this.kase.id ? { ...this.kase } : null;
  }
  async listDocuments() {
    return this.docs;
  }
  async listUnscanned() {
    return [...this.unscanned];
  }
  async startJob(caseId: string, stage: string, attempt: number) {
    const id = `job${++this.seq}`;
    this.jobs.push({ id, caseId, stage, attempts: attempt, status: 'running' });
    return id;
  }
  async finishJob(id: string, outcome: { ok: true } | { ok: false; error: string }) {
    const job = this.jobs.find((j) => j.id === id)!;
    job.status = outcome.ok ? 'succeeded' : 'failed';
    if (!outcome.ok) job.error = outcome.error;
  }
  async savePages(
    documentId: string,
    pages: { pageNumber: number; text: string; ocrConfidence: number | null }[],
  ) {
    this.pages = this.pages.filter((p) => p.documentId !== documentId);
    this.pages.push(...pages.map((p) => ({ ...p, documentId, recordType: null })));
    this.docs.find((d) => d.id === documentId)!.pageCount = pages.length;
  }
  async listPages() {
    return this.pages.map(({ documentId, pageNumber, text, recordType }) => ({
      documentId,
      pageNumber,
      text,
      recordType,
    }));
  }
  async setRecordTypes(updates: { documentId: string; pageNumber: number; recordType: string }[]) {
    for (const u of updates) {
      this.pages.find(
        (p) => p.documentId === u.documentId && p.pageNumber === u.pageNumber,
      )!.recordType = u.recordType;
    }
  }
  async replaceEvents(_caseId: string, events: Omit<EventRecord, 'id' | 'codes'>[]) {
    this.events = events.map((e) => ({ ...e, id: `ev${++this.seq}`, codes: [] }));
  }
  async listEvents() {
    return this.events.map((e) => ({ ...e }));
  }
  async setEventCodes(updates: { id: string; codes: EventCode[] }[]) {
    for (const u of updates) this.events.find((e) => e.id === u.id)!.codes = u.codes;
  }
  async saveDeliverables(_caseId: string, items: { type: string; content: string }[]) {
    for (const item of items) {
      const latest = this.deliverables
        .filter((d) => d.type === item.type)
        .sort((a, b) => b.version - a.version)[0];
      if (latest?.status === 'draft') latest.content = item.content;
      else {
        this.deliverables.push({
          type: item.type,
          version: (latest?.version ?? 0) + 1,
          status: 'draft',
          content: item.content,
        });
      }
    }
  }
  async transitionCase(_id: string, from: readonly CaseState[], to: CaseState) {
    if (!from.includes(this.kase.status)) return false;
    this.kase.status = to;
    return true;
  }
}

const phiKey = randomBytes(32);

function setup(opts: { status?: CaseState; requested?: unknown } = {}) {
  const store = new MemoryStore(
    {
      id: 'case1',
      number: 'DS-2026-000001',
      matterName: 'Testpatient v. Synthetic Co',
      reference: null,
      patientName: encrypt('Jane Testpatient', phiKey),
      status: opts.status ?? 'submitted',
      requested: opts.requested ?? ['index', 'chronology', 'summary'],
    },
    [
      {
        id: 'docA',
        fileName: 'office.pdf',
        mimeType: 'application/pdf',
        s3Key: 'k/a',
        pageCount: null,
      },
      { id: 'docB', fileName: 'lab.png', mimeType: 'image/png', s3Key: 'k/b', pageCount: null },
    ],
  );
  const medical = createMedicalData({ provider: 'mock' });
  const objects: Record<string, Uint8Array> = { 'k/b': new TextEncoder().encode(LAB) };
  const log = { info: vi.fn(), warn: vi.fn() };
  /** what the scanner reports per document id (default clean) */
  const scanResults: Record<string, ScanOutcome> = {};
  const deps: PipelineDeps = {
    store,
    phiKey,
    scanDocument: async (id) => {
      const outcome = scanResults[id] ?? 'clean';
      if (outcome === 'pending') return outcome;
      store.unscanned = store.unscanned.filter((u) => u !== id);
      if (outcome !== 'clean') store.docs = store.docs.filter((d) => d.id !== id);
      return outcome;
    },
    readObject: async (key) => {
      if (key === 'k/a') return syntheticPdf();
      const data = objects[key];
      if (!data) throw new Error('NoSuchKey');
      return data;
    },
    ocr: new MockOcrProvider(),
    coders: medical,
    summary: new MockSummaryProvider(),
    log,
  };
  return { store, deps, log, scanResults };
}

const once = { attempt: 1, maxAttempts: 3 };

async function runAll(deps: PipelineDeps, from: RunnerStage = 'scan') {
  let stage: RunnerStage | null = from;
  const seen: RunnerStage[] = [];
  while (stage) {
    seen.push(stage);
    stage = (await runStage(stage, { caseId: 'case1' }, once, deps)).next;
  }
  return seen;
}

describe('pipeline runner', () => {
  it('runs every stage in order and ends in review with cited, encrypted deliverables', async () => {
    const { store, deps, log } = setup();
    expect(await runAll(deps)).toEqual(RUNNER_STAGES);
    expect(store.kase.status).toBe('in_review');

    // one succeeded job row per stage
    expect(store.jobs.map((j) => [j.stage, j.status])).toEqual(
      RUNNER_STAGES.map((s) => [s, 'succeeded']),
    );

    // pages: stored encrypted, classified
    expect(store.pages).toHaveLength(2);
    for (const p of store.pages) expect(isEnvelope(p.text!)).toBe(true);
    expect(store.pages.map((p) => p.recordType).sort()).toEqual(['lab', 'office_visit']);
    expect(store.docs.map((d) => d.pageCount)).toEqual([1, 1]);

    // events: one per page, encrypted, coded by the mock coders
    expect(store.events).toHaveLength(2);
    for (const e of store.events) expect(isEnvelope(e.description)).toBe(true);
    const office = store.events.find((e) => e.documentId === 'docA')!;
    expect(office.eventDate).toBe('2025-03-14');
    expect(office.codes.map((c) => c.code)).toContain('I10');

    // deliverables: index, chronology, summary — encrypted JSON
    expect(store.deliverables.map((d) => d.type)).toEqual(['index', 'chronology', 'summary']);
    const chronology = JSON.parse(
      decrypt(store.deliverables.find((d) => d.type === 'chronology')!.content, phiKey),
    );
    expect(chronology.entries.map((e: { date: string }) => e.date)).toEqual([
      '2025-02-01',
      '2025-03-14',
    ]);
    for (const e of chronology.entries) {
      expect(e.citation.pageNumber).toBe(1);
      expect(['office.pdf', 'lab.png']).toContain(e.citation.fileName);
    }
    const summary = JSON.parse(
      decrypt(store.deliverables.find((d) => d.type === 'summary')!.content, phiKey),
    );
    expect(summary.kind).toBe('summary');

    // logs carry counts only, never page text or the patient name
    const logged = JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls]);
    expect(logged).not.toMatch(/Testpatient|Riverside|radiculopathy|Hemoglobin/);
  });

  it('re-running a case replaces events and overwrites draft deliverables', async () => {
    const { store, deps } = setup();
    await runAll(deps);
    store.kase.status = 'processing';
    await runAll(deps, 'extract');
    expect(store.events).toHaveLength(2);
    expect(store.deliverables.map((d) => d.version)).toEqual([1, 1, 1]);
  });

  it('builds the index and chronology even when only a summary was ordered', () => {
    expect(requestedDeliverables(['summary'])).toEqual(['index', 'chronology', 'summary']);
    expect(requestedDeliverables(null)).toEqual(['index', 'chronology']);
  });

  it('skips a case that left the runnable states (e.g. cancelled)', async () => {
    const { store, deps } = setup({ status: 'cancelled' });
    expect(await runStage('extract', { caseId: 'case1' }, once, deps)).toEqual({
      next: null,
      skipped: true,
    });
    expect(store.jobs).toHaveLength(0);
    expect(await runStage('extract', { caseId: 'nope' }, once, deps)).toMatchObject({
      skipped: true,
    });
  });

  it('stage 1 scans what is left, claims the case and leaves infected files out', async () => {
    const { store, deps, scanResults } = setup();
    store.unscanned = ['docA', 'docB'];
    scanResults.docB = 'infected';
    const r = await runStage('scan', { caseId: 'case1' }, once, deps);
    expect(r).toMatchObject({ next: 'extract', stats: { scanned: 2, clean: 1, infected: 1 } });
    expect(store.kase.status).toBe('processing');
    await runAll(deps, 'extract');
    expect(store.pages.map((p) => p.documentId)).toEqual(['docA']);
    expect(store.kase.status).toBe('in_review');
  });

  it('a duplicate stage-1 job for a case already processing starts no second chain', async () => {
    const { store, deps } = setup({ status: 'processing' });
    expect(await runStage('scan', { caseId: 'case1' }, once, deps)).toEqual({
      next: null,
      skipped: true,
    });
    expect(store.jobs).toHaveLength(0);
  });

  it('stage 1 retries while a file is still being scanned and fails with nothing clean', async () => {
    const { store, deps, scanResults } = setup();
    store.unscanned = ['docA'];
    scanResults.docA = 'pending';
    await expect(runStage('scan', { caseId: 'case1' }, once, deps)).rejects.toThrow(
      /still being scanned/,
    );
    expect(store.kase.status).toBe('submitted');

    scanResults.docA = 'error';
    store.docs = store.docs.filter((d) => d.id === 'docA');
    await expect(
      runStage('scan', { caseId: 'case1' }, { attempt: 3, maxAttempts: 3 }, deps),
    ).rejects.toThrow(/No clean documents/);
    expect(store.kase.status).toBe('on_hold');
  });

  it('records a failed attempt and only puts the case on hold after the last one', async () => {
    const { store, deps, log } = setup({ status: 'processing' });
    store.docs[1]!.s3Key = 'k/missing';
    await expect(
      runStage('extract', { caseId: 'case1' }, { attempt: 1, maxAttempts: 3 }, deps),
    ).rejects.toThrow('NoSuchKey');
    expect(store.kase.status).toBe('processing');
    expect(store.jobs[0]).toMatchObject({ status: 'failed', error: 'Error: NoSuchKey' });

    await expect(
      runStage('extract', { caseId: 'case1' }, { attempt: 3, maxAttempts: 3 }, deps),
    ).rejects.toThrow();
    expect(store.kase.status).toBe('on_hold');
    expect(store.jobs[1]).toMatchObject({ attempts: 3, status: 'failed' });
    expect(log.warn).toHaveBeenLastCalledWith(
      expect.objectContaining({ final: true, error: 'Error' }),
      'pipeline stage failed',
    );
  });

  it('notifies once when the case reaches review, and when it goes on hold', async () => {
    const { store, deps } = setup();
    const notify = { readyForReview: vi.fn(async () => 1), processingFailed: vi.fn(async () => 1) };
    deps.notify = notify;
    await runAll(deps);
    expect(notify.readyForReview).toHaveBeenCalledExactlyOnceWith('case1');
    // a retried stage 7 finds the case already in review: no second notice
    expect(store.kase.status).toBe('in_review');
    await runStage('ready-for-review', { caseId: 'case1' }, once, deps);
    expect(notify.readyForReview).toHaveBeenCalledOnce();
    expect(notify.processingFailed).not.toHaveBeenCalled();

    store.kase.status = 'processing';
    store.docs[1]!.s3Key = 'k/missing';
    const last = { attempt: 3, maxAttempts: 3 };
    await expect(runStage('extract', { caseId: 'case1' }, once, deps)).rejects.toThrow();
    expect(notify.processingFailed).not.toHaveBeenCalled();
    await expect(runStage('extract', { caseId: 'case1' }, last, deps)).rejects.toThrow();
    expect(notify.processingFailed).toHaveBeenCalledExactlyOnceWith('case1');
  });

  it('a failing notification does not fail the stage', async () => {
    const { store, deps, log } = setup({ status: 'processing' });
    deps.notify = {
      readyForReview: async () => {
        throw new TypeError('db down');
      },
      processingFailed: async () => 0,
    };
    const r = await runStage('ready-for-review', { caseId: 'case1' }, once, deps);
    expect(r.next).toBeNull();
    expect(store.kase.status).toBe('in_review');
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'readyForReview', err: { name: 'TypeError' } }),
      'pipeline notice not sent',
    );
  });

  it('rejects unsupported document types', async () => {
    const { store, deps } = setup();
    store.docs[1]!.mimeType = 'application/zip';
    await expect(runStage('extract', { caseId: 'case1' }, once, deps)).rejects.toThrow(
      /Unsupported document type/,
    );
  });

  it('caps job errors and keeps the error class', () => {
    expect(jobError(new TypeError('x'.repeat(500)))).toHaveLength(300);
    expect(jobError('plain')).toBe('Error: plain');
  });
});
