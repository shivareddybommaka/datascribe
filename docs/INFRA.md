# Infrastructure as code (AWS, Terraform)

`infra/terraform/` describes the AWS target of REQUIREMENTS.md §2 (portal, console, API, workers and
database on AWS) with the §10 settings. Design notes: D-115.

**Status: written, never applied.** Nothing has been planned, applied or deployed, and no AWS account
has been contacted. Terraform 1.17.0 is on the build Mac (installed by Shiva): `terraform init
-backend=false`, `terraform validate` and `terraform fmt -check` pass (2026-10-25, AWS provider
5.100.0, lock file committed). `apps/api/test/infra-terraform.test.ts` checks the files as text
(encryption, versioning, TLS, no secrets, tfvars complete) in every test run; `plan` still has to run
against the real account before the first apply.

## What it creates (per environment)

| File         | Resources                                                                                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kms.tf`     | One customer-managed KMS key (yearly rotation) for RDS, ElastiCache, S3, Secrets Manager, CloudWatch Logs, ECR.                                                                             |
| `network.tf` | VPC over 2–3 AZs: public (ALB, NAT), private (ECS tasks), data (RDS, Redis; no internet route). S3 gateway endpoint, VPC flow logs, one security group per tier, default SG locked down.    |
| `rds.tf`     | RDS Postgres 16, KMS-encrypted, private, `rds.force_ssl=1` (TLS 1.2+), daily automated snapshots kept 30 days, final snapshot on delete, master password managed by RDS in Secrets Manager. |
| `redis.tf`   | ElastiCache Redis 7, TLS required in transit, KMS at rest, `noeviction` (BullMQ), failover when `redis_replicas > 0`.                                                                       |
| `s3.tf`      | `<prefix>-documents` and `<prefix>-deliverables`: SSE-KMS by default, versioning, all public access blocked, no ACLs, TLS-only policy, old versions expire. ALB access-log bucket.          |
| `secrets.tf` | Empty Secrets Manager entries for every app secret. Terraform never holds a value.                                                                                                          |
| `ecr.tf`     | Image repositories for api, web, worker, migrate (immutable tags, scan on push).                                                                                                            |
| `alb.tf`     | Internet-facing ALB: HTTPS 443 with the ACM certificate (TLS 1.3/1.2 policy), HTTP 80 redirects. `/api/v1/*` to the API, the rest to Next.                                                  |
| `ecs.tf`     | Fargate cluster; services api (:4000), web (:3010), worker (+ ClamAV sidecar); a one-off `migrate` task. Private subnets, no public IPs, least-privilege task roles.                        |
| `logs.tf`    | CloudWatch log groups per service, KMS-encrypted, `log_retention_days`.                                                                                                                     |
| `outputs.tf` | ALB DNS name, ECR URLs, secret names, subnet and security group ids for the migration task.                                                                                                 |

Not in Terraform: DNS records, the ACM certificate, the SES identity, the state bucket, the
marketing site (Vercel, §2) and the Payload CMS (hosting not decided, see open questions).

## What Shiva must provide

1. **AWS accounts**: one for staging, one for production (recommended), with a signed AWS BAA
   (HIPAA) on the production account before any real PHI.
2. **Terraform** (1.10 or newer): installed on the build Mac (1.17.0); the CI staging deploy below
   brings its own.
3. **State bucket** per account: S3 bucket with versioning and SSE-KMS, created once by hand.
4. **Domain** for the app (`app_domain`) and an **ACM certificate** for it in the region, validated.
5. **SES**: verified sending domain, out of the sandbox, SMTP credentials (see open questions: the
   app's mailer can't log in to SMTP yet).
6. **Secret values** (set in Secrets Manager after the first apply, never in files or chat):
   `DATABASE_URL`, `DATABASE_URL_MIGRATOR`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`,
   `PHI_ENCRYPTION_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and if enabled
   `OPENFDA_API_KEY`, `LLM_API_KEY`.
7. **Decisions**: region (default `ap-south-1`), instance sizes, and the open questions in D-115.

## Plan and apply (later, after approval)

Account `nova` (or whichever account has the AWS profile), from `infra/terraform`:

```
cp environments/staging.tfvars.example environments/staging.tfvars
cp environments/backend.hcl.example environments/staging.backend.hcl
terraform init -backend-config=environments/staging.backend.hcl
terraform fmt -check
terraform validate
terraform plan -var-file=environments/staging.tfvars -out=staging.tfplan
terraform apply staging.tfplan
```

Edit both copied files first (every `<placeholder>`). They are git-ignored. Commit the generated
`.terraform.lock.hcl` after the first `init`.

First apply: keep `*_desired_count = 0`. It creates the network, data stores, empty secrets and the
repositories. Then:

1. CI builds and pushes the four images (see [Container images](#container-images)) to the ECR URLs
   in the outputs; put their digests in the tfvars (`image_api`, `image_web`, `image_worker`,
   `image_migrate`).
2. Create the D-110 roles: run `packages/db/sql/app-roles.sql` as the RDS master user (credentials in
   the secret from the `db_master_secret_arn` output), following `docs/DB-ROLES.md`. Needs a host
   inside the VPC (for example a task with `enable_ecs_exec = true`), since the database has no
   public access.
3. Set every secret value. Use `file://` so the value never sits in shell history, then delete the
   file. Database URLs use port 5433, the `datascribe_app` / `datascribe_migrator` users and
   `?sslmode=require`. `PHI_ENCRYPTION_KEY`: `openssl rand -base64 32`, kept in a second safe
   place: losing it loses every encrypted PHI field. For example:

   ```
   aws secretsmanager put-secret-value --secret-id datascribe/staging/JWT_ACCESS_SECRET --secret-string file://jwt-access.txt
   ```

4. Run the migration task once (subnets and security group from the outputs):

   ```
   aws ecs run-task --cluster datascribe-staging --launch-type FARGATE --task-definition datascribe-staging-migrate --network-configuration "awsvpcConfiguration={subnets=[<private subnet ids>],securityGroups=[<worker sg id>],assignPublicIp=DISABLED}"
   ```

5. Set the desired counts (1 or more) and apply again. Point `app_domain` at the `alb_dns_name`
   output.

Each release: push images, run the migration task with the new migrate image, update the digests,
`plan`, `apply`. For staging the workflow below does exactly that.

The first apply needs image digests before any image exists (the variables only accept
`repo@sha256:<64 hex>`). With every desired count at 0 no task starts, so a placeholder is fine for
that one apply: `image_api = "<ecr url>/api@sha256:0000…0000"` (64 zeros), same for the others.

## CI staging deploy

`.github/workflows/deploy-staging.yml` (D-131) is the §12 M10 "staging deploy from CI". **Written,
never run**: no AWS role or variable exists yet, so a manual start would stop at its first
"Check configuration" step.

- **Starts only by hand**: Actions → "Deploy staging (AWS)" → Run workflow, on `main`. There is no
  push, pull_request or schedule trigger (`apps/api/test/infra-deploy-workflow.test.ts` fails if
  one is added), and both jobs skip on any other branch.
- **Input `apply`** (default off): off builds and pushes the images and runs `terraform plan` only.
  On it also registers the new migrate task definition, runs the migration task (fails the run
  unless it exits 0), plans again, applies that plan and waits until api, web and worker are stable.
- **No stored AWS keys**: each job gets short-lived credentials by assuming an IAM role through
  GitHub's OIDC token, and only as the `staging` environment. No GitHub secret is used.
- Images: built for `linux/amd64` (Fargate `X86_64`, D-116), tagged with the commit SHA (ECR tags
  are immutable, so a re-run reuses them) and deployed by digest. The web image gets
  `API_URL=STAGING_APP_URL`.

### What Shiva must create to enable it

Do the "Plan and apply" bootstrap above once by hand first (state bucket, ACM certificate, first apply
with desired counts 0, secret values, D-110 database roles). The workflow expects the ECR
repositories, the secrets and the database roles to exist already.

**In the AWS staging account** (console or CLI, account with IAM admin rights):

1. An IAM OIDC identity provider: URL `https://token.actions.githubusercontent.com`, audience
   `sts.amazonaws.com`.
2. An IAM role, for example `datascribe-staging-github-deploy`, with this trust policy (account id
   filled in):

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Principal": {
           "Federated": "arn:aws:iam::<staging account id>:oidc-provider/token.actions.githubusercontent.com"
         },
         "Action": "sts:AssumeRoleWithWebIdentity",
         "Condition": {
           "StringEquals": {
             "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
             "token.actions.githubusercontent.com:sub": "repo:shivareddybommaka/datascribe:environment:staging"
           }
         }
       }
     ]
   }
   ```

   The `sub` condition admits only jobs of this repository that run in its `staging` environment:
   no other repo, branch, fork or pull request can assume the role.

3. Permissions for that role. Terraform creates VPCs, RDS, ElastiCache, S3, KMS, ECR, ECS, ALB,
   CloudWatch Logs, Secrets Manager entries and IAM roles, so the role needs wide rights in the
   (dedicated) staging account. Suggested: the AWS managed policy `PowerUserAccess` plus an inline
   policy that allows `iam:*` only on `arn:aws:iam::<staging account id>:role/datascribe-staging-*`
   (the roles Terraform makes; includes `iam:PassRole`). `PowerUserAccess` already covers the state
   bucket and its KMS key. Never create this role in the production account.

**In GitHub** (repo Settings → Environments → New environment `staging`):

4. Deployment branches: "Selected branches" → `main` only. Optionally add Shiva as a required
   reviewer, so every run waits for an approval click before it gets AWS credentials.
5. Environment **variables** (not secrets; none of these is secret):

   | Variable               | Value                                                                       |
   | ---------------------- | --------------------------------------------------------------------------- |
   | `AWS_DEPLOY_ROLE_ARN`  | ARN of the role from step 2                                                 |
   | `AWS_ACCOUNT_ID`       | the 12-digit staging account id                                             |
   | `AWS_REGION`           | `ap-south-1` (or the chosen region)                                         |
   | `TF_STATE_BUCKET`      | the staging state bucket                                                    |
   | `TF_STATE_KMS_KEY_ARN` | the state bucket's KMS key ARN                                              |
   | `STAGING_TFVARS`       | the full text of the filled-in `staging.tfvars` (its `image_*` are ignored) |
   | `STAGING_APP_URL`      | `https://<staging app_domain>`                                              |

6. Actions must be enabled for the repo (Settings → Actions → General). The deploy key the agent
   uses has no Actions access, so Shiva starts the runs and reads their logs.

Raise the desired counts in `STAGING_TFVARS` from 0 once the secrets and roles are in place; the
next run with `apply` on rolls the services out.

## Container images

Design notes: D-116. Built from the repo root (`.dockerignore` keeps `.env*`, `.git`, worktrees,
`node_modules`, build output, test artifacts and Terraform state out of the context). Each final
stage runs as the unprivileged `node` user with production files only and no secrets.

| Image   | Dockerfile                             | Runs                                     | Port | Health                  |
| ------- | -------------------------------------- | ---------------------------------------- | ---- | ----------------------- |
| api     | `apps/api/Dockerfile`                  | `node dist/server.js` (tsup bundle)      | 4000 | `GET /api/v1/health`    |
| web     | `apps/web/Dockerfile`                  | `node apps/web/server.js` (standalone)   | 3010 | none (ALB checks `/`)   |
| worker  | `apps/worker/Dockerfile`               | `node dist/index.js` (tsup bundle)       | none | none (ClamAV sidecar)   |
| migrate | `apps/api/Dockerfile --target migrate` | `prisma migrate deploy` (`DATABASE_URL`) | none | one-off task, exit code |

Build locally (account `nova`, repo root, Colima running; needs network for the base image, apt,
npm and Prisma engines; nothing is pushed):

```
docker build -f apps/api/Dockerfile -t datascribe-api:local .
docker build -f apps/api/Dockerfile --target migrate -t datascribe-migrate:local .
docker build -f apps/worker/Dockerfile -t datascribe-worker:local .
docker build -f apps/web/Dockerfile --build-arg API_URL=http://localhost:4000 -t datascribe-web:local .
```

The web image bakes `API_URL` into Next's `/api/v1` rewrite at build time; CI should pass the
environment's `https://<app_domain>`. Images run on the build machine's architecture; build for
`cpu_architecture` (X86_64 by default) in CI. `apps/api/test/infra-docker.test.ts` checks the
Dockerfiles against the task definitions in every test run.

## Destroying

Production has `deletion_protection = true` (RDS, ALB) and RDS takes a final snapshot. S3 buckets with
objects are not emptied by Terraform. Never destroy production without a confirmed backup.
