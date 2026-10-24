import type { Readable } from 'node:stream';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutBucketCorsCommand,
  PutBucketEncryptionCommand,
  PutPublicAccessBlockCommand,
  S3Client,
  UploadPartCommand,
  type ServerSideEncryption,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Env } from '../config/env';
import { RELAY_PATH, sealRelayToken, type RelayToken } from './relay-token';

export interface UploadedPart {
  partNumber: number;
  etag: string;
  size: number;
}

/**
 * Where uploaded medical records live (§2, §10): private buckets, server-side encryption and
 * short-lived signed URLs. Browsers upload parts straight to S3 with presigned URLs; the API never
 * proxies file bytes except to verify them (hash, magic bytes, virus scan).
 */
export interface DocumentStorage {
  readonly bucket: string;
  /** Create missing buckets, block public access, set CORS (browser part uploads) and SSE. */
  ensureBuckets(): Promise<void>;
  createMultipart(key: string, contentType: string): Promise<string>;
  presignPart(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresIn: number,
  ): Promise<string>;
  /** Stream one part to S3 (staging's relay, D-122); returns its ETag. */
  uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: Readable,
    length: number,
  ): Promise<string>;
  /** Parts S3 has received so far (resumable uploads), in part order. */
  listParts(key: string, uploadId: string): Promise<UploadedPart[]>;
  completeMultipart(key: string, uploadId: string, parts: UploadedPart[]): Promise<void>;
  abortMultipart(key: string, uploadId: string): Promise<void>;
  head(key: string): Promise<{ size: number } | null>;
  /** Inclusive byte range, for magic-byte sniffing. */
  getRange(key: string, start: number, end: number): Promise<Uint8Array>;
  stream(key: string): Promise<Readable>;
  /** Server-side move (quarantine). */
  move(from: string, to: string): Promise<void>;
  delete(key: string): Promise<void>;
  presignDownload(
    key: string,
    opts: { fileName: string; contentType: string; expiresIn: number },
  ): Promise<string>;
}

/** RFC 6266 attachment header that survives non-ASCII names without trusting them. */
export function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export const isMissing = (err: unknown) => {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e.name === 'NotFound' || e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404;
};

/**
 * The worker stores the staff viewer's page images next to the document's object (D-085); same
 * rule as `pageImageKey` in apps/worker/src/pipeline/s3.ts.
 */
export const pageImageKey = (s3Key: string, pageNumber: number, thumb = false) =>
  `${s3Key}.pages/${pageNumber}${thumb ? '.thumb' : ''}.jpg`;

export class S3DocumentStorage implements DocumentStorage {
  private readonly s3: S3Client;
  readonly bucket: string;
  private readonly buckets: string[];
  private readonly sse: { ServerSideEncryption?: ServerSideEncryption; SSEKMSKeyId?: string };

  constructor(
    env: Pick<
      Env,
      | 'S3_ENDPOINT'
      | 'S3_REGION'
      | 'S3_BUCKET_DOCUMENTS'
      | 'S3_BUCKET_DELIVERABLES'
      | 'S3_ACCESS_KEY_ID'
      | 'S3_SECRET_ACCESS_KEY'
      | 'S3_SSE'
      | 'S3_SSE_KMS_KEY_ID'
    >,
    private readonly corsOrigins: string[],
    /** staging's relay (D-122): hand out same-origin relay URLs sealed with this key */
    private readonly relay?: { key: Buffer },
  ) {
    this.s3 = new S3Client({
      region: env.S3_REGION,
      ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT, forcePathStyle: true } : {}),
      ...(env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
        ? {
            credentials: {
              accessKeyId: env.S3_ACCESS_KEY_ID,
              secretAccessKey: env.S3_SECRET_ACCESS_KEY,
            },
          }
        : {}),
      // Presigned part URLs must not carry SDK checksum parameters the browser can't satisfy.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
    this.bucket = env.S3_BUCKET_DOCUMENTS;
    this.buckets = [env.S3_BUCKET_DOCUMENTS, env.S3_BUCKET_DELIVERABLES];
    this.sse =
      env.S3_SSE === 'none'
        ? {}
        : {
            ServerSideEncryption: env.S3_SSE,
            ...(env.S3_SSE === 'aws:kms' && env.S3_SSE_KMS_KEY_ID
              ? { SSEKMSKeyId: env.S3_SSE_KMS_KEY_ID }
              : {}),
          };
  }

