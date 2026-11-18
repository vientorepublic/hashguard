# AGENTS.md — hashguard-server

NestJS (TypeScript) Proof-of-Work CAPTCHA API. Redis-backed, SHA-256, adaptive difficulty. Full usage/env/API details: `README.md`, `docs/adaptive-pow.md`, `docs/deployment.md`, `docs/docker-hardening.md`.

## Commands

- **Redis required for anything but unit tests:** `docker compose up -d redis`.
- Dev: `npm run start:dev` — API `http://localhost:3000/v1`, Swagger `/docs`.
- **Unit:** `npm test` (vitest `run`). The config (`vitest.config.ts`) ignores `*.e2e-spec.ts`, so `npm test` never runs E2E.
- **E2E:** `npm run test:e2e` — uses `vitest.e2e.config.ts`, needs a live Redis + HTTP. `pool: forks` + `singleFork` keep shared Redis state serial (replaces Jest's `--runInBand`).
- **Lint (local rewrites):** `npm run lint` runs ESLint `--fix`. CI runs the non-mutating form `npx --no-install eslint '{src,test}/**/*.ts'`.
- **Typecheck:** no npm script — use `npx tsc --noEmit` (what CI does).
- **Build:** `npm run build` (`nest build`, `deleteOutDir`).
- Docker: `docker compose up --build -d` (hardened app + Redis).

CI gate order (`.github/workflows/checks.yml`): lint(no `--fix`) → `tsc --noEmit` → build → unit → E2E(real Redis) → Docker image build → hardening scripts.

## Structure

- Entry: `src/main.ts` → `src/app.module.ts`. Global prefix is `v1`; `/.well-known/jwks.json` is the one route **excluded** from the prefix (set in `main.ts`).
- Modules live under `src/api/v1/modules/`: `pow` (core), `health`, `metrics`. Redis wrapper: `src/modules/redis`. Shared: `src/common` (body parser, graceful shutdown, exception filter, proxy-IP util), `src/config` (configuration + env validation).
- Core PoW endpoints: `POST /v1/pow/assessments` (recommended), `POST /v1/pow/challenges` (legacy), `POST /v1/pow/verifications`, `POST /v1/pow/assertions/introspect`, `GET /.well-known/jwks.json` (+ legacy alias `GET /v1/pow/assertions/verification-key`), `GET /v1/metrics/pow`, `GET /v1/health[/liveness]`.

## Environment & runtime gotchas

- Copy `.env.example` → `.env`. Validation lives in `src/config/env.validation.ts`.
- **Production fails to start unless exactly one** of `POW_TOKEN_PRIVATE_KEY_PEM` / `POW_TOKEN_PRIVATE_KEY_BASE64` is set (mutually exclusive), **and** `POW_RISK_KEY_SECRET` ≥32 chars (same on every replica). Dev/test auto-generate an ephemeral ES256 key — do not rely on it for real deployments.
- `POW_RATE_TIERS_JSON` must be a non-empty array that **includes a `minRpm=0` tier** or validation rejects it.
- `TRUSTED_PROXY` ∈ `none | cloudflare | x-forwarded-for` (default `none`). Behind Cloudflare, configure the `CF-Connecting-IP` trust chain, or per-IP limits misbehave.
- Docker port mapping: app `127.0.0.1:8000→3000`, Redis `127.0.0.1:6400→6379`. Container is read-only FS, `cap_drop ALL`, `no-new-privileges`, SIGTERM graceful shutdown.

## Hardening / deploy / rollback tests

- `scripts/test-docker-hardening.sh` (env `IMAGE`, `SKIP_BUILD=1`, optional `SIGNAL=SIGINT`) and `scripts/test-graceful-shutdown.sh` (env `IMAGE`, `SKIP_BUILD=1`) — need a built Docker image.
- `tests/ops/test_deployment.py` — Python unittest for deploy/rollback logic; CI runs `python3 -m unittest discover -s tests/ops -v`.
- **Only the server deploys.** Push to `main` → checks → WireGuard → root SSH → Docker Compose on `10.20.0.1` (`~/hashguard`). `deploy-server.yml` can be manually dispatched on `main` (re-runs checks; no skip-CI switch). Rollback = dispatch `Deploy Server` on a main commit containing a reviewed revert. See `docs/deployment.md`.
- Renovate targets the `dev` branch.

## Domain invariants

- Proof tokens are single-use JWTs (ES256, claims `jti`/`sub`/`context`). `introspect` defaults to `consume=true`. If Redis can't confirm usage state, introspection returns `503 POW_TOKEN_STATE_UNAVAILABLE` (fail-closed). Default policy: `1 assertion = 1 protected request`.
- Token consumption is atomic in Redis; signature can be verified statelessly via JWKS, but only introspection confirms single-use.
