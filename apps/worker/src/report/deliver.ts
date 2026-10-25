/**
 * Delivery (M6 part 5, §5.4, D-098): an approved case gets its final report rendered from the locked
 * deliverable versions, stored in S3, its pages recorded as usage, the case set to `delivered` and the
 * client notified. The dispatcher queues approved cases; every step is safe to repeat, so a retried
 * job never double-counts usage or mails twice. Never logs content.
 */
import { decrypt } from '@datascribe/shared';
import { renderReportPdf, type ReportInput, type ReportSectionContent } from './report-pdf';

export const DELIVERY_QUEUE = 'delivery';

export interface DeliveryJobData {
  caseId: string;
}

export interface DeliveryCase {
  id: string;
  number: string;
  organizationId: string;
  firmName: string;
  matterName: string;
  reference: string | null;
  /** encrypted */
  patientName: string;
  incidentDate: Date | null;
  caseType: string;
  status: string;
  requested: unknown;
}

export interface LockedDeliverable {
  id: string;
  type: string;
  version: number;
  /** encrypted JSON */
  content: string;
  lockedAt: Date;
}

export interface DeliveryStore {
  getCase(caseId: string): Promise<DeliveryCase | null>;
  /** the latest version of each deliverable type, if it is approved and locked */
  lockedDeliverables(caseId: string): Promise<LockedDeliverable[]>;
  /** pages of the case's clean documents (the usage quantity, §5.6) */
  pagesProcessed(caseId: string): Promise<number>;
  /** idempotent per case (D-040) */
  recordUsage(input: {
    organizationId: string;
    caseId: string;
    pages: number;
    at: Date;
  }): Promise<void>;
  /**
   * In one transaction: approved → delivered with `deliveredAt`, the deliverables `delivered` with
   * the report key, and the status timeline row. False when the case is no longer approved.
   */
  markDelivered(input: {
    caseId: string;
    organizationId: string;
    deliverableIds: string[];
    pdfS3Key: string;
    at: Date;
  }): Promise<boolean>;
}

export interface DeliveryDeps {
  store: DeliveryStore;
  phiKey: Buffer;
  companyName: () => Promise<string>;
  /** stores the PDF with the bucket's encryption */
  putReport(key: string, body: Uint8Array): Promise<void>;
  notifyDelivered(caseId: string): Promise<unknown>;
  log: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
  now?: () => Date;
}

export type DeliveryResult =
  | { delivered: true; pages: number; reportPages: number; pdfS3Key: string }
  | { delivered: false; reason: 'not_found' | 'not_approved' | 'not_locked' | 'changed' };

const ORDER = ['summary', 'chronology', 'index'];

/** Report sections in the order the client requested them, then any others. */
export function sectionOrder(requested: unknown, types: string[]): string[] {
  const asked = Array.isArray(requested) ? requested.filter((t) => typeof t === 'string') : [];
  const rank = (t: string) => {
    const i = asked.indexOf(t);
    return i >= 0 ? i : asked.length + ORDER.indexOf(t);
  };
  return [...types].sort((a, b) => rank(a) - rank(b));
}

/**
 * The report's key changes whenever a delivered version changes, so a retry overwrites the same
 * object with the same bytes and a re-delivery after new versions never replaces an old report.
 */
export const reportKey = (
  c: { organizationId: string; id: string; number: string },
  parts: LockedDeliverable[],
) =>
  `reports/${c.organizationId}/${c.id}/${c.number}-${parts
    .map((d) => `${d.type[0]}${d.version}`)
    .join('')}.pdf`;

export async function deliverCase(caseId: string, deps: DeliveryDeps): Promise<DeliveryResult> {
  const c = await deps.store.getCase(caseId);
  if (!c) return { delivered: false, reason: 'not_found' };
  if (c.status !== 'approved') return { delivered: false, reason: 'not_approved' };
  const locked = await deps.store.lockedDeliverables(caseId);
  if (locked.length === 0) {
    // approval locks the versions in the same transaction, so this is an inconsistency to look at
    deps.log.warn({ caseId }, 'approved case has no locked deliverables');
    return { delivered: false, reason: 'not_locked' };
  }
  const byType = new Map(locked.map((d) => [d.type, d]));
  const parts = sectionOrder(
    c.requested,
    locked.map((d) => d.type),
  ).map((t) => byType.get(t)!);

  const input: ReportInput = {
    companyName: await deps.companyName(),
    firmName: c.firmName,
    caseNumber: c.number,
    matterName: c.matterName,
    reference: c.reference,
    patientName: decrypt(c.patientName, deps.phiKey),
    incidentDate: c.incidentDate ? c.incidentDate.toISOString().slice(0, 10) : null,
    caseType: c.caseType,
    approvedAt: new Date(Math.max(...parts.map((d) => d.lockedAt.getTime()))),
    sections: parts.map((d) => ({
      version: d.version,
      content: JSON.parse(decrypt(d.content, deps.phiKey)) as ReportSectionContent,
    })),
  };
  const { bytes, pages: reportPages } = await renderReportPdf(input);
  const pdfS3Key = reportKey(c, parts);
  await deps.putReport(pdfS3Key, bytes);

  const at = (deps.now ?? (() => new Date()))();
  const pages = await deps.store.pagesProcessed(caseId);
  // before the status change: if the job dies in between, the retry finds the case still approved
  await deps.store.recordUsage({ organizationId: c.organizationId, caseId, pages, at });
  const moved = await deps.store.markDelivered({
    caseId,
    organizationId: c.organizationId,
    deliverableIds: parts.map((d) => d.id),
    pdfS3Key,
    at,
  });
  if (!moved) return { delivered: false, reason: 'changed' };
  try {
    await deps.notifyDelivered(caseId);
  } catch (err) {
    // delivery stands; the bell / email can be resent by hand
    deps.log.warn({ caseId, err: { name: (err as Error).name } }, 'delivered notification failed');
  }
  deps.log.info({ caseId, pages, reportPages }, 'case delivered');
  return { delivered: true, pages, reportPages, pdfS3Key };
}
