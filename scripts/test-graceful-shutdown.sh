#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
image=${IMAGE:-hashguard-hardened:local}
if [[ ${SKIP_BUILD:-0} != 1 ]]; then docker build -t "$image" .; fi
name="hg-drain-$$"
app="$name-app"
redis="$name-redis"
client="$name-client"
cleanup() {
  docker rm -f "$client" "$app" "$redis" >/dev/null 2>&1 || true
  docker network rm "$name" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker network create --internal "$name" >/dev/null
docker run -d --name "$redis" --network "$name" --network-alias redis \
  --memory 128m --cpus 1 --pids-limit 64 redis:8.6.3 \
  redis-server --save '' --appendonly no >/dev/null
key=$(docker run --rm --network none --read-only --entrypoint node "$image" -e \
  'process.stdout.write(Buffer.from(require("crypto").generateKeyPairSync("ec",{namedCurve:"prime256v1"}).privateKey.export({type:"pkcs8",format:"pem"})).toString("base64"))')
docker run -d --name "$app" --network "$name" --network-alias app \
  --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --memory 512m --cpus 2 --pids-limit 128 \
  --mount "type=bind,src=$PWD/test/fixtures/graceful-shutdown.cjs,dst=/app/test-shutdown.cjs,readonly" \
  -e REDIS_HOST=redis -e POW_TOKEN_PRIVATE_KEY_BASE64="$key" \
  -e POW_RISK_KEY_SECRET=local-only-dummy-secret-at-least-32-characters \
  "$image" node test-shutdown.cjs >/dev/null
wait_log() {
  for i in $(seq 1 100); do
    if docker logs "$app" 2>&1 | grep -q "$1"; then return; fi
    sleep 0.1
  done
  docker logs "$app"; return 1
}
wait_log FIXTURE_READY
docker run -d --name "$client" --network "$name" --read-only \
  --cap-drop ALL --security-opt no-new-privileges:true --memory 128m --cpus 1 --pids-limit 64 \
  --entrypoint node "$image" -e '
fetch("http://app:3000/__test/slow", {signal: AbortSignal.timeout(10000)})
.then(async r => {
 const body=await r.json(); const assert=require("assert/strict");
 assert.equal(r.status,200); assert.deepEqual(body,{drained:true,redis:"PONG"});
 console.log("PASS in-flight HTTP=200; Redis PONG after signal; response completed");
}).catch(e=>{console.error(e);process.exit(1)});
' >/dev/null
wait_log INFLIGHT_STARTED
docker kill --signal SIGTERM "$app" >/dev/null
wait_log 'Received SIGTERM'
# A second, different signal must not interrupt the request or repeat cleanup.
docker kill --signal SIGINT "$app" >/dev/null
# Stop provides a bounded wait and repeats SIGTERM during drain.
docker stop --time 30 "$app" >/dev/null
[[ $(docker wait "$client") == 0 ]]
[[ $(docker inspect --format '{{.State.ExitCode}}' "$app") == 0 ]]
logs=$(docker logs "$app" 2>&1)
[[ $(grep -c 'Received SIG' <<< "$logs") == 1 ]]
[[ $(grep -c 'Redis connection closed' <<< "$logs") == 1 ]]
[[ $(grep -c 'Graceful shutdown complete' <<< "$logs") == 1 ]]
# Verify real lifecycle order, not just the presence of log messages.
LOGS="$logs" python3 - <<'PY'
import os
s=os.environ['LOGS']
assert s.index('Received SIGTERM') < s.index('INFLIGHT_FINISHED') < s.index('Redis connection closed') < s.index('Graceful shutdown complete')
PY
docker logs "$client"
echo 'PASS SIGTERM + SIGINT + SIGTERM: one cleanup; HTTP drained before Redis closed; tini exit=0'
