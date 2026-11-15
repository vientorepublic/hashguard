#!/usr/bin/env bash
set -euo pipefail

PREFIX=${HASHGUARD_TOOL_PREFIX:-/usr/local}
if ! command -v wg >/dev/null || ! command -v wg-quick >/dev/null; then
  [[ $(uname -s) == Linux ]]
  WORK=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/hashguard-wireguard.XXXXXX")
  # Build the official release with the hosted image's existing C toolchain.
  # Verify the immutable commit before executing its build instructions.
  git -c advice.detachedHead=false clone --depth 1 --branch v1.0.20250521 \
    https://github.com/WireGuard/wireguard-tools.git "$WORK/source"
  test "$(git -C "$WORK/source" rev-parse HEAD)" = e2ecaaa739144997ccff89d6ad6ec81698ea6ced
  make -C "$WORK/source/src" -j2
  sudo install -d -m 755 "$PREFIX/bin"
  sudo install -m 755 "$WORK/source/src/wg" "$PREFIX/bin/wg"
  sudo install -m 755 "$WORK/source/src/wg-quick/linux.bash" "$PREFIX/bin/wg-quick"
fi

# systemd supports the resolvconf invocation used by wg-quick for DNS settings.
if ! command -v resolvconf >/dev/null && command -v resolvectl >/dev/null; then
  sudo ln -s "$(command -v resolvectl)" "$PREFIX/bin/resolvconf"
fi
wg --version
command -v wg-quick
