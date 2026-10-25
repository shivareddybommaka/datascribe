import { encrypt } from '@datascribe/shared';
import { randomBytes } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import {
  deliverCase,
  reportKey,
  sectionOrder,
  type DeliveryCase,
  type DeliveryDeps,
  type LockedDeliverable,
} from './deliver';

const key = randomBytes(32);
const lockedAt = new Date('2026-10-25T02:00:00Z');

// synthetic data only
const chronology = {
  kind: 'chronology',
  entries: [
    {
      date: '2025-03-14',
      provider: 'Dr Alex Sample',
      facility: null,
      eventType: 'er',
      description: 'Seen in the emergency department after a collision.',
      codes: [],
      citation: { documentId: 'doc1', fileName: 'records-a.pdf', pageNumber: 2 },
    },
  ],
};
const index = {
  kind: 'index',
  totals: { documents: 1, pages: 6 },
  rows: [],
};

function setup(
  over: { status?: string; locked?: LockedDeliverable[]; notifyFails?: boolean } = {},
) {
  const c: DeliveryCase = {
    id: 'case1',
    number: 'DS-2026-000042',
    organizationId: 'org1',
    firmName: 'Acme Injury Law (synthetic)',
    matterName: 'Doe v. Example Transit',
    reference: null,
    patientName: encrypt('Jane Testpatient', key),
    incidentDate: new Date('2025-03-14T00:00:00Z'),
    caseType: 'personal_injury',
    status: over.status ?? 'approved',
    requested: ['chronology', 'index'],
  };
  const locked = over.locked ?? [
    { id: 'dI', type: 'index', version: 1, content: encrypt(JSON.stringify(index), key), lockedAt },
    {
      id: 'dC',
      type: 'chronology',
      version: 3,
      content: encrypt(JSON.stringify(chronology), key),
      lockedAt,
    },
  ];
  const calls: string[] = [];
  const objects = new Map<string, Uint8Array>();
  const usage = new Map<string, number>();
  const deps: DeliveryDeps = {
    store: {
      getCase: async () => c,
      lockedDeliverables: async () => locked,
      pagesProcessed: async () => 6,
      recordUsage: async (u) => {
        calls.push('usage');
        if (!usage.has(u.caseId)) usage.set(u.caseId, u.pages);
      },
      markDelivered: async (m) => {
        calls.push(`mark ${m.deliverableIds.join(',')} ${m.pdfS3Key}`);
        if (c.status !== 'approved') return false;
        c.status = 'delivered';
        return true;
      },
    },
    phiKey: key,
    companyName: async () => 'Datascribe',
    putReport: async (k, body) => {
      calls.push('put');
      objects.set(k, body);
    },
    notifyDelivered: async () => {
      calls.push('notify');
      if (over.notifyFails) throw new Error('smtp down');
    },
    log: { info: () => {}, warn: () => {} },
    now: () => new Date('2026-10-25T03:00:00Z'),
  };
  return { c, deps, calls, objects, usage };
}

describe('delivery', () => {
  it('renders the report in the requested order, stores it, records usage, then delivers', async () => {
    const { deps, calls, objects, usage } = setup();
    const r = await deliverCase('case1', deps);
    const k = 'reports/org1/case1/DS-2026-000042-c3i1.pdf';
    expect(r).toEqual({ delivered: true, pages: 6, reportPages: 3, pdfS3Key: k });
    expect(calls).toEqual(['put', 'usage', `mark dC,dI ${k}`, 'notify']);
    expect(usage.get('case1')).toBe(6);
    const pdf = await PDFDocument.load(objects.get(k)!);
    expect(pdf.getPageCount()).toBe(3);
  });

  it('does nothing for a case that is not approved, and a retry after delivery is a no-op', async () => {
    const { deps, calls } = setup({ status: 'qa' });
    expect(await deliverCase('case1', deps)).toEqual({ delivered: false, reason: 'not_approved' });
    expect(calls).toEqual([]);

    const s = setup();
    await deliverCase('case1', s.deps);
    expect(await deliverCase('case1', s.deps)).toEqual({
      delivered: false,
      reason: 'not_approved',
    });
    expect(s.calls.filter((x) => x === 'notify')).toHaveLength(1);
  });

  it('refuses an approved case without locked versions', async () => {
    const { deps, calls } = setup({ locked: [] });
    expect(await deliverCase('case1', deps)).toEqual({ delivered: false, reason: 'not_locked' });
    expect(calls).toEqual([]);
  });

  it('keeps the delivery when the notification fails', async () => {
    const { deps, c } = setup({ notifyFails: true });
    expect((await deliverCase('case1', deps)).delivered).toBe(true);
    expect(c.status).toBe('delivered');
  });

  it('orders sections by the request and keys reports by version', () => {
    expect(sectionOrder(['index', 'summary'], ['summary', 'chronology', 'index'])).toEqual([
      'index',
      'summary',
      'chronology',
    ]);
    expect(sectionOrder(null, ['index', 'summary'])).toEqual(['summary', 'index']);
    const c = { organizationId: 'o', id: 'c', number: 'DS-1' };
    const d = (type: string, version: number) =>
      ({ id: type, type, version, content: '', lockedAt }) as LockedDeliverable;
    expect(reportKey(c, [d('summary', 2), d('index', 1)])).toBe('reports/o/c/DS-1-s2i1.pdf');
  });
});
