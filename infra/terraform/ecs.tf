# ECS on Fargate: api, web, worker (+ ClamAV sidecar) services and a one-off migration task, all in
# private subnets without public IPs. Secrets come from Secrets Manager (secrets.tf), logs go to
# CloudWatch (logs.tf). Images are pinned by digest (variables.tf).

resource "aws_ecs_cluster" "main" {
  name = local.name

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  configuration {
    execute_command_configuration {
      kms_key_id = aws_kms_key.main.arn
      logging    = "OVERRIDE"
      log_configuration {
        cloud_watch_encryption_enabled = true
        cloud_watch_log_group_name     = aws_cloudwatch_log_group.ecs_exec.name
      }
    }
  }
}

resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name       = aws_ecs_cluster.main.name
  capacity_providers = ["FARGATE"]
  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }
}

# ── IAM ──

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

# Execution role: pull images, write logs, read exactly our secrets.
resource "aws_iam_role" "execution" {
  name               = "${local.name}-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [for s in aws_secretsmanager_secret.app : s.arn]
  }
  statement {
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.main.arn]
  }
}

resource "aws_iam_role_policy" "execution" {
  name   = "secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution.json
}

# Task roles: what the code itself may call. S3 via the role, no access keys (S3_ACCESS_KEY_ID unset).
data "aws_iam_policy_document" "s3_objects" {
  statement {
    sid = "Objects"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
      "s3:AbortMultipartUpload",
      "s3:ListMultipartUploadParts",
    ]
    resources = [for b in aws_s3_bucket.app : "${b.arn}/*"]
  }
  statement {
    sid       = "Buckets"
    actions   = ["s3:ListBucket", "s3:GetBucketLocation"]
    resources = [for b in aws_s3_bucket.app : b.arn]
  }
  statement {
    sid = "Kms"
    actions = [
      "kms:Encrypt",
      "kms:Decrypt",
      "kms:ReEncrypt*",
      "kms:GenerateDataKey*",
      "kms:DescribeKey",
    ]
    resources = [aws_kms_key.main.arn]
  }
}

# The API's ensureBuckets() re-applies public-access block, default encryption and CORS at start-up
# (storage.ts). It never creates buckets here: Terraform owns them, so no s3:CreateBucket.
data "aws_iam_policy_document" "api_bucket_config" {
  statement {
    actions = [
      "s3:PutBucketPublicAccessBlock",
      "s3:PutEncryptionConfiguration",
      "s3:PutBucketCORS",
    ]
    resources = [for b in aws_s3_bucket.app : b.arn]
  }
}

data "aws_iam_policy_document" "ecs_exec" {
  statement {
    actions = [
      "ssmmessages:CreateControlChannel",
      "ssmmessages:CreateDataChannel",
      "ssmmessages:OpenControlChannel",
      "ssmmessages:OpenDataChannel",
    ]
    resources = ["*"]
  }
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogGroups"]
    resources = ["*"]
  }
  statement {
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_key.main.arn]
  }
}

