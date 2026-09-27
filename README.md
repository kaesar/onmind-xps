# OnMind-XPS — eXpress Parameters & Secrets

Express, free, serverless sibling of **OnMind-SPI** (and of **XID** `:8787` / **XIN** `:8788`).
Same stack/philosophy: **Bun 1.4 + Hono 4** locally, **Lambda Node 24** in cloud.
This service runs on **`:8789`**.

- Local: single `xsetup.json` (`{params, secrets}`), inspectable with `cat`.
- Cloud: single DynamoDB table `xsetup` (`pk = PARAM#<name> | SECRET#<name>`).
- Secrets + `SecureString` params encrypted with **AES-256-GCM (WebCrypto, zero deps)**,
  key in `XPS_ENCRYPTION_KEY`. `String`/`StringList` params are plaintext.

> Honest warning: v1 encrypts at app level with a key in env (no KMS, no auto-rotation).
> Suitable for labs/PoC and low-risk secrets.

## Quickstart

```bash
cp .env.example .env
bun install
bun run dev
curl -s http://localhost:8789/health
bun run smoke
```

> Works on `localhost:8789`

Docker:

```bash
docker build -t onmind-xps . && docker run -p 8789:8789 -v /srv/xps:/data onmind-xps
```

## API

| Method | Route | Notes |
|---|---|---|
| `GET` | `/health` | `{ok, env, storage}` — always open |
| `PUT` | `/parameters/*` | `{value, type?, description?, tags?}` — creates v1 or bumps `version++` |
| `GET` | `/parameters/*` | single (URL-encode the name: `/parameters/%2Fapp%2Fdb%2Fhost`) |
| `DELETE` | `/parameters/*` | `204` |
| `GET` | `/parameters?path=/a&maxResults=50&nextToken=` | prefix list, paginated |
| `POST` | `/secrets` | `{name, secretString\|secretBinary, description?, tags?}` → `201 {name, versionId (UUID), versionStages}` |
| `GET` | `/secrets/:id[?versionId=]` | value (+ `AWSCURRENT` by default) |
| `PUT` | `/secrets/:id` | `{secretString\|secretBinary, description?}` → rotates (`AWSCURRENT`/`AWSPREVIOUS`) |
| `DELETE` | `/secrets/:id[?forceDelete=true]` | direct delete → `204` (no recovery window in v1) |
| `GET` | `/secrets?maxResults=50&nextToken=` | **metadata only, never values** |

Types: params `String | StringList | SecureString` (`SecureString` encrypted like a secret).
`secretBinary` is base64 on the wire. `versionId` is UUID v4 (AWS/SPI-compatible).
Errors are JSON `{message}` with `400/403/404/500`. Auth: `x-api-key` header on
everything except `/health` (only when `XPS_API_KEY` is set; leave empty locally).

```bash
curl -s -X PUT http://localhost:8789/parameters/%2Fapp%2Fdb%2Fhost \
  -H 'Content-Type: application/json' -d '{"value":"db.local","type":"String"}'
curl -s http://localhost:8789/parameters/%2Fapp%2Fdb%2Fhost
curl -s -X POST http://localhost:8789/secrets \
  -H 'Content-Type: application/json' -d '{"name":"api/stripe","secretString":"sk-test"}'
curl -s http://localhost:8789/secrets/api%2Fstripe
```

## Configuration

| Var | Default | Use |
|---|---|---|
| `PORT` | `8789` | local http |
| `XPS_STORAGE` | `json` / auto `dynamodb` if `XPS_TABLE` set | backend (typo → loud error) |
| `XPS_JSON_PATH` | `./xsetup.json` | single local file |
| `XPS_TABLE` | `xsetup` | DynamoDB table |
| `XPS_DYNAMO_ENDPOINT` | — | custom endpoint (LocalStack / Floci) |
| `XPS_ENCRYPTION_KEY` | — (dev: ephemeral + warning; prod: **required**) | 32 bytes as 64-char hex or base64 (`openssl rand -hex 32`) |
| `XPS_API_KEY` | — (empty = open) | `x-api-key` gate (except `/health`) |
| `XPS_CORS_ORIGINS` | `*` | CORS allowlist |
| `XPS_KMS_KEY_ID` | — (reserved) | no effect in v1 |
| `XPS_ENV` | `dev` | `production` fails fast without storage/key |
| `AWS_REGION` | `us-east-1` | DynamoDB / Lambda region |

## Other apps integration

Any app (incl. XID/XIN) can read config with `GET /parameters/:name` + `x-api-key`
instead of env files. SPI can import `xsetup.json` (`format: xsetup/v1`) — see `PLAN.md §13`.

## Deploy

See `cdk/ARCHITECTURE.md`. Summary:

```bash
export XPS_API_KEY=$(openssl rand -hex 32)
export XPS_ENCRYPTION_KEY=$(openssl rand -hex 32)
cd cdk && npm install && npx cdk bootstrap
npx cdk deploy
```
