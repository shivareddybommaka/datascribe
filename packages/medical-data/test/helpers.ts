import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FetchLike } from '../src';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

export interface Fixture {
  recordedAt: string;
  request: { url: string };
  response: { status: number; body: unknown };
}

export const fixtures: Record<string, Fixture> = Object.fromEntries(
  readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => [
      f.replace(/\.json$/, ''),
      JSON.parse(readFileSync(join(dir, f), 'utf8')) as Fixture,
    ]),
);

/**
 * Replays recorded responses by exact URL. Any other request throws, so a test can never reach
 * a live API by accident, and a change in how an adapter builds its URL fails loudly.
 */
export function replayFetch(): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const f: FetchLike = async (url) => {
    calls.push(url);
    const fx = Object.values(fixtures).find((x) => x.request.url === url);
    if (!fx)
      throw new Error(`No recorded fixture for request (live calls are not allowed in tests)`);
    return new Response(JSON.stringify(fx.response.body), {
      status: fx.response.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return Object.assign(f, { calls });
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Manual clock: `sleep` advances time instead of waiting. */
export function fakeClock(start = 1_700_000_000_000) {
  let t = start;
  const sleeps: number[] = [];
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}

export const silentLogger = () => {
  const lines: { level: string; obj: Record<string, unknown>; msg?: string }[] = [];
  return {
    lines,
    info: (obj: Record<string, unknown>, msg?: string) => lines.push({ level: 'info', obj, msg }),
    warn: (obj: Record<string, unknown>, msg?: string) => lines.push({ level: 'warn', obj, msg }),
  };
};
