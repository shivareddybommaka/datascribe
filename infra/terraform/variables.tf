# Inputs. Examples (no real values, no secrets): environments/*.tfvars.example.
# Secrets are never Terraform inputs: they live in Secrets Manager (secrets.tf).

variable "environment" {
  description = "staging or production"
  type        = string
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production."
  }
}

variable "aws_account_id" {
  description = "The only AWS account this configuration may touch (guards against the wrong profile)."
  type        = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id must be 12 digits."
  }
}

variable "region" {
  description = "AWS region (REQUIREMENTS §14 default: ap-south-1)."
  type        = string
  default     = "ap-south-1"
}

# ── Network ──

variable "vpc_cidr" {
  type    = string
  default = "10.40.0.0/16"
}

variable "az_count" {
  description = "Availability zones to spread subnets over (2 or 3)."
  type        = number
  default     = 2
  validation {
    condition     = var.az_count >= 2 && var.az_count <= 3
    error_message = "az_count must be 2 or 3 (RDS and the ALB need at least two)."
  }
}

variable "single_nat_gateway" {
  description = "One NAT gateway for all AZs (cheaper, staging) instead of one per AZ (production)."
  type        = bool
  default     = false
}

# ── Edge ──

variable "app_domain" {
  description = "Host name of the portal / console / API, e.g. app.example.com. DNS is managed outside Terraform."
  type        = string
}

variable "acm_certificate_arn" {
  description = "ACM certificate for app_domain in this region (issued and validated outside Terraform)."
  type        = string
  validation {
    condition     = can(regex("^arn:aws:acm:", var.acm_certificate_arn))
    error_message = "acm_certificate_arn must be an ACM certificate ARN."
  }
}

# ── Data stores ──

variable "db_instance_class" {
  type    = string
  default = "db.t4g.medium"
}

variable "db_allocated_storage_gb" {
  type    = number
  default = 50
}

variable "db_max_allocated_storage_gb" {
  description = "Storage autoscaling ceiling."
  type        = number
  default     = 200
}

variable "db_multi_az" {
  type    = bool
  default = true
}

variable "db_backup_retention_days" {
  description = "Daily automated snapshots kept this long (§10: 30 days)."
  type        = number
  default     = 30
  validation {
    condition     = var.db_backup_retention_days >= 30 && var.db_backup_retention_days <= 35
    error_message = "§10 needs at least 30 days of daily snapshots (RDS allows up to 35)."
  }
}

variable "deletion_protection" {
  description = "Protect RDS and the ALB from deletion. Keep true in production."
  type        = bool
  default     = true
}

variable "redis_node_type" {
  type    = string
  default = "cache.t4g.small"
}

variable "redis_replicas" {
  description = "Read replicas next to the primary; 1+ enables automatic failover."
  type        = number
  default     = 1
}

variable "bucket_prefix" {
  description = "Globally unique S3 bucket name prefix, e.g. <company>-datascribe-staging."
  type        = string
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{2,40}[a-z0-9]$", var.bucket_prefix))
    error_message = "bucket_prefix must be 4-42 lowercase letters, digits or hyphens."
  }
}

variable "noncurrent_version_days" {
  description = "Old object versions are kept this long, then expire (so retention deletes really purge)."
  type        = number
  default     = 30
}

# ── Containers ──

variable "image_api" {
  description = "API image, pinned by digest (repo@sha256:...), built by CI and pushed to ECR."
  type        = string
  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.image_api))
    error_message = "Pin images by digest (audit L12)."
  }
}

variable "image_web" {
  type = string
  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.image_web))
    error_message = "Pin images by digest (audit L12)."
  }
}

variable "image_worker" {
  type = string
  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.image_worker))
    error_message = "Pin images by digest (audit L12)."
  }
}

variable "image_clamav" {
  description = "ClamAV sidecar for the worker's virus scan stage (same digest as docker-compose.yml)."
  type        = string
  default     = "clamav/clamav:stable@sha256:e19130cdebaeacc71fa46eab3ed6f69941f2f22aa5e08d55e9197f8edf43ce5e"
  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.image_clamav))
    error_message = "Pin images by digest (audit L12)."
  }
}

variable "cpu_architecture" {
  description = "X86_64 or ARM64; must match how CI builds the images."
  type        = string
  default     = "X86_64"
}

variable "api_desired_count" {
  description = "Set 0 for the first apply, until the secrets have values (docs/INFRA.md)."
  type        = number
  default     = 2
}

variable "web_desired_count" {
  type    = number
  default = 2
}

variable "worker_desired_count" {
  type    = number
  default = 1
}

variable "api_cpu" {
  type    = number
  default = 512
}

variable "api_memory" {
  type    = number
  default = 1024
}

variable "web_cpu" {
  type    = number
  default = 512
}

variable "web_memory" {
  type    = number
  default = 1024
}

variable "worker_cpu" {
  description = "Worker + ClamAV sidecar (clamd needs about 2 GB for its signatures)."
  type        = number
  default     = 1024
}

variable "worker_memory" {
  type    = number
  default = 4096
}

variable "migrate_command" {
  description = "Command of the one-off migration task (API image, migrator DB role, D-110)."
  type        = list(string)
  default     = ["pnpm", "--filter", "@datascribe/db", "migrate:deploy"]
}

variable "enable_ecs_exec" {
  description = "Allow `aws ecs execute-command` into tasks (break-glass, audited in CloudTrail)."
  type        = bool
  default     = false
}

variable "log_retention_days" {
  type    = number
  default = 365
}

# ── Application settings (non-secret) ──

variable "mail_from" {
  type = string
}

variable "smtp_host" {
  description = "SES SMTP endpoint, e.g. email-smtp.ap-south-1.amazonaws.com."
  type        = string
}

variable "smtp_port" {
  type    = number
  default = 587
}

variable "staff_email_domains" {
  type    = string
  default = ""
}

variable "medical_data_provider" {
  type    = string
  default = "mock"
}

variable "ocr_provider" {
  type    = string
  default = "tesseract"
}

variable "summary_provider" {
  description = "mock until a BAA-covered LLM vendor is chosen (§8.3, §14)."
  type        = string
  default     = "mock"
}

variable "phi_llm_baa_confirmed" {
  type    = bool
  default = false
}

variable "optional_secrets" {
  description = "Optional Secrets Manager entries to create and inject: OPENFDA_API_KEY, LLM_API_KEY."
  type        = list(string)
  default     = []
  validation {
    condition     = alltrue([for s in var.optional_secrets : contains(["OPENFDA_API_KEY", "LLM_API_KEY"], s)])
    error_message = "optional_secrets may only list OPENFDA_API_KEY and LLM_API_KEY."
  }
}

variable "extra_app_env" {
  description = "Further non-secret env for api and worker (never secrets: those go in Secrets Manager)."
  type        = map(string)
  default     = {}
  validation {
    condition     = alltrue([for k in keys(var.extra_app_env) : !can(regex("(SECRET|PASSWORD|TOKEN|_KEY$|DATABASE_URL)", upper(k)))])
    error_message = "Secrets go in Secrets Manager (secrets.tf), not in extra_app_env."
  }
}
