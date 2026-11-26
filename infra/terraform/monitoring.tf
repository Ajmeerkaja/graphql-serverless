variable "alert_email" {
  description = "Email address that receives alarm notifications"
  type        = string
}

resource "aws_sns_topic" "alerts" {
  name = "${var.project}-alerts"
}

resource "aws_sns_topic_subscription" "email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

locals {
  alarms = {
    ecs-cpu-high = {
      description = "Fargate service CPU above 80%"
      namespace   = "AWS/ECS"
      metric      = "CPUUtilization"
      statistic   = "Average"
      dimensions  = { ClusterName = aws_ecs_cluster.main.name, ServiceName = aws_ecs_service.graphql.name }
      threshold   = 80
      operator    = "GreaterThanThreshold"
      period      = 60
      evals       = 3
      datapoints  = 2
    }
    ecs-memory-high = {
      description = "Fargate service memory above 80%"
      namespace   = "AWS/ECS"
      metric      = "MemoryUtilization"
      statistic   = "Average"
      dimensions  = { ClusterName = aws_ecs_cluster.main.name, ServiceName = aws_ecs_service.graphql.name }
      threshold   = 80
      operator    = "GreaterThanThreshold"
      period      = 60
      evals       = 3
      datapoints  = 2
    }
    alb-unhealthy-targets = {
      description = "Private GraphQL server has unhealthy targets"
      namespace   = "AWS/ApplicationELB"
      metric      = "UnHealthyHostCount"
      statistic   = "Maximum"
      dimensions  = { LoadBalancer = aws_lb.internal.arn_suffix, TargetGroup = aws_lb_target_group.graphql.arn_suffix }
      threshold   = 0
      operator    = "GreaterThanThreshold"
      period      = 60
      evals       = 2
      datapoints  = 2
    }
    alb-target-5xx = {
      description = "Private GraphQL server returning 5xx errors"
      namespace   = "AWS/ApplicationELB"
      metric      = "HTTPCode_Target_5XX_Count"
      statistic   = "Sum"
      dimensions  = { LoadBalancer = aws_lb.internal.arn_suffix, TargetGroup = aws_lb_target_group.graphql.arn_suffix }
      threshold   = 5
      operator    = "GreaterThanThreshold"
      period      = 60
      evals       = 1
      datapoints  = 1
    }
    rds-cpu-high = {
      description = "RDS CPU above 80%"
      namespace   = "AWS/RDS"
      metric      = "CPUUtilization"
      statistic   = "Average"
      dimensions  = { DBInstanceIdentifier = aws_db_instance.main.identifier }
      threshold   = 80
      operator    = "GreaterThanThreshold"
      period      = 60
      evals       = 3
      datapoints  = 2
    }
    rds-connections-high = {
      description = "RDS database connections above 40"
      namespace   = "AWS/RDS"
      metric      = "DatabaseConnections"
      statistic   = "Maximum"
      dimensions  = { DBInstanceIdentifier = aws_db_instance.main.identifier }
      threshold   = 40
      operator    = "GreaterThanThreshold"
      period      = 60
      evals       = 3
      datapoints  = 2
    }
    rds-storage-low = {
      description = "RDS free storage below 2 GB"
      namespace   = "AWS/RDS"
      metric      = "FreeStorageSpace"
      statistic   = "Minimum"
      dimensions  = { DBInstanceIdentifier = aws_db_instance.main.identifier }
      threshold   = 2147483648
      operator    = "LessThanThreshold"
      period      = 300
      evals       = 1
      datapoints  = 1
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "this" {
  for_each = local.alarms

  alarm_name          = "${var.project}-${each.key}"
  alarm_description   = each.value.description
  namespace           = each.value.namespace
  metric_name         = each.value.metric
  statistic           = each.value.statistic
  dimensions          = each.value.dimensions
  threshold           = each.value.threshold
  comparison_operator = each.value.operator
  period              = each.value.period
  evaluation_periods  = each.value.evals
  datapoints_to_alarm = each.value.datapoints
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

output "alerts_topic_arn" {
  value = aws_sns_topic.alerts.arn
}