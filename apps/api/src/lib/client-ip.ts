import { isIP } from 'node:net';
import type { RequestHandler } from 'express';

type TrustFn = (addr: string, hop: number) => boolean;

/**
 * Staging behind a Cloudflare tunnel (D-121): take the client IP from `CF-Connecting-IP`, which
 * Cloudflare's edge always overwrites, instead of the last X-Forwarded-For entry. Only when the
 * hop that sent the request is one `TRUST_PROXY` trusts (the local Next.js proxy, which got it
 * from cloudflared on 127.0.0.1); from anyone else the header is ignored, so it can't be used to
 * pick an IP. With `TRUST_PROXY=false` it is never used.
 */
export function cfConnectingIp(): RequestHandler {
  return (req, _res, next) => {
    const header = req.get('cf-connecting-ip')?.trim();
    const peer = req.socket.remoteAddress;
    const trusted = req.app.get('trust proxy fn') as TrustFn | undefined;
    if (header && isIP(header) && peer && trusted?.(peer, 0)) {
      Object.defineProperty(req, 'ip', { value: header, configurable: true, enumerable: true });
    }
    next();
  };
}