  async ensureBuckets() {
    for (const Bucket of this.buckets) {
      try {
        await this.s3.send(new HeadBucketCommand({ Bucket }));
      } catch (err) {
        if (!isMissing(err)) throw err;
        await this.s3.send(new CreateBucketCommand({ Bucket }));
      }
      // AWS only: SeaweedFS buckets are private by default and don't implement this call.
      await this.s3
        .send(
          new PutPublicAccessBlockCommand({
            Bucket,
            PublicAccessBlockConfiguration: {
              BlockPublicAcls: true,
              IgnorePublicAcls: true,
              BlockPublicPolicy: true,
              RestrictPublicBuckets: true,
            },
          }),
        )
        .catch(() => undefined);
      if (this.sse.ServerSideEncryption) {
        await this.s3.send(
          new PutBucketEncryptionCommand({
            Bucket,
            ServerSideEncryptionConfiguration: {
              Rules: [
                {
                  ApplyServerSideEncryptionByDefault: {
                    SSEAlgorithm: this.sse.ServerSideEncryption,
                    KMSMasterKeyID: this.sse.SSEKMSKeyId,
                  },
                },
              ],
            },
          }),
        );
      }
    }
    // Browsers PUT parts directly to the documents bucket; nothing else is allowed cross-origin.
    await this.s3.send(
      new PutBucketCorsCommand({
        Bucket: this.bucket,
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedOrigins: this.corsOrigins,
              AllowedMethods: ['PUT'],
              AllowedHeaders: ['content-type'],
              ExposeHeaders: ['ETag'],
              MaxAgeSeconds: 3000,
            },
          ],
        },
      }),
    );
  }

  async createMultipart(key: string, contentType: string) {
    const res = await this.s3.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
        ...this.sse,
      }),
    );
    if (!res.UploadId) throw new Error('S3 returned no UploadId');
    return res.UploadId;
  }

  private relayUrl(token: RelayToken) {
    return `${RELAY_PATH}/${sealRelayToken(token, this.relay!.key)}`;
  }

  async presignPart(key: string, uploadId: string, partNumber: number, expiresIn: number) {
    if (this.relay) {
      const e = Date.now() + expiresIn * 1000;
      return this.relayUrl({ op: 'put', k: key, u: uploadId, p: partNumber, e });
    }
    return getSignedUrl(
      this.s3,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn },
    );
  }

  async uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: Readable,
    length: number,
  ) {
    const res = await this.s3.send(
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
        Body: body,
        ContentLength: length,
      }),
    );
    if (!res.ETag) throw new Error('S3 returned no ETag');
    return res.ETag;
  }

  async listParts(key: string, uploadId: string) {
    const parts: UploadedPart[] = [];
    let marker: string | undefined;
    for (;;) {
      const res = await this.s3.send(
        new ListPartsCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          PartNumberMarker: marker,
        }),
      );
      for (const p of res.Parts ?? []) {
        if (p.PartNumber && p.ETag) {
          parts.push({ partNumber: p.PartNumber, etag: p.ETag, size: p.Size ?? 0 });
        }
      }
      if (!res.IsTruncated || !res.NextPartNumberMarker) break;
      marker = res.NextPartNumberMarker;
    }
    return parts.sort((a, b) => a.partNumber - b.partNumber);
  }

  async completeMultipart(key: string, uploadId: string, parts: UploadedPart[]) {
    await this.s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
        },
      }),
    );
  }

  async abortMultipart(key: string, uploadId: string) {
    await this.s3
      .send(new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId }))
      .catch((err) => {
        if (!isMissing(err) && (err as { name?: string }).name !== 'NoSuchUpload') throw err;
      });
  }

  async head(key: string) {
    try {
      const res = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: res.ContentLength ?? 0 };
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
  }

  async getRange(key: string, start: number, end: number) {
    const res = await this.s3.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: `bytes=${start}-${end}` }),
    );
    return res.Body ? res.Body.transformToByteArray() : new Uint8Array();
  }

  async stream(key: string) {
    const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!res.Body) throw new Error('S3 returned no body');
    return res.Body as Readable;
  }

  async move(from: string, to: string) {
    await this.s3.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        Key: to,
        CopySource: `${this.bucket}/${from}`,
        ...this.sse,
      }),
    );
    await this.delete(from);
  }

  async delete(key: string) {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async presignDownload(
    key: string,
    opts: { fileName: string; contentType: string; expiresIn: number },
  ) {
    if (this.relay) {
      const e = Date.now() + opts.expiresIn * 1000;
      return this.relayUrl({ op: 'get', k: key, n: opts.fileName, t: opts.contentType, e });
    }
    return getSignedUrl(
      this.s3,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: contentDisposition(opts.fileName),
        ResponseContentType: opts.contentType,
        ResponseCacheControl: 'private, no-store',
      }),
      { expiresIn: opts.expiresIn },
    );
  }
}
