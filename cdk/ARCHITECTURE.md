# OnMind-XPS — AWS architecture (CDK)

Infrastructure as code for running XPS on AWS (same pattern as XIN):

- **API Gateway (HTTP API v2)** — public front door (`ANY /` + `/{proxy+}`).
  Auth (`x-api-key`) is enforced **by the app**, not the gateway.
- **AWS Lambda** (`nodejs24.x`) — runs the same Hono app as the Bun container.
  Handler: `src/lambda.handler`, packaged as a **repo-root asset** (no bundler).
- **DynamoDB (on-demand)** — single table `xsetup` (pk `pk` S =
  `PARAM#<name>` | `SECRET#<name>`, `data` S = full entry JSON + flat
  `kind/name/version/updatedAt`). **No TTL** (parameters/secrets don't expire).

> CDK app is plain **JavaScript** (CJS, no TypeScript): `bin/app.js` +
> `lib/xps-stack.js`. Node ≥ 20 required.

## Diagram

```mermaid
flowchart LR
  subgraph Dev["Local / CI"]
    SDK["curl / app (XID/XIN)"]
  end

  subgraph AWS["AWS account (Stack: XpsStack)"]
    APIGW["API Gateway<br/>HTTP API · ANY / and /{proxy+}"]
    LFn["Lambda nodejs24.x<br/>src/lambda.handler (Hono)"]
    T1[("DynamoDB xsetup<br/>no TTL")]
  end

  SDK -->|endpoint + x-api-key| APIGW
  APIGW --> LFn
  LFn --> T1
```

Parity: `bun src/dev.js` (container) and Lambda share `src/` — only the
entrypoint and the storage binding differ.

## Configuration reference

All config is **CDK context** (defaults in `cdk/cdk.json`, override with
`-c key=value`) plus env-passed secrets:

| Context              | Default        | Maps to / effect                                   |
| -------------------- | -------------- | -------------------------------------------------- |
| `apiKey`             | *(empty = open)* | `XPS_API_KEY` — prefer `export XPS_API_KEY=...` so the secret stays out of argv/history |
| `tablePrefix`        | `""`           | table name `{prefix}xsetup` (multi-env accounts) |
| `xpsEnv`             | `production`   | `XPS_ENV`                                          |
| `removalPolicy`      | `retain`       | `retain` \| `destroy` — see “DynamoDB in production” |
| `deletionProtection` | `true`         | blocks even explicit `DeleteTable` while stack exists |
| `pointInTimeRecovery`| `true`         | 35-day PITR                                         |
| `terminationProtection` | `false`      | CloudFormation stack deletion guard (enable in prod) |
| `corsOrigins`        | `""`           | comma list → `XPS_CORS_ORIGINS`                     |
| `localEndpoint`      | `""`           | emulator URL → `AWS_ENDPOINT_URL` + `XPS_DYNAMO_ENDPOINT` inside the Lambda (Floci/LocalStack) |

Secrets via env (never `-c`, never committed):

| Env                  | Effect |
| -------------------- | ------ |
| `XPS_API_KEY`        | `XPS_API_KEY` in Lambda (preferred over `-c apiKey`) |
| `XPS_ENCRYPTION_KEY` | `XPS_ENCRYPTION_KEY` in Lambda — **required in production** (fail fast otherwise). Generate with `openssl rand -hex 32` |

Lambda environment (set by the stack): `XPS_ENV`, `XPS_STORAGE=dynamodb`,
`XPS_TABLE`, plus optional `XPS_API_KEY` / `XPS_ENCRYPTION_KEY` / `XPS_CORS_ORIGINS`.

## DynamoDB in production

Defaults mirror XIN — **a `cdk destroy` never loses data**:

| Setting                | Default   | Why                                                                 |
| ---------------------- | --------- | ------------------------------------------------------------------- |
| `removalPolicy`        | `RETAIN`  | Table (and data) stays in the account after stack deletion |
| `deletionProtection`   | `enabled` | even a hand-issued `DeleteTable` is rejected until disabled explicitly |
| `pointInTimeRecovery`  | `enabled` | 35-day point-in-time recovery |
| `billingMode`          | `PAY_PER_REQUEST` | on-demand — no capacity planning |
| Log group              | RETAIN + 14 d | function logs survive destroy, expire after 14 days |

- **Throwaway envs** (Floci, CI): pass
  `-c removalPolicy=destroy -c deletionProtection=false -c pointInTimeRecovery=false`
  so everything is disposable.

Manual equivalent:

```bash
aws dynamodb create-table --table-name xsetup \
  --attribute-definitions AttributeName=pk,AttributeType=S \
  --key-schema AttributeName=pk,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST
```

## Deploy (real AWS)

```bash
# one-time
export AWS_PROFILE=your-profile
cd cdk && npm install
npx cdk bootstrap                                # once per account/region

# every deploy (secrets via env, never argv)
export XPS_API_KEY=$(openssl rand -hex 32)      # never commit this
export XPS_ENCRYPTION_KEY=$(openssl rand -hex 32)
npx cdk diff
npx cdk deploy -c corsOrigins=https://app.example.com
# → ApiEndpoint output (+ ApiId for a future custom-domain mapping)
```

Then call the `ApiEndpoint` output with `x-api-key` on every call except `/health`.

## Test with the Floci simulator

```bash
docker run -d --name floci -p 4566:4566 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  floci/floci:latest

export AWS_ENDPOINT_URL=http://localhost:4566
export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_REGION=us-east-1
export AWS_PAGER=
export CDK_DEFAULT_ACCOUNT=000000000000 CDK_DEFAULT_REGION=us-east-1

cd cdk
npx cdk bootstrap
npx cdk deploy \
  -c removalPolicy=destroy \
  -c deletionProtection=false \
  -c pointInTimeRecovery=false \
  -c localEndpoint=http://host.docker.internal:4566

API=$(aws cloudformation describe-stacks --stack-name XpsStack \
      --query "Stacks[0].Outputs[?OutputKey=='ApiEndpoint'].OutputValue" --output text)
curl -fsS "$API/health"
```

## Security notes

- `XPS_ENCRYPTION_KEY` is **required in production** — the Lambda fails fast
  without it. v1 uses app-level AES-256-GCM with key in env (no KMS, no
  auto-rotation); suitable for labs/PoC and low-risk secrets.
- `XPS_API_KEY` is optional at synth; set it for prod (lands in the Lambda
  environment — move to **Secrets Manager** when hardening for long-lived prod).
- CORS is enforced by the app (same behaviour on both runtimes); the gateway
  adds no second policy to keep parity.
- Asset packaging never ships `xsetup.json` / `.env` / `.dev.vars`.

## Commands

```bash
cd cdk
npm run synth      # cdk synth
npm run diff       # cdk diff
npm run deploy     # cdk deploy
npm run destroy    # cdk destroy
npm run bootstrap  # cdk bootstrap (once per account/region)
```
