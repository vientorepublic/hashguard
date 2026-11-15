# Adaptive PoW code review

Date: 2026-11-16 (Asia/Tokyo)

Scope: uncommitted adaptive PoW work in `hashguard-server` and `hashguard-client`, including adjacent token validation and resource authorization paths. The local `review-bugbot` and `security-review` skills were read and applied. A dedicated Bugbot execution tool was unavailable; exactly one read-only review agent followed the Bugbot review instructions. Security inspection traced request DTOs, trusted-IP extraction, Redis state, token issuance, introspection, SDK validation and resource checks.

## Read-only reviewer findings

All four findings were patched. Locations below refer to the remediation code, not the original vulnerable line numbers.

| Severity | Location (file:line) | Finding |
| --- | --- | --- |
| High | `hashguard-client/src/resource-guard.ts:118` | ResourceGuard had no way to bind an assertion to the actual requester IP. Integrations relying on the guard without an independent subject check could relay an assertion issued under a low-risk IP. Added `subject`, compared it before consumption and on cached results, and forwarded expected subject/context to server introspection. The resource backend must supply the trusted original IP. |
| Medium | `hashguard-client/src/client.ts:395` | Attacker-controlled unknown JWT key IDs could force one issuer keyset refresh per request. Added a 30-second request-driven refresh cooldown, including failures, and single-flight fetch deduplication. Invalid JWT headers are rejected before key lookup. |
| Medium | `hashguard-client/src/token-validator.ts:158` | Client expiration used `now > exp` while the server rejected `now >= exp`. Aligned the boundary; added a clock-controlled regression test. |
| Medium | `hashguard-client/src/resource-guard.ts:88` | Public-key lookup/stateless validation exceptions escaped the access guard. Moved them inside its fail-closed handler so issuer/network errors return `allowed:false`. |

## Additional corrections

- Challenge verification previously used an unconditional delete after reading a record. Two concurrent valid solutions could each issue an assertion. Token issuance now requires winning the atomic challenge deletion, and explicit challenge expiry is checked even if stale storage returns a record.
- The legacy explicit-work endpoint could return a lower difficulty than the failure-sensitive adaptive policy. It now uses the greater difficulty from the two policies.
- Hard limits now use a single atomic multi-dimension token-bucket decision, independently of approximate risk-observation windows. Rejecting a request does not partially debit the other budgets. Context rotation cannot reset the shared subject counters.
- Context constraints are checked before token consumption. Empty or missing contexts do not silently match a requested context. Cache hits recheck both expected bindings; consuming a token invalidates that guard's read cache.
- Out-of-range JWT timestamps are rejected instead of throwing during ISO date conversion.
- JSON body parsing is capped at 2 KiB, with sanitized 413/400 responses. Forwarded-header trust is disabled by default. IPs were removed from PoW debug messages.
- The burst signal excludes the current request's cost. One expensive request alone does not become a repeated-request pattern.

## Validation evidence

- Server: Nest build, TypeScript no-emit compilation and ESLint passed; **53 unit tests across 7 suites passed**.
- SDK: TypeScript checks and ESLint passed; **40 unit tests across 5 suites passed**.
- SDK ESM/CJS bundles and declarations were rebuilt using the existing WASM artifact; WASM runtime E2E passed. The unchanged Rust crate was not rebuilt.
- Both repositories passed `git diff --check`.
- Real Redis/HTTP E2E was **not executed**: the execution sandbox denied binding both TCP and Unix sockets (`Operation not permitted`). Added dedicated real-Redis coverage for single-use assertions, concurrent challenge consumption, atomic limits, failure decay, window carry-over, and no partial debit. These remain unverified against a running Redis service in this session.

No deployment, publication or commit was performed. The review does not establish the document's full production completion criteria: account/session controls, application execution limits, shadow-mode calibration, distributed/cluster and mobile performance validation still require their own integration and runtime evidence. See [adaptive-pow.md](adaptive-pow.md) for the exact implemented contract and rollout settings.
