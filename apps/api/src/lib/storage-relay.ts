import { Router } from 'express';
import type { Deps } from '../context';
import { HttpError, notFound } from './errors';
import { openRelayToken, relayKey } from './relay-token';
import { contentDisposition } from './storage';

/**
 * Staging's storage relay (D-122). Browsers normally PUT upload parts and GET downloads straight
 * from S3 with presigned URLs. On the Mac the S3 is SeaweedFS on localhost:9000, which a browser
 * reaching staging through the Cloudflare tunnel can't see, so with `S3_BROWSER_ACCESS=relay` the
 * "presigned" URL is a same-origin `/api/v1/storage-relay/<token>` and the API streams the bytes.
 * Refused in production, which hands out real presigned S3 URLs.
 *
 * Mounted before the JSON body parser: part bodies are streamed to S3, never buffered.
 */

const MAX_PART_BYTES = 512 * 1024 * 1024;

export function storageRelayRouter(deps: Pick<Deps, 'storage' | 'env'>): Router {
  const key = relayKey(deps.env.JWT_ACCESS_SECRET);
  const r = Router();
  const open = (value: unknown) => {
    const token = typeof value === 'string' ? openRelayToken(value, key) : null;
    // like S3 for a bad or expired signature: nothing about why
    if (!token) throw new HttpError(403, 'relay_denied', 'This link is invalid or has expired');
    return token;
  };

  r.put('/:token', async (req, res) => {
    const token = open(req.params.token);
    if (token.op !== 'put') throw notFound();
    const length = Number(req.get('content-length'));
    if (!Number.isInteger(length) || length < 1 || length > MAX_PART_BYTES) {
      throw new HttpError(411, 'length_required', 'Send the part with its Content-Length');
    }
    const etag = await deps.storage.uploadPart(token.k, token.u, token.p, req, length);
    res.setHeader('ETag', etag);
    res.status(200).end();
  });

  r.get('/:token', async (req, res) => {
    const token = open(req.params.token);
    if (token.op !== 'get') throw notFound();
    const body = await deps.storage.stream(token.k);
    res.setHeader('Content-Type', token.t);
    res.setHeader('Content-Disposition', contentDisposition(token.n));
    res.setHeader('Cache-Control', 'private, no-store');
    body.on('error', (err) => res.destroy(err));
    body.pipe(res);
  });

  return r;
}
