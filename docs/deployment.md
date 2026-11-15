# CI and production deployment

This repository follows LawCast's reusable CI → WireGuard → SSH → Docker Compose → release-health flow. Only the Hashguard server is deployed; the JavaScript SDK is not published by these workflows.

## Triggers and gates

- `CI` (`ci.yml`) runs on pushes to `dev` and `main`, and pull requests targeting `main`.
- Reusable `checks.yml` installs the lockfile, runs non-mutating ESLint, type checks, Nest build, unit tests, real Redis/HTTP E2E, a Docker image build, deployment/rollback fixture tests, actionlint and the WireGuard installer check.
- Only a successful **push to main** invokes reusable `Deploy Server`. PR/dev runs never receive deployment secrets.
- `Deploy Server` can also be manually dispatched **on main**. Manual runs must pass the same checks. There is no skip-CI switch.
- Production deployments are serialized and never canceled by a newer deployment. The remote process also cooperates with LawCast's `/run/container-deploy.lock`, or uses its container-reconcile deployment guard when Hashguard is in the managed inventory.

## Repository settings

Required repository secrets (already provisioned separately):

- `VULTR_WIREGUARD`: complete `wg-quick` configuration for the runner. Its routing must reach `10.20.0.1`; multiple simultaneous clients must not share the same active peer identity.
- `VULTR_SSH_SECRET`: unencrypted OpenSSH private key authorized for **root** on that server.

Optional repository variable `VULTR_SSH_KNOWN_HOSTS` pins the SSH host key. Without it, the workflow enrolls the Ed25519 key over the authenticated WireGuard tunnel. SSH still uses strict host checking against that enrolled key; no public internet SSH target or `StrictHostKeyChecking no` is used. Prefer pinning a separately verified key for long-term operation.

The installer uses the same verified official wireguard-tools release commit as LawCast. Temporary tunnel/key files are mode 0600 and removed in an always-run cleanup step. Secret values are never inserted into shell source or echoed in logs.

## Server prerequisites

- Root login, Git origin access, Python 3, curl, flock, and Docker Compose v2 with `--wait` support.
- Existing checkout at **`$HOME/hashguard` (`/root/hashguard`)**, with origin containing this repository's `main` branch.
- No local changes to tracked files. Untracked files are not cleaned or removed.
- Existing production `.env` and persistent ES256 signing key (`POW_TOKEN_PRIVATE_KEY_PEM` or `POW_TOKEN_PRIVATE_KEY_BASE64`). The deployment does not replace signing keys or other policy values.
- If `POW_RISK_KEY_SECRET` is absent, the locked deployment initializes a random persistent value once in `.env`; an existing value shorter than 32 characters is rejected instead of silently rotated. Back up `.env` through normal secret-management procedures.
- Existing external `gateway_shared_network` and adequate build disk/memory. Existing Redis data volume is retained; no `compose down`, volume deletion, or Docker pruning is performed.
- Selecting a trusted proxy mode in `.env` does not authenticate ingress: retain firewall/proxy-origin restrictions independently.

## Release verification and recovery

The runner sends its exact tested commit SHA. The server fetches main and verifies the commit belongs to it, checks out that SHA without `git clean`, builds the app before restarting it, and starts app/Redis with Compose health waits. It then verifies the running image's OCI revision label and both host/API readiness (including Redis). It records the successful SHA at `$HOME/.local/state/hashguard/deployed-sha` only after all gates pass.

A build failure leaves the running app untouched. A startup, revision or readiness failure attempts to restore only the prior app image with `--no-deps`; it does not roll back Redis data or overwrite `.env`, and the workflow remains failed even if recovery succeeds. Review the job log before retrying. These image rollbacks assume a backward-compatible runtime/data change; future schema changes need a separate migration/recovery plan.

For an intentional rollback, dispatch `Deploy Server` for a main commit containing a reviewed revert. The manual deploy always uses its selected main SHA and reruns checks. Workflow runs and logs, not a successful local lint, establish that a production deployment occurred.

Reference: https://github.com/vientofactory/LawCast/tree/main/.github/workflows
