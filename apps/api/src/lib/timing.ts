import { timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';

/** Constant-time string compare (audit L9). Different lengths are unequal, still in constant time. */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length ? timingSafeEqual(x, y) : !timingSafeEqual(x, x);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Hold the response (success or error) until at least `floorMs` after the request started (audit
 * L9). Login, register and forgot do more work for existing accounts (attempt bookkeeping, a
 * token, an email), and the floor hides that difference. The body is held, not sent and delayed.
 */
export function withTimingFloor(
  floorMs: number,
  handler: (req: Request, res: Response) => Promise<void>,
): RequestHandler {
  if (floorMs <= 0) return handler;
  return async (req, res) => {
    const deadline = Date.now() + floorMs;
    const wait = () => sleep(Math.max(0, deadline - Date.now()));
    const send = res.json.bind(res);
    let held: { body: unknown } | undefined;
    res.json = (body: unknown) => {
      held = { body };
      return res;
    };
    try {
      await handler(req, res);
    } catch (err) {
      await wait();
      res.json = send;
      throw err;
    }
    await wait();
    res.json = send;
    if (held) send(held.body);
  };
}
