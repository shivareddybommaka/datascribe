/** Processing pipeline stages (REQUIREMENTS.md §7), in order. Each stage is its own queue. */
export const PIPELINE_QUEUES = [
  'scan',
  'extract',
  'classify',
  'extract-events',
  'code',
  'build-deliverables',
  'ready-for-review',
] as const;
export type PipelineQueue = (typeof PIPELINE_QUEUES)[number];

export const OTHER_QUEUES = ['email', 'billing'] as const;

/** §7: 3 attempts with exponential backoff. */
export const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5_000 },
  removeOnComplete: 1_000,
  removeOnFail: 5_000,
};

export function nextStage(stage: PipelineQueue): PipelineQueue | null {
  const i = PIPELINE_QUEUES.indexOf(stage);
  return PIPELINE_QUEUES[i + 1] ?? null;
}
