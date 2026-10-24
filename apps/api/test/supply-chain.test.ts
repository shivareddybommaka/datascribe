import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const workflows = readdirSync(path.join(root, '.github/workflows'))
  .filter((f) => /\.ya?ml$/.test(f))
  .map((f) => `.github/workflows/${f}`);

/** Image references in compose `image:` lines and in `docker run` commands of the workflows. */
const imageRefs = (text: string) => [
  ...[...text.matchAll(/^\s*image:\s*(\S+)/gm)].map((m) => m[1]!),
  ...[...text.matchAll(/(?:^|\s)([\w.-]+\/[\w.-]+:[\w.-]+(?:@sha256:\w+)?)(?=\s|$)/gm)].map(
    (m) => m[1]!,
  ),
];

describe('supply chain pinning (audit L12)', () => {
  it('every container image is pinned by digest', () => {
    const refs = ['docker-compose.yml', ...workflows].flatMap((f) => imageRefs(read(f)));
    expect(refs.length).toBeGreaterThanOrEqual(6);
    for (const ref of refs) expect(ref, ref).toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  it('every GitHub Action is pinned to a full commit SHA', () => {
    const uses = workflows.flatMap((f) =>
      [...read(f).matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((m) => m[1]!),
    );
    expect(uses.length).toBeGreaterThan(0);
    for (const ref of uses.filter((u) => !u.startsWith('./')))
      expect(ref, ref).toMatch(/@[0-9a-f]{40}$/);
  });
});
