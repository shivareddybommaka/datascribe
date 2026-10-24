import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Text-level guard for the staging deploy workflow (D-131): it must only ever start by hand, hold
// no secrets, and only touch AWS through the OIDC role of the `staging` environment.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const workflow = readFileSync(path.join(root, '.github/workflows/deploy-staging.yml'), 'utf8');
const lines = workflow.split('\n');

/** Lines of a top-level YAML key's block (until the next top-level key). */
function topLevel(key: string): string[] {
  const start = lines.findIndex((l) => l === `${key}:` || l.startsWith(`${key}: `));
  if (start < 0) throw new Error(`no top-level ${key}`);
  const end = lines.findIndex((l, i) => i > start && /^[a-z]/.test(l));
  return lines.slice(start, end < 0 ? undefined : end).filter((l) => l.trim() !== '');
}

/** `- name / - uses / - run` steps of the file, as text blocks. */
const steps = workflow.split(/\n {6}- /).slice(1);

describe('deploy-staging workflow', () => {
  it('starts only by hand (workflow_dispatch), never on push, PR or a schedule', () => {
    const triggers = topLevel('on')
      .slice(1)
      .filter((l) => /^ {2}[a-z_]+:/.test(l))
      .map((l) => l.trim().replace(/:.*/, ''));
    expect(triggers).toEqual(['workflow_dispatch']);
    for (const t of [
      'push',
      'pull_request',
      'pull_request_target',
      'schedule',
      'workflow_run',
      'workflow_call',
      'repository_dispatch',
    ]) {
      expect(workflow).not.toMatch(new RegExp(`^\\s*${t}:`, 'm'));
    }
  });

  it('applies only when asked, plans otherwise', () => {
    expect(workflow).toMatch(/apply:\n\s+description: .+\n\s+type: boolean\n\s+default: false/);
    const mutating = steps.filter((s) => /terraform apply|aws ecs run-task/.test(s));
    expect(mutating.length).toBe(3);
    for (const s of mutating) expect(s).toMatch(/\n\s+if: inputs\.apply\n/);
  });

  it('uses OIDC through the staging environment, on main only, with no stored secrets', () => {
    expect(topLevel('permissions')).toEqual(['permissions: {}']);
    expect(workflow).not.toMatch(/secrets\./);
    expect(workflow).not.toMatch(/aws-access-key-id|aws-secret-access-key|AWS_SECRET_ACCESS_KEY/);
    const jobs = workflow.split(/\n {2}(?=[a-z]+:\n)/).slice(1);
    expect(jobs.length).toBe(2);
    for (const job of jobs) {
      expect(job).toMatch(/\n {4}if: github\.ref == 'refs\/heads\/main'\n/);
      expect(job).toMatch(/\n {4}environment: staging\n/);
      expect(job).toMatch(/\n {6}id-token: write\n/);
      expect(job).toMatch(/role-to-assume: \$\{\{ vars\.AWS_DEPLOY_ROLE_ARN \}\}/);
    }
    expect(workflow).toMatch(/cancel-in-progress: false/);
  });

  it('pins every action to a commit SHA (audit L12)', () => {
    const uses = [...workflow.matchAll(/uses: (\S+)/g)].map((m) => m[1]!);
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
  });

  it('builds the four ECR images and deploys them by digest', () => {
    for (const name of ['api', 'web', 'worker', 'migrate']) {
      expect(workflow).toMatch(new RegExp(`\\n {10}build ${name} -f `));
      expect(workflow).toContain(`image_${name}`);
    }
    expect(workflow).toContain('datascribe-staging/$name');
    expect(workflow).toContain('^sha256:[0-9a-f]{64}$');
    expect(workflow).not.toMatch(/terraform (plan|apply)[^\n]*-var-file=environments\/production/);
  });
});
