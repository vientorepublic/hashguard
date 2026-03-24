# Hashguard

Hashguard is a general-purpose Proof-of-Work (PoW) CAPTCHA REST API that mitigates automated bot requests by applying [Bitcoin mining concepts](https://bitcoin.org/bitcoin.pdf) (hash-based proof-of-work).

- Server: NestJS (TypeScript)
- Storage: Redis (challenge TTL, replay prevention, rate window)
- Hash Algorithm: SHA-256
- Policy: Dynamic difficulty adjustment based on request frequency and failure rate

## How It Works

Hashguard imposes a computational cost (hash computation) on clients for each request, reducing the throughput of attackers per unit time.

As traffic spikes or failure rates increase, difficulty ramps up, forcing bots to consume more CPU/GPU resources to maintain the same request volume.

By using short-TTL, single-use proof tokens, we also reduce replay attacks, continuously worsening the cost-effectiveness of large-scale automated requests.

## Core Concepts

1. The client requests and receives a challenge.
2. It searches for a nonce that satisfies `SHA-256(challengeId:seed:nonce) <= target`.
3. The client submits the nonce to the server. Upon successful verification, it receives a short-lived `proofToken`.
4. The resource server validates/consumes the `proofToken` via introspection to authorize the request.

The default policy is `1 solve = 1 protected request` (single-use).

## Architecture Overview

- `POST /v1/pow/challenges`: Issue a challenge
- `POST /v1/pow/verifications`: Verify nonce and issue proof token
- `POST /v1/pow/assertions/introspect`: Verify/consume proof token
- `GET /.well-known/jwks.json`: Public JWKS document for stateless proof-token verification
- `GET /v1/pow/assertions/verification-key`: Single public JWK (backward-compatible alias)
- `GET /v1/metrics/pow`: Operational metrics snapshot
- `GET /v1/health`, `GET /v1/health/liveness`: Health checks

### Proof Token Format

- Proof token is a JWT (`header.payload.signature`) signed with ECDSA P-256 (`ES256`).
- JWT header carries `alg: "ES256"`, `typ: "JWT"`, and `kid` (SHA-256 fingerprint of the SPKI public key).
- Core claims: `jti` (token ID), `sub` (client IP), `context`, `iat`, `exp`.
- Tokens are short-lived and single-use by policy.
- The corresponding public key is exposed as a standard JWKS document at `GET /.well-known/jwks.json`.

### Difficulty Calculation

- Input signals: sustained RPM (1-minute weighted window), burst RPM (10-second window × 6), and failure rate per minute — all per IP
- Base difficulty: `POW_BASE_DIFFICULTY_BITS`
- Max difficulty: `POW_MAX_DIFFICULTY_BITS`
- `effectiveRpm = max(sustainedRpm, burstRpm)` — bursts are penalised immediately without waiting for the 1-minute window to fill
- `extraBits` are added from `POW_RATE_TIERS_JSON` based on `effectiveRpm`; each 5 failure RPM adds an additional 2 bits
- If sustained RPM exceeds `POW_MAX_CHALLENGE_RPM`, challenge issuance is rejected with `429` before any Redis write

Default rate tier table (overridable via `POW_RATE_TIERS_JSON`):

| RPM threshold | Extra bits |
| ------------- | ---------- |
| ≥ 30          | +6         |
| ≥ 20          | +4         |
| ≥ 10          | +2         |
| ≥ 5           | +1         |
| < 5           | +0         |

## Quick Start

### 1) Install Dependencies

```bash
npm install
```

### 2) Prepare Environment Variables

```bash
cp .env.example .env
```

### 3) Run Redis

```bash
docker compose up -d redis
```

If you already have a local Redis instance, update `.env` with the connection details.

### Run App + Redis Together with Docker

```bash
docker compose up --build -d
```

- API Base URL: `http://localhost:3000/v1`
- Swagger: `http://localhost:3000/docs`

To stop:

```bash
docker compose down
```

### 4) Start Development Server

```bash
npm run start:dev
```

- API Base URL: `http://localhost:3000/v1`
- Swagger: `http://localhost:3000/docs`

## API Usage Examples

### 1) Issue a Challenge

```bash
curl -s -X POST http://localhost:3000/v1/pow/challenges \
	-H 'content-type: application/json' \
	-d '{"context":"login"}'
```

Example response:

```json
{
  "challengeId": "f2d8a3b5-...",
  "algorithm": "sha256",
  "seed": "9c0f...",
  "difficultyBits": 21,
  "target": "00000fffff...",
  "issuedAt": "2026-03-16T13:00:00.000Z",
  "expiresAt": "2026-03-16T13:10:00.000Z"
}
```

### 2) Calculate Nonce

The client brute-forces to find a nonce satisfying:

```text
sha256(challengeId:seed:nonce) <= target
```

### 3) Submit Verification

```bash
curl -s -X POST http://localhost:3000/v1/pow/verifications \
	-H 'content-type: application/json' \
	-d '{
		"challengeId":"f2d8a3b5-...",
		"nonce":"4829371",
		"clientMetrics":{"solveTimeMs":850}
	}'
```

On success, a `proofToken` is returned.

### 4) Introspect Proof Token

```bash
curl -s -X POST http://localhost:3000/v1/pow/assertions/introspect \
	-H 'content-type: application/json' \
	-d '{"proofToken":"<TOKEN>","consume":true}'
```

- `consume=true` (default): Token is consumed on successful verification
- `consume=false`: Read-only verification
- If token usage state cannot be verified safely (e.g., Redis failure), introspection returns `503 POW_TOKEN_STATE_UNAVAILABLE` (fail-closed policy).

### 5) Fetch Public Verification Keys

```bash
curl -s http://localhost:3000/.well-known/jwks.json
```

The response is a standard JWKS document with a `keys` array. SDKs can cache it and verify proof-token signatures statelessly without sending each token back to HashGuard.

For backward compatibility, HashGuard also keeps exposing the first key as a single JWK at `/v1/pow/assertions/verification-key`.

## Environment Variables

Key configuration is documented in `.env.example`.

- `PORT`: Server port
- `TRUSTED_PROXY`: `cloudflare | x-forwarded-for | none`
- `CORS_ORIGINS`: Allowed origins (`*` or comma-separated)
- `REDIS_*`: Redis connection details
- `POW_CHALLENGE_TTL_SECONDS`: Challenge validity period (default: `120`)
- `POW_PROOF_TOKEN_TTL_SECONDS`: Proof token validity period (default: `300`)
- `POW_TOKEN_PRIVATE_KEY_PEM`: PKCS#8 PEM private key used to sign ES256 proof tokens
- `POW_TOKEN_PRIVATE_KEY_BASE64`: Base64-encoded PKCS#8 PEM private key; use this if multiline env vars are inconvenient
- `POW_BASE_DIFFICULTY_BITS`: Base difficulty (default: `21`)
- `POW_MAX_DIFFICULTY_BITS`: Maximum difficulty (default: `26`)
- `POW_MIN_SOLVE_TIME_MS`: Threshold for flagging abnormally fast solves, server-observed (default: `50`)
- `POW_MAX_FAILURES_PER_CHALLENGE`: Allowed failures per challenge before it is consumed (default: `10`)
- `POW_MAX_CHALLENGE_RPM`: Per-IP challenge issuance rate limit; requests above this threshold receive `429` (default: `60`)
- `POW_RATE_TIERS_JSON`: JSON array overriding the default RPM → extra-bits mapping. Must be sorted descending by `minRpm` or will be sorted automatically. Example: `[{"minRpm":30,"extraBits":6},{"minRpm":0,"extraBits":0}]`
- `METRICS_MAX_DIFFICULTY_DISTRIBUTION_KEYS`: Max keys for difficulty distribution metrics (default: `64`)

### Generating an ES256 Signing Key

In development and tests, HashGuard generates an ephemeral P-256 key pair automatically if no private key is configured.
In production, set exactly one of `POW_TOKEN_PRIVATE_KEY_PEM` or `POW_TOKEN_PRIVATE_KEY_BASE64`.

Example using OpenSSL:

```bash
openssl ecparam -name prime256v1 -genkey -noout -out hashguard-es256-key.pem
openssl pkcs8 -topk8 -nocrypt -in hashguard-es256-key.pem -out hashguard-es256-key.pk8.pem
```

To place the PEM directly in `.env`, escape newlines:

```env
POW_TOKEN_PRIVATE_KEY_PEM="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
```

Or base64-encode the PKCS#8 PEM and use:

```bash
base64 < hashguard-es256-key.pk8.pem | tr -d '\n'
```

```env
POW_TOKEN_PRIVATE_KEY_BASE64=<base64-of-pkcs8-pem>
```

Recommendations:

- Keep the private key out of source control.
- Use different keys for development, staging, and production environments.
- When rotating keys, note that existing proof tokens will become invalid, so plan accordingly.

Runtime enforcement:

- In production, startup fails unless one private key variable is set.
- `POW_TOKEN_PRIVATE_KEY_PEM` and `POW_TOKEN_PRIVATE_KEY_BASE64` are mutually exclusive.

## Testing

### Unit Tests

```bash
npm test
```

### E2E Tests

Redis must be running:

```bash
npm run test:e2e -- --runInBand
```

## Security & Operations

- In production, always set an explicit ES256 private signing key.
- Proof tokens are JWT (ES256) and the default policy is single-use (`consume=true`).
- Clients can verify token integrity statelessly with `/.well-known/jwks.json`, but only introspection can confirm single-use state.
- Token consumption is enforced atomically in Redis to prevent concurrent replay acceptance.
- If Redis cannot confirm token usage state, token verification fails closed with `503` to protect integrity.
- If behind Cloudflare, configure the `CF-Connecting-IP` header trust chain correctly.
- Tune difficulty values (`BASE/MAX`) based on client device performance and traffic patterns. The default max is 32 bits (~4 billion hashes); lower this if targeting low-powered clients such as mobile browsers.
- Use `POW_RATE_TIERS_JSON` to adjust rate thresholds at runtime without redeploying.
- Challenge TTL defaults to 120 seconds. Keeping it short limits the window for pre-computed challenge attacks.
- `POW_MAX_CHALLENGE_RPM` acts as a hard issuance gate before any Redis writes, protecting the server under heavy burst traffic.

## Integrations

Hashguard can be integrated with official SDK packages to protect any resource endpoint. The SDK handles the challenge/verification flow and token management, while the resource server performs token introspection to authorize requests.

For more info on integration patterns and best practices, see the [Repository](https://github.com/vientorepublic/hashguard-client).

## Current Scope & Future Extensions

Current scope:

- Standalone NestJS PoW API server
- Redis-based challenge/replay/rate management
- OpenAPI (Swagger), health checks, metrics

Future extension ideas:

- ~~Browser/mobile SDKs~~
- Official middleware/guard packages for resource protection services
- ~~Offline token verification using public key signatures~~

## License

MIT
