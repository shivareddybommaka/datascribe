# Datascribe AWS deployment (REQUIREMENTS.md §2 hosting target, §10, D-115).
# Written, never applied. How to plan / apply and what Shiva must provide: docs/INFRA.md.

terraform {
  # 1.10+ for S3-native state locking (use_lockfile), no DynamoDB table needed.
  required_version = ">= 1.10.0, < 2.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.80"
    }
  }

  # Partial configuration: bucket, key, region and KMS key come from
  # environments/<env>.backend.hcl (see backend.hcl.example). State is encrypted and locked.
  backend "s3" {
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region              = var.region
  allowed_account_ids = [var.aws_account_id]

  default_tags {
    tags = {
      Project     = "datascribe"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}
