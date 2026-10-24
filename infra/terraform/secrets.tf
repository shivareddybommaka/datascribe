# Secrets Manager entries for every secret the apps read. Terraform creates the empty containers
# only (no aws_secretsmanager_secret_version), so no secret value is ever in code, tfvars or state.
# Shiva sets the values with the AWS CLI or console (docs/INFRA.md) before scaling services up.
# ECS injects them as env vars through the task execution role.

locals {
  # name => which task families receive it. ECS refuses to start a task whose secret has no value,
  # so optional keys are only created and wired when listed in var.optional_secrets.
  required_secrets = {
    DATABASE_URL          = ["api", "worker"] # datascribe_app role, ?sslmode=require (D-110)
    JWT_ACCESS_SECRET     = ["api"]
    JWT_REFRESH_SECRET    = ["api"]
    PHI_ENCRYPTION_KEY    = ["api", "worker"]
    STRIPE_SECRET_KEY     = ["api", "worker"]
    STRIPE_WEBHOOK_SECRET = ["api"]
  }
  optional_secrets = {
    OPENFDA_API_KEY = ["api", "worker"] # register before production (D-052)
    LLM_API_KEY     = ["worker"]        # only with a BAA-covered SUMMARY_PROVIDER (§8.3)
  }
  app_secrets = merge(
    local.required_secrets,
    { for k, v in local.optional_secrets : k => v if contains(var.optional_secrets, k) },
  )
  # The migration task logs in as datascribe_migrator (D-110), never as the app role.
  migrate_secrets = {
    DATABASE_URL = "DATABASE_URL_MIGRATOR"
  }
}

resource "aws_secretsmanager_secret" "app" {
  for_each                = toset(concat(keys(local.app_secrets), values(local.migrate_secrets)))
  name                    = "datascribe/${var.environment}/${each.key}"
  kms_key_id              = aws_kms_key.main.arn
  recovery_window_in_days = 30
}

locals {
  secrets_for = {
    for family in ["api", "web", "worker"] : family => [
      for name, families in local.app_secrets : {
        name      = name
        valueFrom = aws_secretsmanager_secret.app[name].arn
      } if contains(families, family)
    ]
  }
  migrate_task_secrets = [
    for env_name, secret in local.migrate_secrets : {
      name      = env_name
      valueFrom = aws_secretsmanager_secret.app[secret].arn
    }
  ]
}
