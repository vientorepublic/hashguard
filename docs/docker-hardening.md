# Docker runtime hardening

The runtime uses Asia/Seoul (KST, UTC+09:00) for both libc and Node. This does not
change the host clock or UTC timestamps serialized by `Date.toISOString()`.

The Dockerfile follows the LawCast Backend multi-stage structure:
https://github.com/vientofactory/LawCast-Backend/blob/main/Dockerfile

- Identical pinned Node 24.22.1 Alpine version for all stages.
- GrapheneOS hardened_malloc source pinned to a commit; portable musl build with
  `CONFIG_NATIVE=false CONFIG_CXX_ALLOCATOR=false`, enabled via `LD_PRELOAD`.
- Production dependencies only, no allocator build tools in the runtime.
- tzdata, tini PID 1/signal forwarding/reaping, liveness HEALTHCHECK.
- Non-root `node`, root-owned application, SUID/SGID removed from all regular files.
- npm/npx/yarn removed from runtime; env-file variants excluded from build context.
- Compose app: read-only root, all capabilities dropped, no-new-privileges,
  bounded noexec/nosuid/nodev /tmp tmpfs and 256-process limit.

Chromium, Puppeteer, vendor and SQLite directories from the reference are not
part of Hashguard and are not added. Redis retains its writable data volume.

## Host prerequisite

hardened_malloc uses many virtual-memory mappings. On the **Linux Docker host**,
check `sysctl vm.max_map_count`; provision at least `1048576` for production.
This is a host-wide setting, not a namespaced Docker Compose sysctl. No host
sysctl is changed by this project or the local verification. Tune and load-test
memory/mapping limits against the intended traffic before deployment.

## Local validation (no deployment)

Run `bash scripts/test-docker-hardening.sh` from this directory. It builds a local
image, creates an internal test-only Docker network and disposable Redis/app
containers, checks KST, mapped allocator, privilege bits, runtime restrictions,
HTTP liveness/readiness, image health and SIGTERM forwarding; it cleans up on exit.
A low host mapping limit is reported separately, not treated as a functional
smoke-test failure; passing this test is not a production load-test result.
No host ports, existing .env, external gateway networks or persistent volumes
are used. A generated dummy secret is supplied only to the test container.

The test defaults to native architecture. Run on the production architecture as
well if it differs; a native arm64 run does not validate amd64 execution.

## Graceful shutdown

`tini` forwards SIGTERM (Docker stop) and SIGINT to Node. The application installs
one idempotent handler for both signals. `app.close(signal)` stops new HTTP
connections and waits for in-flight requests before the Redis
`onApplicationShutdown` hook runs. Redis QUIT has a 5-second deadline and always
disables reconnection via disconnect, including when Redis is unavailable.
Successful cleanup exits 0; a failed close or the 20-second global shutdown
deadline exits 1. Repeated signals do not run cleanup twice. Compose allows 30
seconds before SIGKILL. No separate `enableShutdownHooks()` registration is used.
The Docker smoke test requires exit 0 and both Redis/shutdown completion logs.

To test SIGINT with the same production server smoke checks, run
`SIGNAL=SIGINT SKIP_BUILD=1 bash scripts/test-docker-hardening.sh`.
Run `SKIP_BUILD=1 bash scripts/test-graceful-shutdown.sh` to exercise an isolated
fixture request in flight while SIGTERM, SIGINT and another SIGTERM arrive.
The fixture confirms HTTP completion with Redis still usable, then exactly one
Redis close and successful process exit. Its test-only route is mounted into a
disposable container and never shipped in the production image.
