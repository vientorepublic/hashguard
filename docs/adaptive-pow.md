# Adaptive PoW

The SDK's default `execute(context)` calls `POST /v1/pow/assessments` with `{ "context": "search" }`. It no longer solves a puzzle for every request.

| Decision | HTTP | Response | SDK behavior |
| --- | --- | --- | --- |
| Low risk | 200 | `{action:"allow", riskScore, verification:{proofToken,expiresAt}}` | Return immediately; no solver or verification request |
| Suspicious | 200 | `{action:"challenge", riskScore, challenge:{challengeId,algorithm,seed,difficultyBits,target,issuedAt,expiresAt}}` | Solve and POST `/v1/pow/verifications` |
| Hard limit | 429 | `{code:"POW_ADAPTIVE_RATE_LIMITED", ...}` plus `Retry-After: 60` | Propagate error; no solver retry |
| Risk store unavailable | 503 | `{code:"POW_RISK_UNAVAILABLE", ...}` | Fail closed |

Both successful paths produce the existing ES256 assertion. A signed low-risk assertion means the server allowed the request without work; it does not claim that work was solved. The assertion is bound to IP and context, expires after the configured token TTL, and must be consumed once through introspection. Its budget is **one request**, with no reusable pass cache. Signature verification alone does not enforce this budget.

## Signals and policy

Risk state is shared in Redis, keyed by HMAC-SHA256(secret, `ip\0` + IP). One Lua script atomically updates each subject's state using Redis TIME, so concurrent replicas agree. It uses a 60-second weighted current/previous window for requests and costs, a 5-second weighted window for bursts, and a failure score with a 300-second half-life. Normal requests do not accumulate failure events. State expires after 30 minutes of inactivity.

Context cost is configured on the server: default `search=3`, `query=5`, `export=20`, other labels cost 1. All contexts share the same IP counters. Changing labels cannot reset usage. The resource backend must enforce its expected context; otherwise a caller could use a cheap-context assertion on an expensive endpoint. No client-supplied risk score, cost, device timing or browser fingerprint is trusted.

```
V = clamp(ln(max(1, units60 / softUnits)) / ln(8), 0, 1)
B = clamp((max(0, units5 - currentCost) / burstSoftUnits - 1) / 2, 0, 1)
F = clamp(decayedFailures / 5, 0, 1)
R = 35V + 20B + 20F
challenge = R >= threshold
bits = clamp(round(baseBits + 6R/100), baseBits, maxBits)
```

This implements the document's available server-observed V/B/F signals. C/P signals are omitted because the issuer has no trustworthy application-cost distribution or protocol-mismatch telemetry; the score therefore ranges from 0 to 75. The burst normalization is calibrated separately for a five-second window. Thresholds are starting hypotheses, not calibrated attack probabilities. An isolated request within the soft velocity allowance has score zero, including one expensive export. The current request cost is excluded from the burst signal, so a single operation alone is not classified as a repeated-request pattern.

Hard limits use continuously refilling token buckets, separate from the approximate risk windows. Before token or challenge issuance, the request-count (60-second refill), weighted-cost (60-second refill), and burst-cost (five-second refill) buckets are all checked, then all debited or all rejected atomically. Bucket capacities are the configured hard limits; refill rates are capacity divided by the stated interval, so the policy permits an initial burst plus continuous refill rather than promising an exact rolling-window count. Fixed-window boundaries never reset hard budgets. Rejected attempts still contribute to risk observations without debiting hard budgets. Verification has a separate per-IP limit checked before looking up a challenge, including unknown IDs. Invalid proofs, unknown/expired challenges and IP mismatches add decaying failure risk.

