# GraphQL Serverless on AWS

A GraphQL application on AWS: a React frontend on S3 and CloudFront, Lambda functions (TypeScript) behind API Gateway, a private GraphQL server on ECS Fargate, and a private RDS PostgreSQL database, with a GitHub Actions pipeline and CloudWatch monitoring.

See [docs/architecture.md](docs/architecture.md) for the architecture diagram.

## Repository layout

| Path | Contents |
|---|---|
| `infra/terraform` | VPC, subnets, NAT, security groups, RDS, ECR, ECS Fargate, ALB, S3 and CloudFront, GitHub OIDC role, SNS and CloudWatch alarms |
| `backend/lambda` | SAM template and TypeScript Lambda functions (GraphQL API and health check) |
| `backend/fargate` | Private GraphQL server (Node.js, Express, Apollo) and Dockerfile |
| `frontend` | React (Vite, TypeScript) application |
| `.github/workflows` | CI/CD pipeline |
| `docs` | Architecture diagram |

## How to deploy and test

Prerequisites: an AWS account, AWS CLI, Terraform, SAM CLI, Docker and Node.js, with credentials configured for region `ap-south-1`.

1. **Create the container registry first (Terraform).**
   ```bash
   cd infra/terraform
   echo 'alert_email = "you@example.com"' > terraform.tfvars
   terraform init
   terraform apply -target=aws_ecr_repository.graphql
   ```
2. **Build and push the container image**, then apply the rest of the infrastructure.
   ```bash
   REPO=$(terraform output -raw ecr_repository_url)
   aws ecr get-login-password --region ap-south-1 | docker login --username AWS --password-stdin ${REPO%%/*}
   docker build -t graphql-fargate ../../backend/fargate
   docker tag graphql-fargate:latest $REPO:v2 && docker push $REPO:v2
   terraform apply
   ```
   Confirm the alert email subscription when AWS sends the message.
3. **Deploy the backend (SAM).** Put the Terraform outputs (subnets, security group, DB host and secret ARN, ALB address, alert topic ARN) into `backend/lambda/samconfig.toml`, then:
   ```bash
   cd backend/lambda
   npm ci && sam build && sam deploy
   ```
4. **Build and upload the frontend.** Set `VITE_API_URL` in `frontend/.env` to the `ApiUrl` output, then:
   ```bash
   cd frontend && npm ci && npm run build
   aws s3 sync dist/ s3://<frontend_bucket> --delete
   ```
5. **Test.**
   ```bash
   API=<ApiUrl output without the /graphql suffix>
   curl -s "$API/health"
   curl -s -X POST "$API/graphql" -H 'content-type: application/json' \
     -d '{"query":"mutation { addTask(title: \"Test\") { id title } }"}'
   curl -s -X POST "$API/graphql" -H 'content-type: application/json' \
     -d '{"query":"{ tasks { id title done } stats { total done } }"}'
   ```
   Then open the `frontend_url` output in a browser. The `/health` call and the `stats` query travel from Lambda through the internal load balancer to Fargate and on to RDS, which proves the private integration.

## Security and IAM

| Identity | Permissions | Why |
|---|---|---|
| Lambda execution role (created by SAM) | Basic logging, VPC network interfaces, and `secretsmanager:GetSecretValue` on the one DB secret | The API needs the DB password and nothing else |
| ECS task execution role | AWS-managed ECS execution policy plus read access to the one DB secret | ECS pulls the image, writes logs and injects the password |
| ECS task role | No permissions | The application code makes no AWS API calls |
| GitHub deploy role (OIDC) | PowerUserAccess plus IAM actions limited to roles named `graphql-serverless-api-*` | Deploys Lambda, API Gateway, S3 and CloudFront without general IAM control |

