import type { Express } from 'express';
import request from 'supertest';
import { expect } from 'vitest';
import { bearer } from './helpers';

export interface UploadState {
  id: string;
  partSize: number;
  partCount: number;
  uploadedParts: number[];
  completed: boolean;
  scanStatus: string;
  state: string;
  sha256: string | null;
  pageCount: number | null;
  mimeType: string;
}

/** Start a multipart upload for `bytes` on a case. */
export async function startUpload(
  app: Express,
  token: string,
  caseId: string,
  bytes: Uint8Array,
  opts: { fileName?: string; mimeType?: string; sizeBytes?: number } = {},
) {
  const res = await request(app)
    .post(`/api/v1/cases/${caseId}/uploads`)
    .set(bearer(token))
    .send({
      fileName: opts.fileName ?? 'records.pdf',
      mimeType: opts.mimeType ?? 'application/pdf',
      sizeBytes: opts.sizeBytes ?? bytes.length,
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as UploadState;
}

/** PUT the given parts straight to S3 with presigned URLs, as the browser does. */
export async function putParts(
  app: Express,
  token: string,
  upload: UploadState,
  bytes: Uint8Array,
  partNumbers: number[],
) {
  const res = await request(app)
    .post(`/api/v1/uploads/${upload.id}/parts`)
    .set(bearer(token))
    .send({ partNumbers });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  for (const { partNumber, url } of res.body.parts as { partNumber: number; url: string }[]) {
    const start = (partNumber - 1) * upload.partSize;
    const body = bytes.subarray(start, Math.min(start + upload.partSize, bytes.length));
    const put = await fetch(url, { method: 'PUT', body });
    expect(put.status, `part ${partNumber}`).toBe(200);
  }
}

export const allParts = (u: UploadState) => Array.from({ length: u.partCount }, (_, i) => i + 1);

export const complete = (app: Express, token: string, id: string) =>
  request(app).post(`/api/v1/uploads/${id}/complete`).set(bearer(token)).send({});

/** Upload a whole file and complete it; returns the /complete response. */
export async function uploadFile(
  app: Express,
  token: string,
  caseId: string,
  bytes: Uint8Array,
  opts: { fileName?: string; mimeType?: string } = {},
) {
  const upload = await startUpload(app, token, caseId, bytes, opts);
  await putParts(app, token, upload, bytes, allParts(upload));
  return complete(app, token, upload.id);
}
