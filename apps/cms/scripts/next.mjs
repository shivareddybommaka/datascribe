// Runs `next <command>` with the monorepo root .env loaded and CMS_PORT (default 3001) as the port,
// so each checkout/worktree can run its own CMS without editing package.json.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import process from 'node:process';

const rootEnv = path.resolve(process.cwd(), '../../.env');
if (fs.existsSync(rootEnv)) process.loadEnvFile(rootEnv);
process.env.PORT = process.env.CMS_PORT || process.env.PORT || '3001';

const nextBin = createRequire(import.meta.url).resolve('next/dist/bin/next');
const child = spawn(process.execPath, [nextBin, ...process.argv.slice(2)], { stdio: 'inherit' });
child.on('exit', (code, signal) =>
  signal ? process.kill(process.pid, signal) : process.exit(code),
);
