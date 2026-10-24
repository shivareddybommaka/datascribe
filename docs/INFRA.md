# Infrastructure as code (AWS, Terraform)

`infra/terraform/` describes the AWS target of REQUIREMENTS.md §2 (portal, console, API, workers and
database on AWS) with the §10 settings. Design notes: D-115.

**Status: written, never applied.** Nothing has been planned, applied or deployed, and no AWS account
has been contacted. Terraform isn't installed on the build Mac (a system install needs Shiva's
approval). `apps/api/test/infra-terraform.test.ts` checks the files as text (encryption, versioning,
TLS, no secrets, tfvars complete) in every test run; `terraform validate` and `plan` still have to
run before the first apply.

## What it creates (per environment)

| File         | Resources                                                                                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kms.tf`     | One customer-managed KMS key (yearly rotation) for RDS, ElastiCache, S3, Secrets Manager, CloudWatch Logs, ECR.                                                                             |
| `network.tf` | VPC over 2–3 AZs: public (ALB, NAT), private (ECS tasks), data (RDS, Redis; no internet route). S3 gateway endpoint, VPC flow logs, one security group per tier, default SG locked down.    |
| `rds.tf`     | RDS Postgres 16, KMS-encrypted, private, `rds.force_ssl=1` (TLS 1.2+), daily automated snapshots kept 30 days, final snapshot on delete, master password managed by RDS in Secrets Manager. |
| `redis.tf`   | ElastiCache Redis 7, TLS required in transit, KMS at rest, `noeviction` (BullMQ), failover when `redis_replicas > 0`.                                                                       |
| `s3.tf`      | `<prefix>-documents` and `<prefix>-deliverables`: SSE-KMS by default, versioning, all public access blocked, no ACLs, TLS-only policy, old versions expire. ALB access-log bucket.          |
| `secrets.tf` | Empty Secrets Manager entries for every app secret. Terraform never holds a value.                                                                                                          |
| `ecr.tf`     | Image repositories for api, web, worker (immutable tags, scan on push).                                                                                                                     |
| `alb.tf`     | Internet-facing ALB: HTTPS 443 with the ACM certificate (TLS 1.3/1.2 policy), HTTP 80 redirects. `/api/v1/*` to the API, the rest to Next.                                                  |
| `ecs.tf`     | Fargate cluster; services api (:4000), web (:3010), worker (+ ClamAV sidecar); a one-off `migrate` task. Private subnets, no public IPs, least-privilege task roles.                        |
| `logs.tf`    | CloudWatch log groups per service, KMS-encrypted, `log_retention_days`.                                                                                                                     |
| `outputs.tf` | ALB DNS name, ECR URLs, secret names, subnet and security group ids for the migration task.                                                                                                 |

Not in Terraform: DNS records, the ACM certificate, the SES identity, the state bucket, the
marketing site (Vercel, §2) and the Payload CMS (hosting not decided, see open questions).

## What Shiva must provide

1. **AWS accounts**: one for staging, one for production (recommended), with a signed AWS BAA
   (HIPAA) on the production account before any real PHI.
2. **Approval to install Terraform** (1.10 or newer) on the machine that will run it, or a CI job
   that runs it.
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

1. CI builds and pushes the three images to the ECR URLs in the outputs; put their digests in the
   tfvars (`image_api`, `image_web`, `image_worker`).
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

Each release: push images, run the migration task with the new API image, update the digests,
`plan`, `apply`. A staging deploy from CI (§12 M10 DoD) is the next part and needs the Dockerfiles and
an AWS role for GitHub Actions (OIDC), both Shiva's call.

## Destroying

Production has `deletion_protection = true` (RDS, ALB) and RDS takes a final snapshot. S3 buckets with
objects are not emptied by Terraform. Never destroy production without a confirmed backup.
