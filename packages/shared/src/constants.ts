export const CASE_STATUSES = [
  'draft',
  'submitted',
  'processing',
  'in_review',
  'qa',
  'changes_requested',
  'approved',
  'delivered',
  'closed',
  'on_hold',
  'cancelled',
] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

export const CASE_TYPES = ['personal_injury', 'med_mal', 'workers_comp', 'other'] as const;
export type CaseType = (typeof CASE_TYPES)[number];

export const DELIVERABLE_TYPES = ['index', 'chronology', 'summary', 'report'] as const;
export type DeliverableType = (typeof DELIVERABLE_TYPES)[number];

export const LEAD_STAGES = ['new', 'contacted', 'qualified', 'proposal', 'won', 'lost'] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];

export const ACTIVITY_TYPES = ['call', 'email', 'meeting', 'note', 'task'] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type Priority = (typeof PRIORITIES)[number];
