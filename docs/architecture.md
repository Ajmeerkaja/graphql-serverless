# Architecture

```mermaid
flowchart LR
  U["User browser"] -->|HTTPS| CF["CloudFront"]
  CF -->|"Origin Access Control"| S3[("S3 private bucket<br/>React app")]
  U -->|"HTTPS GraphQL"| APIGW["API Gateway HTTP API"]

  subgraph VPC["VPC 10.0.0.0/16 - 2 Availability Zones"]
    subgraph PRIV["Private subnets"]
      L1["Lambda: GraphQL API"]
      L2["Lambda: Health check"]
      ALB["Internal ALB"]
      F["ECS Fargate<br/>private GraphQL server"]
      RDS[("RDS PostgreSQL")]
    end
    subgraph PUB["Public subnets"]
      NAT["NAT gateway"]
    end
  end

  APIGW --> L1
  APIGW --> L2
  L1 -->|"queries and mutations"| RDS
  L1 -->|"stats via HTTP"| ALB
  L2 -->|"health via HTTP"| ALB
  ALB --> F
  F -->|SQL| RDS

  SM["Secrets Manager<br/>DB credentials"]
  L1 -.->|"reads at runtime"| SM
  F -.->|"injected by ECS"| SM

  GH["GitHub Actions"] -->|"OIDC role"| DEP["Deploy: SAM stack, S3 sync, CloudFront invalidation"]
  DEP -.-> APIGW
  DEP -.-> S3

  CW["CloudWatch Logs and Alarms"] --> SNS["SNS topic"] --> MAIL["Email alert"]
  L1 -.-> CW
  F -.-> CW
  RDS -.-> CW
```

## Components

| Layer | Service | Notes |
|---|---|---|
| Frontend | S3 + CloudFront | Private bucket, Origin Access Control, HTTPS, caching, security headers |
| Public API | API Gateway HTTP API + Lambda (TypeScript, Node.js 24, arm64) | `POST /graphql` (queries, mutations) and `GET /health` |
| Private service | ECS Fargate behind an internal ALB | Apollo Server on Express, no public address |
| Database | RDS PostgreSQL 16 | Private subnets, encrypted, managed credentials in Secrets Manager |
| CI/CD | GitHub Actions with OIDC | Test, then deploy the Lambda stack and the frontend |
| Monitoring | CloudWatch + SNS | Alarms by email |
