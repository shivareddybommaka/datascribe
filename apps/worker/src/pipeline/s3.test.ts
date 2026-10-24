// Real S3 (local SeaweedFS, like the API tests): retention removes a document's page images too (D-085).
import {
  CreateBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { pageImageKey, pageImagePrefix, s3DocumentObjects } from './s3';

// one bucket per checkout, so parallel worktrees don't share objects
const checkout = path.basename(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..'),
);
const env = {
  S3_ENDPOINT: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
  S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID ?? 'datascribe',
  S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY ?? 'datascribe-dev-secret',
  S3_BUCKET_DOCUMENTS: `ds-${checkout.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-worker-test`,
  S3_SSE: 'none',
};
const s3 = new S3Client({
  region: 'us-east-1',
  endpoint: env.S3_ENDPOINT,
  forcePathStyle: true,
  credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
});
const objects = s3DocumentObjects(env);
const exists = (key: string) =>
  s3
    .send(new HeadObjectCommand({ Bucket: env.S3_BUCKET_DOCUMENTS, Key: key }))
    .then(() => true)
    .catch(() => false);

beforeAll(async () => {
  try {
    await s3.send(new CreateBucketCommand({ Bucket: env.S3_BUCKET_DOCUMENTS }));
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') throw err;
  }
});

describe('s3DocumentObjects page images', () => {
  it('stores page images next to the object and remove() deletes them with it', async () => {
    const key = `test/${Date.now().toString(36)}/synthetic.pdf`;
    const other = `${key}x`; // a key sharing the prefix text must survive
    await objects.putJpeg(key, Buffer.from('%PDF synthetic'));
    await objects.putJpeg(other, Buffer.from('%PDF other'));
    for (let n = 1; n <= 3; n++) {
      await objects.putJpeg(pageImageKey(key, n), Buffer.from(`page ${n}`));
      await objects.putJpeg(pageImageKey(key, n, true), Buffer.from(`thumb ${n}`));
    }
    expect(pageImageKey(key, 2, true)).toBe(`${key}.pages/2.thumb.jpg`);

    await objects.remove({ s3Key: key, uploadId: null });

    expect(await exists(key)).toBe(false);
    const left = await s3.send(
      new ListObjectsV2Command({ Bucket: env.S3_BUCKET_DOCUMENTS, Prefix: pageImagePrefix(key) }),
    );
    expect(left.KeyCount ?? 0).toBe(0);
    expect(await exists(other)).toBe(true);
    await objects.remove({ s3Key: other, uploadId: null });
  });
});
