/**
 * Hands work from the database to the queues (D-081). The API only writes rows (an upload is
 * completed, a case is submitted); the worker polls for them and enqueues jobs with deterministic
 * ids, so nothing is lost when Redis was down at that moment and a row is never queued twice.
 */

/** Per-document scans as uploads complete, so the portal shows Ready / Infected before submit. */
export const UPLOAD_SCAN_QUEUE = 'scan-upload';

export interface UploadScanJobData {
  documentId: string;
}

export interface DispatchSource {
  /** uploaded documents still waiting for their virus scan, oldest first */
  pendingUploads(limit: number): Promise<{ id: string }[]>;
  /** submitted cases that stage 1 has not claimed yet, oldest first */
  submittedCases(limit: number): Promise<{ id: string; updatedAt: Date }[]>;
  /** QA-approved cases waiting for their final report (D-098), oldest first */
  approvedCases(limit: number): Promise<{ id: string; updatedAt: Date }[]>;
}

export interface DispatchTarget {
  scanUpload(documentId: string, jobId: string): Promise<void>;
  startCase(caseId: string, jobId: string): Promise<void>;
  deliverCase(caseId: string, jobId: string): Promise<void>;
}

/** Queued, active and recently finished jobs keep their id, so re-adding one is a no-op. */
export const uploadScanJobId = (documentId: string) => `upload-${documentId}`;
/**
 * A case can come back to `submitted` later (e.g. from on hold); its `updatedAt` then differs, so
 * that submission gets a fresh job while repeats of the same one stay deduplicated.
 */
export const caseJobId = (caseId: string, updatedAt: Date) =>
  `case-${caseId}-${updatedAt.getTime()}`;
/** Same rule for delivery: one job per approval. */
export const deliveryJobId = (caseId: string, updatedAt: Date) =>
  `deliver-${caseId}-${updatedAt.getTime()}`;

export interface DispatchOptions {
  /** start the pipeline for submitted cases (`PIPELINE_START_CASES=false`: scan uploads only) */
  startCases: boolean;
  batch?: number;
}

export async function dispatchOnce(
  source: DispatchSource,
  target: DispatchTarget,
  opts: DispatchOptions,
): Promise<{ uploads: number; cases: number; deliveries: number }> {
  const batch = opts.batch ?? 100;
  const uploads = await source.pendingUploads(batch);
  for (const d of uploads) await target.scanUpload(d.id, uploadScanJobId(d.id));
  const cases = opts.startCases ? await source.submittedCases(batch) : [];
  for (const c of cases) await target.startCase(c.id, caseJobId(c.id, c.updatedAt));
  const approved = opts.startCases ? await source.approvedCases(batch) : [];
  for (const c of approved) await target.deliverCase(c.id, deliveryJobId(c.id, c.updatedAt));
  return { uploads: uploads.length, cases: cases.length, deliveries: approved.length };
}
