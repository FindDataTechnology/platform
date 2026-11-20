#!/usr/bin/env bash
# Repo-owned image smoke gate — runs INSIDE the build workflow after the image
# is built and before it is pushed (the pool's image.yml prefers this script
# over its generic SMOKE_MODE probe; SMOKE_MODE=skip does NOT bypass it).
#
# Why this exists: on 2026-10-17 the pool's `SMOKE_MODE=skip` let a broken
# image through — server/roles.js imported ../packages/core/src/lib/*.ts and
# the runtime stage never COPYed packages/, so every cell died with
# ERR_MODULE_NOT_FOUND and fd-prod crashlooped until an emergency rollback.
# The generic probe would have caught it; it was skipped. This script makes the
# probe mandatory and widens it to the failure classes we have actually hit:
#
#   1. process must come up and serve /api/config          (boot + HTTP)
#   2. /api/ready must flip 200                            (dsh agent handshake)
#   3. the boot log must not contain ERR_MODULE_NOT_FOUND  (packaging gaps —
#      the 2026-10-09 dsh loader incident and the 2026-10-17 packages/ one)
#   4. the shared-core modules must be present on disk     (import graph
#      reachability, checked directly rather than by trusting a 200)
#
# Usage: bash scripts/ci-smoke.sh <registry>/<ns>/<image>:<tag>

set -uo pipefail

IMAGE="${1:?usage: ci-smoke.sh <image:tag>}"
NAME="paas-ci-smoke"
PORT=3000

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "smoke: image=$IMAGE"
cleanup

docker run -d --name "$NAME" \
  -e AUTH_MODE=none -e PORT="$PORT" -e HOST=0.0.0.0 \
  -e PLATFORM_DATA_DIR=/data -e NODE_ENV=production \
  "$IMAGE" >/dev/null || { echo "SMOKE FAILED — container refused to start"; exit 1; }

fail() {
  echo "SMOKE FAILED — $1"
  echo "---- container logs (tail 60) ----"
  docker logs "$NAME" 2>&1 | tail -60
  exit 1
}

# ── 1. boot + HTTP ───────────────────────────────────────────────────────────
ok=0
for i in $(seq 1 40); do
  sleep 5
  if docker exec "$NAME" curl -fsS -m 5 "http://127.0.0.1:$PORT/api/config" >/dev/null 2>&1; then
    ok=1; echo "smoke: /api/config healthy after ~$((i*5))s"; break
  fi
  if [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" != "true" ]; then
    fail "container exited after ~$((i*5))s"
  fi
done
[ "$ok" = "1" ] || fail "image does not serve /api/config"

# ── 2. agent liveness (/api/ready gates on the dsh child handshake) ──────────
ok=0
for i in $(seq 1 30); do
  sleep 5
  if docker exec "$NAME" curl -fsS -m 5 "http://127.0.0.1:$PORT/api/ready" >/dev/null 2>&1; then
    ok=1; echo "smoke: /api/ready healthy after ~$((i*5))s"; break
  fi
  if [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" != "true" ]; then
    fail "container exited while waiting for /api/ready"
  fi
done
[ "$ok" = "1" ] || fail "/api/ready never flipped 200 (agent runtime not usable)"

# ── 3. packaging-gap guard: module resolution errors in the boot log ─────────
LOG="$(docker logs "$NAME" 2>&1)"
if printf '%s' "$LOG" | grep -q "ERR_MODULE_NOT_FOUND"; then
  echo "---- offending lines ----"
  printf '%s\n' "$LOG" | grep -m5 -B1 -A3 "ERR_MODULE_NOT_FOUND"
  fail "ERR_MODULE_NOT_FOUND in the boot log (a COPY is missing a directory the runtime imports)"
fi

# ── 4. shared-core presence (the import graph the server modules rely on) ────
MISSING=""
for f in \
  /app/packages/core/src/lib/roles.ts \
  /app/packages/core/src/lib/surfaces.ts \
  /app/packages/core/src/lib/recipes.ts \
  /app/server/roles.js \
  /app/server/layout.js \
  /app/server/onboarding.js \
  /app/server/routes/onboarding.js \
  /app/gateway/roles.js \
  /app/gateway/layout.js
do
  docker exec "$NAME" test -f "$f" || MISSING="$MISSING $f"
done
[ -z "$MISSING" ] || fail "runtime files missing from the image:$MISSING"

echo "smoke: OK — boot, /api/config, /api/ready, module resolution and shared-core files all verified"
