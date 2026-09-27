// OnMind-XPS stack: one Lambda (Hono app) fronted by an HTTP API (API Gateway v2)
// backed by a single DynamoDB table. The Lambda code is an ASSET of the REPO ROOT
// (the same tree the Bun container runs), so `src/lambda.handler` +
// node_modules ship as-is — no bundling step.
//
// Auth is enforced by the app, not the gateway (same parity idea as XID/XIN):
// XPS_API_KEY (except /health). No usage plan on HTTP API v2 — harden to a
// REST API later if per-key quota is required.
//
// Config is CDK context (cdk.json defaults, overridable with -c key=value):
//   apiKey           OPTIONAL: XPS_API_KEY. Prefer the XPS_API_KEY env var so
//                    the secret never hits argv/shell history. Empty = open
//                    API (fine for Floci/throwaway; set it in prod).
//   removalPolicy    retain (default, prod) | destroy (throwaway/Floci envs)
//   deletionProtection  true (default) | false — blocks even explicit
//                    DeleteTable while the stack exists
//   pointInTimeRecovery true (default) | false — 35-day PITR
//   tablePrefix      prepended to xsetup (multi-env accounts)
//   xpsEnv           XPS_ENV for the app (default production)
//   corsOrigins      comma list → XPS_CORS_ORIGINS
//   localEndpoint    emulator URL (Floci/LocalStack) → AWS_ENDPOINT_URL +
//                    XPS_DYNAMO_ENDPOINT inside the Lambda
'use strict'
const path = require('node:path')
const cdk = require('aws-cdk-lib')
const lambda = require('aws-cdk-lib/aws-lambda')
const dynamodb = require('aws-cdk-lib/aws-dynamodb')
const apigwv2 = require('aws-cdk-lib/aws-apigatewayv2')
const { HttpLambdaIntegration } = require('aws-cdk-lib/aws-apigatewayv2-integrations')
const logs = require('aws-cdk-lib/aws-logs')

const REPO_ROOT = path.join(__dirname, '..', '..')

function ctx(stack, key, def = '') {
  const v = stack.node.tryGetContext(key)
  return v === undefined || v === null || v === '' ? def : v
}

function ctxBool(stack, key, def) {
  const v = stack.node.tryGetContext(key)
  if (v === undefined || v === null || v === '') return def
  return v === true || v === 'true'
}

function ctxList(stack, key) {
  return String(ctx(stack, key, ''))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

class XpsStack extends cdk.Stack {
  constructor(scope, id, props = {}) {
    super(scope, id, props)

    const tablePrefix = String(ctx(this, 'tablePrefix', ''))
    const removal =
      String(ctx(this, 'removalPolicy', 'retain')).toLowerCase() === 'destroy'
        ? cdk.RemovalPolicy.DESTROY
        : cdk.RemovalPolicy.RETAIN
    const deletionProtection = ctxBool(this, 'deletionProtection', true)
    const pitr = ctxBool(this, 'pointInTimeRecovery', true)

    // ---------- DynamoDB ----------
    // Schema must match src/dynamoStore.js: pk (S) = PARAM#<name> |
    // SECRET#<name>, data (S) = full entry JSON + flat attrs. No TTL
    // (parameters/secrets don't expire).
    const setupTable = new dynamodb.Table(this, 'xsetupTable', {
      tableName: `${tablePrefix}xsetup`,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: pitr },
      removalPolicy: removal,
      deletionProtection,
    })

    // ---------- Lambda env ----------
    // XPS_API_KEY is optional at synth: empty means the API runs open —
    // fine for Floci/throwaway, set it for prod. Prefer the XPS_API_KEY
    // env var so the secret never hits argv/history.
    const apiKey = process.env.XPS_API_KEY || String(ctx(this, 'apiKey', ''))
    // XPS_ENCRYPTION_KEY is REQUIRED at runtime in production (fail fast in
    // crypto.js); pass it via env, never via -c context (would leak to history).
    const encKey = process.env.XPS_ENCRYPTION_KEY || ''

    const fnEnv = {
      XPS_ENV: String(ctx(this, 'xpsEnv', 'production')),
      XPS_STORAGE: 'dynamodb',
      XPS_TABLE: setupTable.tableName,
    }
    if (apiKey) fnEnv.XPS_API_KEY = apiKey
    if (encKey) fnEnv.XPS_ENCRYPTION_KEY = encKey
    const cors = ctxList(this, 'corsOrigins')
    if (cors.length) fnEnv.XPS_CORS_ORIGINS = cors.join(',')

    // Floci/LocalStack: SDK v3 resolves AWS_ENDPOINT_URL globally; storage
    // additionally honours XPS_DYNAMO_ENDPOINT (both set for belt and braces).
    const localEndpoint = String(ctx(this, 'localEndpoint', ''))
    if (localEndpoint) {
      fnEnv.AWS_ENDPOINT_URL = localEndpoint
      fnEnv.XPS_DYNAMO_ENDPOINT = localEndpoint
    }

    // ---------- Lambda ----------
    const xpsFn = new lambda.Function(this, 'XpsFunction', {
      description: 'OnMind-XPS parameters & secrets (Hono, HTTP API only)',
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'src/lambda.handler',
      // Repo-root asset: keep in sync with the tree the Bun container runs.
      code: lambda.Code.fromAsset(REPO_ROOT, {
        exclude: [
          '.git',
          '.github',
          'cdk', // this CDK app + its node_modules
          'PLAN.md',
          'xsetup.json', // local throwaway data, never ship
          '.env',
          '.dev.vars',
          '*.log',
          'bun.lock',
        ],
      }),
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
      environment: fnEnv,
      // Explicit log group (retention set here; `logRetention` is deprecated).
      logGroup: new logs.LogGroup(this, 'XpsLogs', {
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: removal,
      }),
    })
    setupTable.grantReadWriteData(xpsFn)

    // ---------- HTTP API ----------
    const api = new apigwv2.HttpApi(this, 'XpsHttpApi', {
      apiName: `${tablePrefix}xps-api`,
      description: 'OnMind-XPS API (parameters & secrets)',
    })

    const integration = new HttpLambdaIntegration('LambdaIntegration', xpsFn)
    api.addRoutes({ path: '/{proxy+}', methods: [apigwv2.HttpMethod.ANY], integration })
    api.addRoutes({ path: '/', methods: [apigwv2.HttpMethod.ANY], integration })

    // ---------- Outputs ----------
    new cdk.CfnOutput(this, 'ApiEndpoint', {
      value: api.apiEndpoint,
      description: 'Base URL (parameters & secrets entry point)',
    })
    new cdk.CfnOutput(this, 'ApiId', {
      value: api.apiId,
      description: 'HTTP API id (for future custom-domain ApiMapping)',
    })
    new cdk.CfnOutput(this, 'FunctionName', { value: xpsFn.functionName })
    new cdk.CfnOutput(this, 'SetupTable', { value: setupTable.tableName })
  }
}

module.exports = { XpsStack }
