#!/usr/bin/env bash
set -euo pipefail

sha=${1:?Usage: deploy-server.sh COMMIT_SHA}
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo 'Invalid commit SHA' >&2; exit 2; }
[[ $(id -u) == 0 ]] || { echo 'Deployment requires root' >&2; exit 1; }

# Cooperate with the same global deployment lock as LawCast. If this compose
# project is monitored by container-reconcile, pause/adopt its inventory too.
if [[ ${HASHGUARD_DEPLOY_LOCKED:-0} != 1 ]]; then
  managed=0
  if [[ -f /etc/container-reconcile/inventory.json ]]; then
    managed=$(python3 - <<'PY'
import json
with open('/etc/container-reconcile/inventory.json') as handle:
    rows = json.load(handle)['containers']
print(int(any(row['project'] == 'hashguard' for row in rows)))
PY
)
  fi
  if [[ "$managed" == 1 ]]; then
    test -x /usr/local/sbin/container-deploy-guard.py
    exec /usr/local/sbin/container-deploy-guard.py --project hashguard --timeout 2100 -- \
      env HASHGUARD_DEPLOY_LOCKED=1 bash "$0" "$sha"
  fi
  exec flock -w 1800 /run/container-deploy.lock env HASHGUARD_DEPLOY_LOCKED=1 bash "$0" "$sha"
fi

cd "$HOME/hashguard"
[[ -d .git && -f .env ]] || { echo 'Expected ~/hashguard checkout and existing .env' >&2; exit 1; }
git diff --quiet && git diff --cached --quiet || { echo 'Tracked server changes must be resolved before deployment' >&2; exit 1; }
# Check the allocator prerequisite before changing the running release or checkout.
map_count=$(sysctl -n vm.max_map_count)
[[ "$map_count" =~ ^[0-9]+$ && "$map_count" -ge 1048576 ]] || {
  echo "hardened_malloc requires host vm.max_map_count >= 1048576 (actual: $map_count)" >&2
  exit 1
}
printf 'Host allocator prerequisite verified: vm.max_map_count=%s\n' "$map_count"

git fetch origin main
git merge-base --is-ancestor "$sha" origin/main || { echo 'Commit is not on origin/main' >&2; exit 1; }
# Do not silently deploy a newer, unchecked main commit.
git checkout -B main "$sha"
[[ $(git rev-parse HEAD) == "$sha" ]]
python3 .github/scripts/prepare-production-env.py .env

export HASHGUARD_DEPLOY_SHA="$sha"
docker compose config --quiet
old_image=$(docker inspect --format '{{.Image}}' hashguard-api 2>/dev/null || true)
rollback_file=''
changed=0
cleanup() { if [[ -n "$rollback_file" ]]; then rm -f "$rollback_file"; fi; }
rollback() {
  rc=$?
  trap - EXIT INT TERM HUP
  if [[ "$changed" == 1 && -n "$old_image" ]]; then
    echo 'Release gate failed; restoring the previous app image' >&2
    rollback_file=$(mktemp /tmp/hashguard-rollback.XXXXXXXX.yml)
    printf 'services:\n  app:\n    image: "%s"\n' "$old_image" > "$rollback_file"
    if docker compose -f docker-compose.yml -f "$rollback_file" up -d --no-build --no-deps --wait --wait-timeout 120 app; then
      echo 'Previous app image restored' >&2
    else
      echo 'App image rollback failed; operator action required' >&2
    fi
  fi
  cleanup
  exit "$rc"
}
trap rollback EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

# Build before touching the running app. Redis data and other services stay intact.
docker compose build app
changed=1
docker compose up -d --no-build --wait --wait-timeout 120 redis app
container=$(docker compose ps -q app)
[[ -n "$container" ]]
actual=$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$container")
[[ "$actual" == "$sha" ]] || { echo 'Running image revision differs from tested commit' >&2; exit 1; }
# Verify effective runtime restrictions, not only the image revision.
runtime=$(docker inspect --format '{{json .HostConfig}}' "$container")
python3 - "$runtime" <<'PY_RUNTIME'
import json, sys
c = json.loads(sys.argv[1])
assert c['ReadonlyRootfs'], 'App root filesystem must be read-only'
assert c['CapDrop'] == ['ALL'], 'All capabilities must be dropped'
assert any(x in ('no-new-privileges', 'no-new-privileges:true') for x in c['SecurityOpt']), 'Missing no-new-privileges'
assert c['PidsLimit'] == 256, 'Wrong PID limit'
tmp = c['Tmpfs']['/tmp'].split(',')
assert all(x in tmp for x in ['noexec', 'nosuid', 'nodev']), 'Missing /tmp protections'
print('Runtime restrictions verified')
PY_RUNTIME
docker compose exec -T --user 0 app sh -ec '
  test -z "$(find / -xdev -type f \( -perm /4000 -o -perm /2000 \) -print)"
  echo "SUID/SGID verified: 0 files"
'
# Readiness (including Redis), not only process liveness.
curl --fail --silent --show-error --max-time 10 http://127.0.0.1:8000/v1/health >/dev/null
docker compose exec -T app node -e '
(async () => {
  const fs = require("fs");
  const assert = require("assert/strict");
  assert.notEqual(process.getuid(), 0);
  assert.equal(process.env.TZ, "Asia/Seoul");
  assert.equal(new Date("2026-01-01T00:00:00Z").getTimezoneOffset(), -540);
  assert(fs.readFileSync("/proc/self/maps", "utf8").includes("libhardened_malloc.so"));
  assert(fs.readFileSync("/proc/1/comm", "utf8").includes("tini"));
  assert.equal(fs.statSync("/app/dist/main.js").uid, 0);
  const response = await fetch("http://127.0.0.1:3000/v1/health", {signal: AbortSignal.timeout(10000)});
  const body = await response.json();
  if (!response.ok || body.status !== "ok" || body.info?.redis?.status !== "up") process.exit(1);
})().catch(() => process.exit(1));'
mkdir -p "$HOME/.local/state/hashguard"
printf '%s\n' "$sha" > "$HOME/.local/state/hashguard/deployed-sha.tmp"
mv "$HOME/.local/state/hashguard/deployed-sha.tmp" "$HOME/.local/state/hashguard/deployed-sha"
changed=0
trap - EXIT INT TERM HUP
cleanup
printf 'DEPLOYED_SHA=%s\nReadiness=ok; Redis=up; revision=verified; hardening=verified\n' "$sha"