| Setting | Default |
| --- | --- |
| `POW_RISK_KEY_SECRET` | Required, at least 32 characters in production; random per process in development |
| `POW_SOFT_LIMIT_UNITS` / `POW_HARD_LIMIT_UNITS` | 30 / 120 per 60 seconds |
| `POW_BURST_SOFT_LIMIT_UNITS` / `POW_BURST_HARD_LIMIT_UNITS` | 5 / 30 per 5 seconds |
| `POW_MAX_CHALLENGE_RPM` | 60-token capacity, 1 token/second refill, shared across adaptive and explicit issuance |
| `POW_CHALLENGE_RISK_THRESHOLD` | 20 |
| `POW_MAX_VERIFICATION_RPM` | 120 |
| `POW_CONTEXT_COSTS_JSON` | `{"search":3,"query":5,"export":20}` |
| `POW_BASE_DIFFICULTY_BITS` / `POW_MAX_DIFFICULTY_BITS` | 16 / 24 |
| `POW_MIN_SOLVE_TIME_MS` | 0: a lucky valid nonce is not rejected for being fast |
| `TRUSTED_PROXY` | `none` |

Use the same risk secret and signing key on every replica. Generate a secret with `openssl rand -hex 32`. Changing the risk secret resets the observation identity; coordinate rotations across replicas. Development ephemeral secrets are only suitable for one process.

## Integration and migration

1. Deploy the server with shared secrets and configure thresholds from normal traffic. Existing environment values override the new defaults; update existing difficulty/minimum-time settings deliberately.
2. Update the SDK. `execute()` uses assessments; narrow `result.challengeRequired` before accessing `challenge` or `solveResult` (both null for allow). `result.verification.proofToken` exists in both branches.
3. Obtain a fresh assertion for each protected request. The resource backend checks expected context, original client IP and authentication, then consumes the token with `/v1/pow/assertions/introspect` (`consume=true`, the default; pass `expectedSubject` and `expectedContext` so binding is checked before consumption) before running the operation. Keep independent application rate limits and concurrency limits at execution time, since assertions can be obtained before use.
4. `issueChallenge()` and `/challenges` remain explicit-work APIs for existing consumers; they also pass through the shared hard limits and their difficulty cannot be lower than the adaptive risk calculation. The SHA-256 `challengeId:seed:nonce` format and stored challenge records are retained, rather than replacing the solver protocol with HMAC challenge tokens.

Forwarded headers are opt-in. With `cloudflare` or `x-forwarded-for`, restrict origin access to the trusted proxy externally, which must overwrite the relevant header. Merely selecting a mode is not proxy authentication. Do not enable it on a publicly reachable origin that accepts forged headers.

This issuer does not host application endpoints or authenticate accounts/sessions. Account/session limits, trusted backend failure telemetry, route/method/body binding, broad-prefix observations, multi-request pass budgets, shadow rollout and adaptive-decision dashboards remain application integrations or future work. IP-only detection has shared-NAT and address-rotation limitations. Challenge and proof assertions retain existing IP claims; raw IPs have been removed from PoW debug logs, but this is not a comprehensive privacy migration of legacy Redis keys.

## Verification

`npm test -- --runInBand` covers policy decisions, default SDK behavior, hard-limit propagation, failure handling, explicit expiry, and the challenge-consumption race using mocked storage. Build and lint checks apply to both repositories.

With a dedicated Redis instance available, run `npm run test:e2e -- --runInBand`. `adaptive.e2e-spec.ts` uses real Lua state under a unique Redis prefix to cover low-risk single-use assertions, challenge solving with concurrent verification, concurrent limits, failure decay and window carry-over. These tests also cover token-bucket rejection without partial debit and are separate from mocked unit evidence. Existing HTTP E2E tests also require permission to bind a local socket.

## Resource backend constraints

```ts
// originalClientIp must come from your trusted ingress, not a browser body/header.
const access = await guard.checkAccess(proofToken, {
  token: proofToken,
  subject: originalClientIp,
  context: 'search',
  consume: true,
});
if (!access.allowed) return rejectRequest();
```

The SDK passes expected subject/context to introspection and checks both locally and on cached inspection results. Binding mismatches do not spend the token. `consume: false` is read-only inspection and may use a cache; it is not a single-use authorization mechanism. Request-driven unknown-key JWKS refreshes are coalesced and rate-limited to one attempt per 30 seconds per SDK instance, including failed requests. Key rotation can therefore take up to 30 seconds to become visible; an operator can explicitly force-refresh the keyset.

JSON request bodies are limited to 2 KiB in the application bootstrap. Oversize/malformed JSON receives 413/400. Deployments should also apply ingress limits before request parsing.
