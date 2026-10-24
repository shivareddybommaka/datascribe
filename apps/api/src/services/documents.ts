import { randomUUID } from 'node:crypto';

/** S3 allows at most 10,000 parts per upload. */
const MAX_PARTS = 10_000;

export function partSizeFor(sizeBytes: number, minPartBytes: number): number {
  let part = minPartBytes;
  while (Math.ceil(sizeBytes / part) > MAX_PARTS) part *= 2;
  return part;
}

export const partCountFor = (sizeBytes: number, partSize: number) =>
  Math.max(1, Math.ceil(sizeBytes / partSize));

/** Object keys hold ids only: file names can contain patient names (PHI). */
export const documentKey = (organizationId: string, caseId: string) =>
  `org/${organizationId}/cases/${caseId}/${randomUUID()}`;
