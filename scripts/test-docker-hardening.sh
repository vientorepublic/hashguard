#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
image=${IMAGE:-hashguard-hardened:local}
signal=${SIGNAL:-SIGTERM}
if [[ ${SKIP_BUILD:-0} != 1 ]]; then docker build -t "$image" .; fi
name="hg-hardening-$$"
app="$name-app"
redis="$name-redis"
cleanup() {
  docker rm -f "$app" "$redis" >/dev/null 2>&1 || true
  docker network rm "$name" >/dev/null 2>&1 || true
}
trap cleanup EXIT
# Pull before creating the isolated network, if the image is not cached.
docker image inspect redis:8.6.3 >/dev/null 2>&1 || docker pull redis:8.6.3
docker network create --internal "$name" >/dev/null
docker run -d --name "$redis" --network "$name" --network-alias redis \
  --memory 128m --cpus 1 --pids-limit 64 redis:8.6.3 \
  redis-server --save '' --appendonly no >/dev/null
# Fresh ephemeral signing key; never reads the project's .env or production keys.
signing_key=$(docker run --rm --network none --read-only --memory 128m --cpus 1 \
  --pids-limit 64 --entrypoint node "$image" -e \
  'process.stdout.write(Buffer.from(require("crypto").generateKeyPairSync("ec",{namedCurve:"prime256v1"}).privateKey.export({type:"pkcs8",format:"pem"})).toString("base64"))')
docker run -d --name "$app" --network "$name" --stop-signal "$signal" \
  --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777 \
  --pids-limit 256 --memory 512m --cpus 2 \
  -e POW_TOKEN_PRIVATE_KEY_BASE64="$signing_key" \
  -e REDIS_HOST=redis -e POW_RISK_KEY_SECRET=local-only-dummy-secret-at-least-32-characters \
  "$image" >/dev/null
for i in $(seq 1 60); do
  if docker exec "$app" node -e "require('http').get('http://127.0.0.1:3000/v1/health',r=>{r.resume();process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))" >/dev/null 2>&1; then break; fi
  if [[ $i == 60 || $(docker inspect --format '{{.State.Running}}' "$app") != true ]]; then docker logs "$app"; exit 1; fi
  sleep 1
done
docker exec "$app" node -e '
const fs = require("fs"); const assert = require("assert/strict");
assert.notEqual(process.getuid(), 0);
assert.equal(process.env.TZ, "Asia/Seoul");
assert.equal(new Date("2026-01-01T00:00:00Z").getTimezoneOffset(), -540);
assert.equal(new Date("2026-07-01T00:00:00Z").getTimezoneOffset(), -540);
assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, "Asia/Seoul");
assert.equal(fs.readFileSync("/etc/timezone", "utf8").trim(), "Asia/Seoul");
assert(fs.readFileSync("/proc/self/maps", "utf8").includes("libhardened_malloc.so"));
assert(fs.readFileSync("/proc/1/comm", "utf8").includes("tini"));
const status = fs.readFileSync("/proc/self/status", "utf8");
assert(/NoNewPrivs:\s+1/.test(status));
assert(/CapEff:\s+0+\n/.test(status));
assert.equal(fs.statSync("/app/dist/main.js").uid, 0);
assert.throws(()=>fs.writeFileSync("/app/should-not-write", "x"));
fs.writeFileSync("/tmp/hg-probe", "ok"); fs.unlinkSync("/tmp/hg-probe");
for (const path of ["/usr/local/bin/npm", "/usr/local/bin/npx", "/usr/local/bin/yarn", "/usr/bin/git", "/usr/bin/gcc"])
  assert(!fs.existsSync(path), path);
const maps = Number(fs.readFileSync("/proc/sys/vm/max_map_count", "utf8"));
if (maps < 1048576) console.log(`HOST_PREREQUISITE vm.max_map_count=${maps}; recommended>=1048576; unchanged (load testing still required)`);
console.log("PASS KST winter/summer=-540; allocator mapped; tini PID1; nonroot; root-owned app; readonly; tmpfs; CapEff=0; NoNewPrivs=1; no build/package tools; vm.max_map_count="+maps);
'
docker exec --user 0 "$app" sh -ec '
  test "$(date +%z)" = +0900
  test -z "$(find / -xdev -type f \( -perm /4000 -o -perm /2000 \) -print)"
  grep " /tmp " /proc/mounts | grep -q "nosuid,nodev,noexec"
  echo "PASS libc KST=+0900; SUID/SGID=0; tmpfs flags"
'
docker exec "$app" node -e '
(async()=>{for(const path of ["/v1/health/liveness", "/v1/health"]){
 const res=await fetch("http://127.0.0.1:3000"+path); const body=await res.json();
 require("assert/strict").equal(res.status,200);
 require("assert/strict").equal(body.status,"ok");
 if(path==="/v1/health") require("assert/strict").equal(body.info.redis.status,"up");
 console.log("PASS GET "+path+" HTTP "+res.status+" "+JSON.stringify(body));
}})().catch(e=>{console.error(e);process.exit(1)});
'
for i in $(seq 1 45); do
  health=$(docker inspect --format '{{.State.Health.Status}}' "$app")
  [[ $health != healthy ]] || break
  if [[ $i == 45 ]]; then docker inspect "$app"; exit 1; fi
  sleep 1
done
echo 'PASS image HEALTHCHECK=healthy'
docker stop --time 30 "$app" >/dev/null
exit_code=$(docker inspect --format '{{.State.ExitCode}}' "$app")
[[ $exit_code == 0 ]]
docker logs "$app" 2>&1 | grep -q 'Redis connection closed'
docker logs "$app" 2>&1 | grep -q "Graceful shutdown complete ($signal)"
echo "PASS tini $signal graceful shutdown; Redis closed; exit=$exit_code"
