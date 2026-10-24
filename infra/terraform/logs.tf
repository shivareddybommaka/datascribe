# CloudWatch log groups for the services (pino JSON lines, no PHI: D-105), KMS-encrypted.

resource "aws_cloudwatch_log_group" "service" {
  for_each          = toset(["api", "web", "worker", "clamav", "migrate"])
  name              = "/datascribe/${var.environment}/${each.key}"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.main.arn
}

resource "aws_cloudwatch_log_group" "ecs_exec" {
  name              = "/datascribe/${var.environment}/ecs-exec"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.main.arn
}
