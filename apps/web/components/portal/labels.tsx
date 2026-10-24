'use client';

import type { CaseStatus, CaseType, Priority } from '@datascribe/shared/constants';
import { Badge } from '@/components/ui';
import type { ScanStatus } from '@/lib/types';

export const CASE_STATUS_LABEL: Record<CaseStatus, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  processing: 'Processing',
  in_review: 'In review',
  qa: 'Quality check',
  changes_requested: 'Changes requested',
  approved: 'Approved',
  delivered: 'Delivered',
  closed: 'Closed',
  on_hold: 'On hold',
  cancelled: 'Cancelled',
};

const CASE_TONE = {
  draft: 'neutral',
  submitted: 'brand',
  processing: 'brand',
  in_review: 'brand',
  qa: 'brand',
  changes_requested: 'amber',
  approved: 'green',
  delivered: 'green',
  closed: 'neutral',
  on_hold: 'amber',
  cancelled: 'neutral',
} as const satisfies Record<CaseStatus, string>;

export function CaseStatusBadge({ status }: { status: CaseStatus }) {
  return <Badge tone={CASE_TONE[status]}>{CASE_STATUS_LABEL[status]}</Badge>;
}

export const CASE_TYPE_LABEL: Record<CaseType, string> = {
  personal_injury: 'Personal injury',
  med_mal: 'Medical malpractice',
  workers_comp: "Workers' comp",
  other: 'Other',
};

export const PRIORITY_LABEL: Record<Priority, string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent',
};

export const DELIVERABLE_LABEL: Record<string, string> = {
  index: 'Medical index',
  chronology: 'Chronology',
  summary: 'Summary',
  report: 'Report',
};

const SCAN = {
  uploading: ['Uploading', 'neutral'],
  pending: ['Scanning', 'brand'],
  clean: ['Ready', 'green'],
  infected: ['Quarantined', 'red'],
  error: ['Scan failed', 'red'],
  purged: ['Deleted by retention', 'neutral'],
} as const satisfies Record<ScanStatus | 'uploading' | 'purged', readonly [string, string]>;

export function DocumentStateBadge({ state }: { state: ScanStatus | 'uploading' | 'purged' }) {
  const [label, tone] = SCAN[state];
  return <Badge tone={tone}>{label}</Badge>;
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
