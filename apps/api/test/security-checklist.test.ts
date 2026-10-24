import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

/** The `- Topic: …` bullets of REQUIREMENTS.md §10. */
function section10Topics(): string[] {
  const spec = read('REQUIREMENTS.md');
  const start = spec.indexOf('## 10.');
  const body = spec.slice(start, spec.indexOf('\n## ', start + 1));
  return [...body.matchAll(/^- ([A-Za-z]+):/gm)].map((m) => m[1]!);
}

describe('docs/SECURITY-CHECKLIST.md covers REQUIREMENTS.md §10', () => {
  const checklist = read('docs/SECURITY-CHECKLIST.md');

  it('has a section for every §10 topic', () => {
    const topics = section10Topics();
    expect(topics.length).toBeGreaterThanOrEqual(7);
    for (const topic of topics) expect(checklist).toContain(`\n## ${topic}\n`);
  });

  it('points only at files that exist', () => {
    const paths = [...checklist.matchAll(/`((?:apps|packages|docs)\/[\w./@-]+\.(?:ts|md|sql))`/g)];
    expect(paths.length).toBeGreaterThan(10);
    for (const [, file] of paths) expect(() => read(file!), file).not.toThrow();
  });
});
