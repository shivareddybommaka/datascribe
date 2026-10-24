output "alb_dns_name" {
  description = "Point app_domain here (CNAME / alias), outside Terraform."
  value       = aws_lb.main.dns_name
}

output "ecr_repositories" {
  value = { for k, r in aws_ecr_repository.app : k => r.repository_url }
}

output "ecs_cluster" {
  value = aws_ecs_cluster.main.name
}

output "migrate_task_definition" {
  value = aws_ecs_task_definition.migrate.arn
}

output "private_subnet_ids" {
  description = "For `aws ecs run-task` of the migration task."
  value       = aws_subnet.private[*].id
}

output "worker_security_group_id" {
  value = aws_security_group.worker.id
}

output "db_endpoint" {
  value = aws_db_instance.main.address
}

output "db_master_secret_arn" {
  description = "RDS-managed master credentials (for the D-110 role setup only, never for the apps)."
  value       = aws_db_instance.main.master_user_secret[0].secret_arn
}

output "redis_url" {
  value = local.redis_url
}

output "kms_key_arn" {
  value = aws_kms_key.main.arn
}

output "buckets" {
  value = { for k, b in aws_s3_bucket.app : k => b.id }
}

output "secret_names" {
  description = "Secrets Manager entries to fill before scaling the services up (docs/INFRA.md)."
  value       = sort([for s in aws_secretsmanager_secret.app : s.name])
}