# web and migrate get a role with no permissions at all.
resource "aws_iam_role" "task" {
  for_each           = toset(["api", "web", "worker", "migrate"])
  name               = "${local.name}-${each.key}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy" "task_s3" {
  for_each = toset(["api", "worker"])
  name     = "s3-objects"
  role     = aws_iam_role.task[each.key].id
  policy   = data.aws_iam_policy_document.s3_objects.json
}

resource "aws_iam_role_policy" "api_bucket_config" {
  name   = "s3-bucket-config"
  role   = aws_iam_role.task["api"].id
  policy = data.aws_iam_policy_document.api_bucket_config.json
}

resource "aws_iam_role_policy" "task_exec" {
  for_each = var.enable_ecs_exec ? toset(["api", "web", "worker"]) : toset([])
  name     = "ecs-exec"
  role     = aws_iam_role.task[each.key].id
  policy   = data.aws_iam_policy_document.ecs_exec.json
}

# ── Container environment (non-secret) ──

locals {
  redis_url = "rediss://${aws_elasticache_replication_group.main.primary_endpoint_address}:${local.redis_port}/0"

  shared_env = merge(
    {
      NODE_ENV               = "production"
      APP_URL                = local.app_url
      REDIS_URL              = local.redis_url
      REDIS_KEY_PREFIX       = "ds:"
      QUEUE_PREFIX           = "bull"
      S3_REGION              = var.region
      S3_BUCKET_DOCUMENTS    = aws_s3_bucket.app["documents"].id
      S3_BUCKET_DELIVERABLES = aws_s3_bucket.app["deliverables"].id
      S3_SSE                 = "aws:kms"
      S3_SSE_KMS_KEY_ID      = aws_kms_key.main.arn
      SMTP_HOST              = var.smtp_host
      SMTP_PORT              = tostring(var.smtp_port)
      MAIL_FROM              = var.mail_from
      MEDICAL_DATA_PROVIDER  = var.medical_data_provider
      OCR_PROVIDER           = var.ocr_provider
      SUMMARY_PROVIDER       = var.summary_provider
      PHI_LLM_BAA_CONFIRMED  = tostring(var.phi_llm_baa_confirmed)
      PAYMENT_GATEWAY        = "stripe"
      LOG_LEVEL              = "info"
    },
    var.staff_email_domains == "" ? {} : { STAFF_EMAIL_DOMAINS = var.staff_email_domains },
    var.extra_app_env,
  )

  api_env = merge(local.shared_env, {
    API_PORT    = tostring(local.api_port)
    API_URL     = local.app_url
    TRUST_PROXY = "1" # the ALB is the only hop (D-101)
    # The API no longer scans (the worker does, D-081) but its production check still wants a
    # scanner host; the worker's sidecar is the real one. Follow-up in D-115.
    CLAMAV_HOST = "localhost"
    CLAMAV_PORT = tostring(local.clamav_port)
  })

  worker_env = merge(local.shared_env, {
    CLAMAV_HOST = "localhost" # sidecar in the same task (awsvpc: shared network namespace)
    CLAMAV_PORT = tostring(local.clamav_port)
  })

  web_env = {
    NODE_ENV = "production"
    # Browsers reach /api/v1 through the ALB rule; server-side rewrites go the same way.
    API_URL = local.app_url
  }

  env_by_family = { api = local.api_env, worker = local.worker_env, web = local.web_env }
  to_env = {
    for family, env in local.env_by_family :
    family => [for k in sort(keys(env)) : { name = k, value = env[k] }]
  }

  log_options = { for svc in ["api", "web", "worker", "clamav", "migrate"] : svc => {
    logDriver = "awslogs"
    options = {
      awslogs-group         = aws_cloudwatch_log_group.service[svc].name
      awslogs-region        = var.region
      awslogs-stream-prefix = svc
    }
  } }

  runtime_platform = {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }
}

# ── Task definitions ──

resource "aws_ecs_task_definition" "api" {
  family                   = "${local.name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.api_cpu
  memory                   = var.api_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task["api"].arn

  runtime_platform {
    operating_system_family = local.runtime_platform.operating_system_family
    cpu_architecture        = local.runtime_platform.cpu_architecture
  }

  container_definitions = jsonencode([{
    name             = "api"
    image            = var.image_api
    essential        = true
    portMappings     = [{ containerPort = local.api_port, protocol = "tcp" }]
    environment      = local.to_env.api
    secrets          = local.secrets_for.api
    logConfiguration = local.log_options.api
    linuxParameters  = { initProcessEnabled = true }
    # ECS ignores the Dockerfile HEALTHCHECK, so the same probe is repeated here (apps/api/Dockerfile).
    healthCheck = {
      command     = ["CMD", "node", "-e", "fetch('http://127.0.0.1:${local.api_port}/api/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 20
    }
  }])
}

resource "aws_ecs_task_definition" "web" {
  family                   = "${local.name}-web"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.web_cpu
  memory                   = var.web_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task["web"].arn

  runtime_platform {
    operating_system_family = local.runtime_platform.operating_system_family
    cpu_architecture        = local.runtime_platform.cpu_architecture
  }

  container_definitions = jsonencode([{
    name             = "web"
    image            = var.image_web
    essential        = true
    portMappings     = [{ containerPort = local.web_port, protocol = "tcp" }]
    environment      = local.to_env.web
    secrets          = local.secrets_for.web
    logConfiguration = local.log_options.web
    linuxParameters  = { initProcessEnabled = true }
  }])
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "${local.name}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.worker_cpu
  memory                   = var.worker_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task["worker"].arn

  runtime_platform {
    operating_system_family = local.runtime_platform.operating_system_family
    cpu_architecture        = local.runtime_platform.cpu_architecture
  }

  container_definitions = jsonencode([
    {
      name             = "clamav"
      image            = var.image_clamav
      essential        = true
      portMappings     = [{ containerPort = local.clamav_port, protocol = "tcp" }]
      logConfiguration = local.log_options.clamav
      healthCheck = {
        command     = ["CMD-SHELL", "clamdcheck.sh"]
        interval    = 30
        timeout     = 10
        retries     = 3
        startPeriod = 300 # signature download and load on a cold start
      }
    },
    {
      name             = "worker"
      image            = var.image_worker
      essential        = true
      environment      = local.to_env.worker
      secrets          = local.secrets_for.worker
      logConfiguration = local.log_options.worker
      linuxParameters  = { initProcessEnabled = true }
      dependsOn        = [{ containerName = "clamav", condition = "HEALTHY" }]
    },
  ])
}

# Run once per release before the services roll (docs/INFRA.md): migrate image, migrator role.
resource "aws_ecs_task_definition" "migrate" {
  family                   = "${local.name}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task["migrate"].arn

  runtime_platform {
    operating_system_family = local.runtime_platform.operating_system_family
    cpu_architecture        = local.runtime_platform.cpu_architecture
  }

  container_definitions = jsonencode([{
    name             = "migrate"
    image            = var.image_migrate
    essential        = true
    command          = var.migrate_command
    environment      = [{ name = "NODE_ENV", value = "production" }]
    secrets          = local.migrate_task_secrets
    logConfiguration = local.log_options.migrate
  }])
}

# ── Services ──

resource "aws_ecs_service" "api" {
  name                   = "api"
  cluster                = aws_ecs_cluster.main.id
  task_definition        = aws_ecs_task_definition.api.arn
  desired_count          = var.api_desired_count
  launch_type            = "FARGATE"
  enable_execute_command = var.enable_ecs_exec
  propagate_tags         = "SERVICE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.api.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = local.api_port
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  depends_on = [aws_lb_listener.https]
}

resource "aws_ecs_service" "web" {
  name                   = "web"
  cluster                = aws_ecs_cluster.main.id
  task_definition        = aws_ecs_task_definition.web.arn
  desired_count          = var.web_desired_count
  launch_type            = "FARGATE"
  enable_execute_command = var.enable_ecs_exec
  propagate_tags         = "SERVICE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.web.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.web.arn
    container_name   = "web"
    container_port   = local.web_port
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  depends_on = [aws_lb_listener.https]
}

resource "aws_ecs_service" "worker" {
  name                   = "worker"
  cluster                = aws_ecs_cluster.main.id
  task_definition        = aws_ecs_task_definition.worker.arn
  desired_count          = var.worker_desired_count
  launch_type            = "FARGATE"
  enable_execute_command = var.enable_ecs_exec
  propagate_tags         = "SERVICE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.worker.id]
    assign_public_ip = false
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
}
