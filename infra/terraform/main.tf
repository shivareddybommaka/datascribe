data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_caller_identity" "current" {}

data "aws_partition" "current" {}

locals {
  name       = "datascribe-${var.environment}"
  account_id = data.aws_caller_identity.current.account_id
  partition  = data.aws_partition.current.partition
  azs        = slice(data.aws_availability_zones.available.names, 0, var.az_count)
  app_url    = "https://${var.app_domain}"

  # Ports. Never 3000 (CLAUDE.md); web matches `next start --port 3010`. Postgres on 5433 as locally,
  # so no runbook or URL ever says 5432 (Shiva's CRM on the Mac).
  api_port    = 4000
  web_port    = 3010
  clamav_port = 3310
  redis_port  = 6379
  db_port     = 5433
}
