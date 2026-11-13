#!/bin/bash
# desktop lane daily reconciliation (harden-desktop-lane-relay 2.2):
# 发布道（RustFS lane latest.yml）版本 vs 中继源（hkccr :current 内 yml）版本必须一致。
# 漂移 = CI 出了片但分发面没跟上（或 lane 被人为改坏）→ LANE-CHECK FAIL exit 1。
# 消费面：exit code + /var/log/desktop-lane-check.log 的 LANE-CHECK 标记；
# 例行体检命令（RELEASE_CHECKLIST）：tail -5 /var/log/desktop-lane-check.log
set -euo pipefail
IMG="${DESKTOP_LANE_IMG:-hkccr.ccs.tencentyun.com/yizuo/desktop-releases:current}"
BUCKET="${DESKTOP_LANE_BUCKET:-yizuo-desktop}"
RUSTFS="${DESKTOP_LANE_RUSTFS:-http://100.64.0.10:9000}"
LOG=/var/log/desktop-lane-check.log
log(){ echo "$(date -Is) $*" >> "$LOG"; }
[ -f /etc/desktop-lane/env ] || { log "LANE-CHECK SKIP no env"; exit 0; }
source /etc/desktop-lane/env

lane_ver=$(curl -s -m 10 "$RUSTFS/$BUCKET/latest.yml" 2>/dev/null | grep -m1 '^version:' | awk '{print $2}' || true)
[ -n "$lane_ver" ] || { log "LANE-CHECK FAIL lane latest.yml unreadable/unreachable"; exit 1; }

if [ -f /etc/tcr-relay/env ]; then
  # shellcheck disable=SC1091
  . /etc/tcr-relay/env
  echo "${TCR_PASS:-}" | docker login hkccr.ccs.tencentyun.com --username "${TCR_USER:-}" --password-stdin >/dev/null 2>&1 || true
fi
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
if ! docker pull -q "$IMG" >/dev/null 2>&1; then
  log "LANE-CHECK FAIL relay image $IMG unpullable — CI relay leg never pushed (check release run logs)"
  exit 1
fi
cid=$(docker create --entrypoint / "$IMG" 2>/dev/null)
[ -n "$cid" ] || { log "LANE-CHECK FAIL docker create failed"; exit 1; }
docker cp "$cid:/lane/latest.yml" "$WORK/" >/dev/null && docker rm "$cid" >/dev/null
relay_ver=$(grep -m1 '^version:' "$WORK/latest.yml" 2>/dev/null | awk '{print $2}' || true)
[ -n "$relay_ver" ] || { log "LANE-CHECK FAIL relay image has no readable latest.yml"; exit 1; }

if [ "$lane_ver" = "$relay_ver" ]; then
  log "LANE-CHECK OK lane=$lane_ver relay=$relay_ver"
else
  log "LANE-CHECK FAIL lane=$lane_ver relay=$relay_ver — distribution lag or tampering; check desktop-lane-sync.log"
  exit 1
fi
