import { existsSync } from 'node:fs';
import path from 'node:path';

/** Nearest ancestor of `from` holding pnpm-workspace.yaml (the repo root), else `from`. */
export function repoRoot(from = process.cwd()): string {
  let dir = path.resolve(from);
  for (;;) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(from);
    dir = parent;
  }
}

/** Absolute paths pass through; relative ones resolve from the repo root (same for api and worker). */
export const repoPath = (p: string) => (path.isAbsolute(p) ? p : path.join(repoRoot(), p));
