/** Uploaded documents for the pipeline. Same S3 settings as the API (`S3_*` in .env). */
import {
  AbortMultipartUploadCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  S3Client,
  type ServerSideEncryption,
} from '@aws-sdk/client-s3';
import type { ScanStorage } from '@datascribe/scan';
import type { Readable } from 'node:stream';

export interface DocumentObjects extends ScanStorage {
  read(key: string): Promise<Uint8Array>;
  /** Retention (D-128): delete the object, or abort an unfinished upload. Missing keys are fine. */
  remove(doc: { s3Key: string; uploadId: string | null }): Promise<void>;
}

export function s3DocumentObjects(env: Record<string, string | undefined>): DocumentObjects {
  const s3 = new S3Client({
    region: env.S3_REGION || 'ap-south-1',
    ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT, forcePathStyle: true } : {}),
    ...(env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
      ? {
          credentials: {
            accessKeyId: env.S3_ACCESS_KEY_ID,
            secretAccessKey: env.S3_SECRET_ACCESS_KEY,
          },
        }
      : {}),
  });
  const bucket = env.S3_BUCKET_DOCUMENTS || 'ds-documents';
  // Quarantine copies keep the bucket's encryption, as the API's uploads do (D-014).
  const sseMode = env.S3_SSE || 'AES256';
  const sse =
    sseMode === 'none'
      ? {}
      : {
          ServerSideEncryption: sseMode as ServerSideEncryption,
          ...(sseMode === 'aws:kms' && env.S3_SSE_KMS_KEY_ID
            ? { SSEKMSKeyId: env.S3_SSE_KMS_KEY_ID }
            : {}),
        };
  const get = async (key: string) => {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!res.Body) throw new Error('Empty S3 object body');
    return res.Body;
  };
  return {
    async read(key) {
      return (await get(key)).transformToByteArray();
    },
    async stream(key) {
      return (await get(key)) as Readable;
    },
    async move(from, to) {
      await s3.send(
        new CopyObjectCommand({ Bucket: bucket, Key: to, CopySource: `${bucket}/${from}`, ...sse }),
      );
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: from }));
    },
    async remove({ s3Key, uploadId }) {
      if (uploadId) {
        try {
          await s3.send(
            new AbortMultipartUploadCommand({ Bucket: bucket, Key: s3Key, UploadId: uploadId }),
          );
        } catch (err) {
          // already completed or aborted: fall through to deleting the object
          if ((err as { name?: string }).name !== 'NoSuchUpload') throw err;
        }
      }
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: s3Key }));
    },
  };
}
