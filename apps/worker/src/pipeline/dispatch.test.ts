import { describe, expect, it } from 'vitest';
import {
  caseJobId,
  deliveryJobId,
  dispatchOnce,
  uploadScanJobId,
  type DispatchTarget,
} from './dispatch';

const at = new Date('2026-10-24T01:00:00Z');

function target() {
  const calls: string[] = [];
  const t: DispatchTarget = {
    async scanUpload(id, jobId) {
      calls.push(`scan ${id} ${jobId}`);
    },
    async startCase(id, jobId) {
      calls.push(`case ${id} ${jobId}`);
    },
    async deliverCase(id, jobId) {
      calls.push(`deliver ${id} ${jobId}`);
    },
  };
  return { t, calls };
}

const source = {
  pendingUploads: async () => [{ id: 'd1' }, { id: 'd2' }],
  submittedCases: async () => [{ id: 'c1', updatedAt: at }],
  approvedCases: async () => [{ id: 'c9', updatedAt: at }],
};

describe('dispatcher', () => {
  it('queues pending uploads, submitted and approved cases under deterministic job ids', async () => {
    const { t, calls } = target();
    expect(await dispatchOnce(source, t, { startCases: true })).toEqual({
      uploads: 2,
      cases: 1,
      deliveries: 1,
    });
    expect(calls).toEqual([
      'scan d1 upload-d1',
      'scan d2 upload-d2',
      `case c1 case-c1-${at.getTime()}`,
      `deliver c9 deliver-c9-${at.getTime()}`,
    ]);
  });

  it('only scans uploads when case processing is switched off', async () => {
    const { t, calls } = target();
    expect(await dispatchOnce(source, t, { startCases: false })).toEqual({
      uploads: 2,
      cases: 0,
      deliveries: 0,
    });
    expect(calls).toHaveLength(2);
  });

  it('gives a re-submitted case a new job id and repeats of one submission the same id', () => {
    const later = new Date(at.getTime() + 1);
    expect(caseJobId('c1', at)).toBe(caseJobId('c1', new Date(at)));
    expect(caseJobId('c1', later)).not.toBe(caseJobId('c1', at));
    expect(deliveryJobId('c1', later)).not.toBe(deliveryJobId('c1', at));
    expect(uploadScanJobId('d1')).not.toContain(':'); // BullMQ reserves ':' in custom ids
    expect(deliveryJobId('c1', at)).not.toContain(':');
  });
});
