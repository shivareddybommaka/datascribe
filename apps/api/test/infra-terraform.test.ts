import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Terraform isn't installed (system install needs approval, D-115), so this is a text-level check
// of infra/terraform: the §10 settings are present and no secret is written down. `terraform
// validate` / `plan` still have to run before the first apply (docs/INFRA.md).

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const tfDir = path.join(root, 'infra/terraform');
const envDir = path.join(tfDir, 'environments');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

/** HCL without `#` / `//` comments (none of our strings contain those characters). */
const stripComments = (text: string) => text.replace(/(^|\s)(#|\/\/).*$/gm, '$1');

const tfFiles = readdirSync(tfDir).filter((f) => f.endsWith('.tf'));
const tf = Object.fromEntries(tfFiles.map((f) => [f, stripComments(read(`infra/terraform/${f}`))]));
const allTf = Object.values(tf).join('\n');
const examples = readdirSync(envDir)
  .filter((f) => f.endsWith('.example'))
  .map((f) => ({ name: f, text: readFileSync(path.join(envDir, f), 'utf8') }));
const tfvars = examples.filter((e) => e.name.endsWith('.tfvars.example'));

/** The body of the first `<header> {` block, braces matched. */
function block(text: string, header: string): string {
  const start = text.indexOf(header);
  if (start < 0) throw new Error(`block not found: ${header}`);
  const open = text.indexOf('{', start + header.length - 1);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(open + 1, i);
  }
  throw new Error(`unbalanced block: ${header}`);
}
const resource = (type: string, name: string) => block(allTf, `resource "${type}" "${name}" {`);
const setting = (key: string, value: string) =>
  new RegExp(`^\\s*${key}\\s*=\\s*${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm');

describe('infra/terraform (D-115, §10)', () => {
  it('has the expected files, each with balanced braces, and per-environment examples', () => {
    for (const f of [
      'versions.tf',
      'variables.tf',
      'kms.tf',
      'network.tf',
      'rds.tf',
      'redis.tf',
      's3.tf',
      'secrets.tf',
      'ecs.tf',
      'alb.tf',
      'logs.tf',
      'outputs.tf',
    ])
      expect(tfFiles, f).toContain(f);
    for (const [f, text] of Object.entries(tf)) {
      const opens = (text.match(/\{/g) ?? []).length;
      const closes = (text.match(/\}/g) ?? []).length;
      expect(opens, `${f} braces`).toBe(closes);
    }
    expect(tfvars.map((e) => e.name).sort()).toEqual([
      'production.tfvars.example',
      'staging.tfvars.example',
    ]);
    expect(read('infra/terraform/.gitignore')).toMatch(/^environments\/\*\.tfvars$/m);
    expect(read('infra/terraform/.gitignore')).toMatch(/^\*\.tfstate$/m);
  });

  it('keeps state encrypted and pins the account', () => {
    const backend = block(tf['versions.tf']!, 'backend "s3" {');
    expect(backend).toMatch(setting('encrypt', 'true'));
    expect(tf['versions.tf']).toMatch(/allowed_account_ids\s*=\s*\[var\.aws_account_id\]/);
  });

  it('rotates the KMS key and encrypts every log group with it', () => {
    expect(resource('aws_kms_key', 'main')).toMatch(setting('enable_key_rotation', 'true'));
    const logGroups = [...allTf.matchAll(/resource "aws_cloudwatch_log_group" "(\w+)" \{/g)];
    expect(logGroups.length).toBeGreaterThanOrEqual(4);
    for (const [, name] of logGroups)
      expect(resource('aws_cloudwatch_log_group', name!), name).toMatch(
        setting('kms_key_id', 'aws_kms_key.main.arn'),
      );
  });

  it('RDS: KMS-encrypted, private, TLS forced, daily snapshots kept 30+ days', () => {
    const db = resource('aws_db_instance', 'main');
    expect(db).toMatch(setting('storage_encrypted', 'true'));
    expect(db).toMatch(setting('kms_key_id', 'aws_kms_key.main.arn'));
    expect(db).toMatch(setting('publicly_accessible', 'false'));
    expect(db).toMatch(setting('manage_master_user_password', 'true'));
    expect(db).toMatch(setting('skip_final_snapshot', 'false'));
    expect(db).toMatch(setting('backup_retention_period', 'var.db_backup_retention_days'));
    expect(db).not.toMatch(/^\s*password\s*=/m);
    const retention = block(tf['variables.tf']!, 'variable "db_backup_retention_days" {');
    expect(retention).toMatch(setting('default', '30'));
    expect(retention).toMatch(/var\.db_backup_retention_days >= 30/);
    expect(resource('aws_db_parameter_group', 'main')).toMatch(
      /name\s*=\s*"rds\.force_ssl"\s*\n\s*value\s*=\s*"1"/,
    );
    for (const e of tfvars) {
      const days = /^db_backup_retention_days\s*=\s*(\d+)/m.exec(e.text)?.[1];
      if (days) expect(Number(days), e.name).toBeGreaterThanOrEqual(30);
    }
  });

  it('Redis: TLS required in transit, KMS at rest, noeviction for BullMQ', () => {
    const redis = resource('aws_elasticache_replication_group', 'main');
    expect(redis).toMatch(setting('transit_encryption_enabled', 'true'));
    expect(redis).toMatch(setting('transit_encryption_mode', '"required"'));
    expect(redis).toMatch(setting('at_rest_encryption_enabled', 'true'));
    expect(redis).toMatch(setting('kms_key_id', 'aws_kms_key.main.arn'));
    expect(resource('aws_elasticache_parameter_group', 'main')).toMatch(/"noeviction"/);
    expect(tf['ecs.tf']).toMatch(/redis_url\s*=\s*"rediss:\/\//);
  });

  it('S3: SSE-KMS, versioning, public access blocked, TLS only, no ACLs', () => {
    expect(tf['s3.tf']).toMatch(/documents\s*=\s*"\$\{var\.bucket_prefix\}-documents"/);
    expect(tf['s3.tf']).toMatch(/deliverables\s*=\s*"\$\{var\.bucket_prefix\}-deliverables"/);
    const sse = resource('aws_s3_bucket_server_side_encryption_configuration', 'app');
    expect(sse).toMatch(setting('for_each', 'aws_s3_bucket.app'));
    expect(sse).toMatch(setting('sse_algorithm', '"aws:kms"'));
    expect(sse).toMatch(setting('kms_master_key_id', 'aws_kms_key.main.arn'));
    for (const name of ['app', 'alb_logs']) {
      expect(resource('aws_s3_bucket_versioning', name)).toMatch(setting('status', '"Enabled"'));
      const pab = resource('aws_s3_bucket_public_access_block', name);
      for (const key of [
        'block_public_acls',
        'ignore_public_acls',
        'block_public_policy',
        'restrict_public_buckets',
      ])
        expect(pab, `${name} ${key}`).toMatch(setting(key, 'true'));
      expect(resource('aws_s3_bucket_ownership_controls', name)).toMatch(
        setting('object_ownership', '"BucketOwnerEnforced"'),
      );
    }
    expect(block(tf['s3.tf']!, 'data "aws_iam_policy_document" "bucket" {')).toMatch(
      /variable\s*=\s*"aws:SecureTransport"/,
    );
    expect(allTf).not.toMatch(/resource "aws_s3_bucket_acl"/);
    expect(allTf).not.toMatch(/public-read/);
    // the apps encrypt with the same key (S3_SSE, D-070)
    expect(tf['ecs.tf']).toMatch(/S3_SSE\s*=\s*"aws:kms"/);
    expect(tf['ecs.tf']).toMatch(/S3_SSE_KMS_KEY_ID\s*=\s*aws_kms_key\.main\.arn/);
  });

  it('ALB: TLS 1.2+ on 443, port 80 only redirects, invalid headers dropped', () => {
    const https = resource('aws_lb_listener', 'https');
    expect(https).toMatch(setting('protocol', '"HTTPS"'));
    expect(https).toMatch(/ssl_policy\s*=\s*"ELBSecurityPolicy-TLS13-1-2-/);
    expect(https).toMatch(setting('certificate_arn', 'var.acm_certificate_arn'));
    const http = resource('aws_lb_listener', 'http_redirect');
    expect(http).toMatch(setting('type', '"redirect"'));
    expect(http).not.toMatch(/forward/);
    expect(resource('aws_lb', 'main')).toMatch(setting('drop_invalid_header_fields', 'true'));
    expect(tf['ecs.tf']).toMatch(/TRUST_PROXY\s*=\s*"1"/);
  });

  it('ECS: private tasks only, secrets from Secrets Manager, digest-pinned images', () => {
    const services = [...allTf.matchAll(/resource "aws_ecs_service" "(\w+)" \{/g)].map(
      (m) => m[1]!,
    );
    expect(services.sort()).toEqual(['api', 'web', 'worker']);
    for (const s of services)
      expect(resource('aws_ecs_service', s), s).toMatch(setting('assign_public_ip', 'false'));
    expect(allTf).not.toMatch(/map_public_ip_on_launch\s*=\s*true/);
    expect(allTf).not.toMatch(/publicly_accessible\s*=\s*true/);
    expect(tf['ecs.tf']).toMatch(/secrets\s*=\s*local\.secrets_for\.api/);
    expect(tf['secrets.tf']).toMatch(/valueFrom\s*=\s*aws_secretsmanager_secret\.app\[/);
    for (const e of tfvars)
      for (const m of e.text.matchAll(/^image_\w+\s*=\s*"([^"]+)"/gm))
        expect(m[1], `${e.name}: ${m[1]}`).toMatch(/@sha256:/);
  });

  it('never writes a secret: no secret values, keys or passwords in the IaC', () => {
    // values only through Secrets Manager entries Shiva fills; Terraform never sees them
    expect(allTf).not.toMatch(/aws_secretsmanager_secret_version|secret_string|random_password/);
    expect(allTf).not.toMatch(/^\s*(password|auth_token|access_key|secret_key)\s*=/m);
    const forbidden = [
      /AKIA[0-9A-Z]{16}/, // AWS access key id
      /\b(sk|rk)_(live|test)_[0-9A-Za-z]{8,}/, // Stripe keys
      /whsec_[0-9A-Za-z]{8,}/,
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
      /postgres(ql)?:\/\/[^\s"]*:[^\s"@]+@/, // URL with a password
      /arn:aws:[a-z0-9-]+:[a-z0-9-]*:\d{12}:/, // a real account id in an ARN
    ];
    const texts = [...Object.entries(tf), ...examples.map((e) => [e.name, e.text] as const)];
    for (const [name, text] of texts)
      for (const re of forbidden) expect(text, name).not.toMatch(re);
    for (const e of tfvars) {
      expect(e.text, e.name).toMatch(/^aws_account_id\s*=\s*"<[^>]+>"/m);
      // nothing secret-looking is even a variable (optional_secrets only lists names)
      const keys = [...e.text.matchAll(/^(\w+)\s*=/gm)].map((m) => m[1]!);
      for (const k of keys.filter((k) => k !== 'optional_secrets'))
        expect(k, e.name).not.toMatch(/secret|password|token|api_key/i);
    }
  });

  it('never uses port 3000 or 5432 (CLAUDE.md)', () => {
    const ports = [
      ...allTf.matchAll(/^\s*(?:\w+_port|port|from_port|to_port|containerPort)\s*=\s*(\d+)/gm),
    ].map((m) => Number(m[1]));
    expect(ports).toEqual(expect.arrayContaining([443, 4000, 3010, 5433]));
    expect(ports).not.toContain(3000);
    expect(allTf).not.toMatch(/\b5432\b/);
  });

  it('tfvars examples set every required variable and nothing undeclared', () => {
    const vars = [...tf['variables.tf']!.matchAll(/^variable "(\w+)" \{/gm)].map((m) => m[1]!);
    const required = vars.filter(
      (v) => !/^\s*default\s*=/m.test(block(tf['variables.tf']!, `variable "${v}" {`)),
    );
    expect(required).toContain('environment');
    for (const e of tfvars) {
      const keys = [...e.text.matchAll(/^(\w+)\s*=/gm)].map((m) => m[1]!);
      for (const v of required) expect(keys, `${e.name} sets ${v}`).toContain(v);
      for (const k of keys) expect(vars, `${e.name}: ${k} is declared`).toContain(k);
    }
  });

  it('every env var and secret given to the containers is one the apps read', () => {
    const known = [
      read('.env.example'),
      read('apps/api/src/config/env.ts'),
      read('apps/worker/src/index.ts'),
    ].join('\n');
    const envBlocks = [
      block(tf['ecs.tf']!, 'shared_env = merge('),
      block(tf['ecs.tf']!, 'api_env = merge('),
      block(tf['ecs.tf']!, 'worker_env = merge('),
      block(tf['ecs.tf']!, 'web_env = {'),
      block(tf['secrets.tf']!, 'required_secrets = {'),
      block(tf['secrets.tf']!, 'optional_secrets = {'),
    ].join('\n');
    const names = [...envBlocks.matchAll(/^\s*([A-Z][A-Z0-9_]+)\s*=/gm)].map((m) => m[1]!);
    expect(names.length).toBeGreaterThan(20);
    for (const n of names) expect(known, n).toMatch(new RegExp(`\\b${n}\\b`));
    expect(existsSync(path.join(root, 'docs/INFRA.md'))).toBe(true);
  });
});
