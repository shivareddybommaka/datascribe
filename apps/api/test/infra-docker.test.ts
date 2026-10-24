import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Text checks of the container images (D-116): no Docker daemon needed. They pin what ECS relies
// on (ports, commands, health probe) to infra/terraform, and keep secrets and root out of images.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
// Dockerfile instructions, with `\` continuations joined and comments dropped.
const instructions = (text: string) =>
  text
    .replace(/\\\n/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

type Stage = { name: string; lines: string[] };
function stages(file: string): Stage[] {
  const out: Stage[] = [];
  for (const line of instructions(read(file))) {
    const from = /^FROM\s+\S+(?:\s+AS\s+(\S+))?/i.exec(line);
    if (from) out.push({ name: from[1] ?? '', lines: [line] });
    else out.at(-1)?.lines.push(line);
  }
  return out;
}
const stage = (file: string, name: string) => stages(file).find((s) => s.name === name)!;
const final = (file: string) => stages(file).at(-1)!;
const cmd = (s: Stage) => {
  const line = s.lines.filter((l) => /^CMD\s/.test(l)).at(-1);
  return line ? (JSON.parse(line.replace(/^CMD\s+/, '')) as string[]) : undefined;
};
const tf = (file: string) => read(`infra/terraform/${file}`);
const tfLocal = (name: string) =>
  Number(new RegExp(`^\\s*${name}\\s*=\\s*(\\d+)`, 'm').exec(tf('main.tf'))![1]);

const apps = ['api', 'web', 'worker'] as const;
const dockerfile = (app: string) => `apps/${app}/Dockerfile`;

describe('container images (D-116)', () => {
  it('each service has a multi-stage Dockerfile on a digest-pinned Node 22 base', () => {
    for (const app of apps) {
      const text = read(dockerfile(app));
      expect(text, app).toMatch(/^ARG NODE_IMAGE=node:22[\w.-]*@sha256:[0-9a-f]{64}$/m);
      for (const s of stages(dockerfile(app)))
        expect(s.lines[0], `${app}/${s.name}`).toMatch(/^FROM (\$\{NODE_IMAGE\}|base|pnpm)(\s|$)/);
      expect(stages(dockerfile(app)).length, app).toBeGreaterThanOrEqual(3);
      expect(final(dockerfile(app)).name, app).toBe('runtime');
    }
  });

  it('final stages run as the unprivileged node user and carry no source or dev tooling', () => {
    for (const app of apps) {
      const s = final(dockerfile(app));
      const users = s.lines.filter((l) => /^USER\s/.test(l));
      expect(users, app).toEqual(['USER node']);
      // USER comes before CMD, and nothing after it switches back
      expect(s.lines.findIndex((l) => l === 'USER node')).toBeLessThan(
        s.lines.findIndex((l) => /^CMD\s/.test(l)),
      );
      expect(s.lines.join('\n'), app).not.toMatch(/^COPY \.\s/m); // no whole-repo copy
      expect(s.lines.join('\n'), app).not.toMatch(/pnpm|tsx|npm install/);
      expect(s.lines.join('\n'), app).toMatch(/NODE_ENV=production/);
    }
    // api and worker: node_modules only from a production-only `pnpm deploy`
    for (const app of ['api', 'worker']) {
      const build = stage(dockerfile(app), 'build').lines.join('\n');
      expect(build, app).toMatch(/pnpm install --frozen-lockfile/);
      expect(build, app).toMatch(
        new RegExp(`pnpm --filter @datascribe/${app} deploy --prod .* /out$`, 'm'),
      );
      const copies = final(dockerfile(app)).lines.filter((l) => /node_modules/.test(l));
      expect(copies, app).toEqual(['COPY --from=build /out/node_modules ./node_modules']);
    }
    const migrate = stage(dockerfile('api'), 'migrate');
    expect(migrate.lines.filter((l) => /^USER\s/.test(l))).toEqual(['USER node']);
  });

  it('bakes no secrets: no secret-like ENV/ARG, no credentials, .env kept out of the context', () => {
    for (const app of apps) {
      const lines = instructions(read(dockerfile(app)));
      const names = lines
        .filter((l) => /^(ENV|ARG)\s/.test(l))
        .flatMap((l) => [...l.replace(/^(ENV|ARG)\s+/, '').matchAll(/(\w+)=/g)].map((m) => m[1]!));
      expect(names.length, app).toBeGreaterThan(0);
      for (const n of names)
        expect(n, `${app}: ${n}`).not.toMatch(
          /SECRET|PASSWORD|TOKEN|KEY|DATABASE_URL|REDIS_URL|STRIPE/i,
        );
      const text = read(dockerfile(app));
      expect(text, app).not.toMatch(
        /postgres(ql)?:\/\/|rediss?:\/\/|AKIA[0-9A-Z]{16}|sk_(live|test)_/,
      );
      // no .env file copied in or loaded at start
      expect(text, app).not.toMatch(/^(COPY|ADD)\b.*\.env\b|--env-file/m);
    }
    const ignore = read('.dockerignore').split('\n');
    for (const p of [
      '**/.env',
      '**/.env.*',
      '.worktrees',
      '.git',
      '**/node_modules',
      '**/test-results',
      '**/coverage',
      '**/*.tfstate',
      '**/*.tfvars',
      'infra/terraform/.terraform',
    ])
      expect(ignore, p).toContain(p);
  });

  it('never uses port 3000 or 5432 (CLAUDE.md)', () => {
    for (const app of apps) {
      const text = read(dockerfile(app));
      expect(text, app).not.toMatch(/\b(3000|5432)\b/);
    }
  });

  it('ports, commands and the health probe match the ECS task definitions', () => {
    const ecs = tf('ecs.tf');
    const vars = tf('variables.tf');
    const expose = (app: string) =>
      final(dockerfile(app))
        .lines.filter((l) => /^EXPOSE\s/.test(l))
        .map((l) => Number(l.split(/\s+/)[1]));

    // api: :4000, node dist/server.js, /api/v1/health like the ALB target group
    const api = final(dockerfile('api'));
    expect(expose('api')).toEqual([tfLocal('api_port')]);
    expect(api.lines.join('\n')).toMatch(new RegExp(`API_PORT=${tfLocal('api_port')}\\b`));
    expect(cmd(api)).toEqual(['node', 'dist/server.js']);
    expect(read('apps/api/tsup.config.ts')).toMatch(/nodeService\('src\/server\.ts'\)/);
    const health = api.lines.find((l) => /^HEALTHCHECK\s/.test(l))!;
    expect(health).toMatch(/\/api\/v1\/health/);
    expect(tf('alb.tf')).toMatch(/path\s*=\s*"\/api\/v1\/health"/);
    expect(read('apps/api/src/routes/health.ts')).toMatch(/get\('\/health'/);
    expect(ecs).toMatch(
      /healthCheck = \{\s*command\s*=\s*\["CMD", "node", "-e", "[^"]*\/api\/v1\/health/,
    );

    // web: :3010 through PORT, standalone server
    const web = final(dockerfile('web'));
    expect(expose('web')).toEqual([tfLocal('web_port')]);
    expect(web.lines.join('\n')).toMatch(new RegExp(`PORT=${tfLocal('web_port')}\\b`));
    expect(cmd(web)).toEqual(['node', 'apps/web/server.js']);
    expect(read('apps/web/next.config.ts')).toMatch(/output: 'standalone'/);

    // worker: no port, node dist/index.js
    const worker = final(dockerfile('worker'));
    expect(expose('worker')).toEqual([]);
    expect(worker.lines.some((l) => /^HEALTHCHECK\s/.test(l))).toBe(false);
    expect(cmd(worker)).toEqual(['node', 'dist/index.js']);
    expect(read('apps/worker/tsup.config.ts')).toMatch(/nodeService\('src\/index\.ts'\)/);

    // none of the service task definitions overrides the image command
    for (const family of apps) {
      const def = ecs.slice(ecs.indexOf(`resource "aws_ecs_task_definition" "${family}"`));
      const body = def.slice(0, def.indexOf('\nresource ', 1));
      expect(body, family).not.toMatch(/\bcommand\s*=\s*var\./);
      expect(body, family).toMatch(new RegExp(`image\\s*=\\s*var\\.image_${family}\\b`));
    }

    // migrate: its own image whose CMD is the task's default command
    expect(ecs).toMatch(/image\s*=\s*var\.image_migrate/);
    expect(tf('ecr.tf')).toMatch(/"migrate"/);
    const migrateDefault = /variable "migrate_command" \{[\s\S]*?default\s*=\s*(\[[^\]]*\])/.exec(
      vars,
    )![1]!;
    expect(cmd(stage(dockerfile('api'), 'migrate'))).toEqual(JSON.parse(migrateDefault));
    expect(existsSync(path.join(root, 'packages/db/prisma/migrations'))).toBe(true);
  });
});
