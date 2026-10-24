/** Reads uploaded documents for the pipeline. Same S3 settings as the API (`S3_*` in .env). */
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';

export function s3ObjectReader(
  env: Record<string, string | undefined>,
): (key: string) => Promise<Uint8Array> {
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
  return async (key) => {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!res.Body) throw new Error('Empty S3 object body');
    return res.Body.transformToByteArray();
  };
}