- **No long-lived keys in GitHub.** The pipeline assumes a role through OIDC. The trust policy accepts only this repository and the `main` branch (matched on the token subject, which includes the numeric repository IDs).
- **Network.** RDS, Fargate and Lambda sit in private subnets. The RDS security group allows port 5432 only from the Lambda and Fargate security groups. The internal ALB accepts traffic only from the Lambda security group, and Fargate accepts port 4000 only from the ALB.
- **Frontend.** The S3 bucket blocks all public access. Only the CloudFront distribution can read it (Origin Access Control). Viewers are redirected to HTTPS and security headers are added.
- **Encryption.** RDS storage and S3 are encrypted at rest. Connections to the database use TLS.

## Secrets and environment variables

- The RDS master password is created and stored by AWS (`manage_master_user_password`) in Secrets Manager. It never appears in code, Terraform files or images.
- Lambda reads the secret at runtime. ECS injects it into the container as `DB_PASSWORD` from Secrets Manager.
- GitHub Actions holds only non-sensitive values as repository variables (role ARN, API URL, bucket name, distribution ID).

## CI/CD pipeline (`.github/workflows/deploy.yml`)

1. **test** (every push and pull request): install dependencies, TypeScript type check, `sam validate --lint`, frontend lint and build.
2. **deploy** (only on `main`, after the tests pass): assume the AWS role via OIDC, `sam build` and `sam deploy` for the backend, build the frontend, sync to S3 (hashed assets cached for a year, `index.html` not cached), and invalidate CloudFront.

The network, RDS and ECS are managed with Terraform and applied manually.

## Database setup and security practices

- RDS PostgreSQL 16 (`db.t4g.micro`) in a DB subnet group made of private subnets only, not publicly accessible, with encrypted storage and storage autoscaling (20 GB to 50 GB).
- Access is controlled with security-group references, not IP ranges.
- Queries are parameterised and input is validated.
- The demo table is created by the API on first use. A production system would use migrations.

## Monitoring and alerts

Lambda and ECS write to CloudWatch Logs (ECS retention is 7 days). Alarms notify an SNS topic by email.

| Component | Alarms |
|---|---|
| Lambda | Errors, throttles, p95 duration above 5 seconds, unusually high invocations, health function errors |
| API Gateway | 5xx responses |
| ECS | CPU above 80%, memory above 80% |
| Load balancer | Unhealthy targets, target 5xx responses |
| RDS | CPU above 80%, connections above 40, free storage below 2 GB |

Alarms require several bad data points before firing, and missing data is treated as healthy, to reduce false alerts.

## Scaling

- **Lambda** scales automatically per request. Reserved concurrency can cap the maximum.
- **ECS Fargate** uses target-tracking auto scaling between 1 and 3 tasks at 60% CPU.
- **RDS** has storage autoscaling enabled. Read replicas are not configured and would be added if read traffic grows.

## Rollback strategy

- **Backend stack:** if a CloudFormation update fails, it rolls back automatically to the last working state. This happened during development, when a deployment failed and the live API stayed on the previous version.
- **Fargate:** the deployment circuit breaker restores the previous task definition if new tasks fail.
- **Frontend:** S3 versioning keeps older files, and redeploying a previous commit restores them.
- **Pipeline:** the deploy job runs only when the tests pass.
- **Lambda gradual rollout:** designed with a 10% canary and alarm-based rollback through CodeDeploy, but not enabled because CodeDeploy is not activated on this AWS account.

## Limitations and next steps

- **GraphQL subscriptions** need WebSockets. The planned approach is an API Gateway WebSocket API or AWS AppSync, which is not implemented.
- The Lambda canary rollback is pending CodeDeploy activation.
- Production hardening: RDS Multi-AZ, per-AZ NAT gateways or VPC endpoints, HTTPS on the internal ALB, verifying the RDS CA certificate, a custom domain with ACM, WAF, remote Terraform state, a tighter least-privilege pipeline role, and approval gates on a production environment.

## Cleanup

```bash
aws cloudformation delete-stack --stack-name graphql-serverless-api
cd infra/terraform && terraform destroy
```
