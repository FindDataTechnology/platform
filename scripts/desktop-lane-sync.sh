#!/bin/bash
# desktop lane sync (add-desktop-in-app-update): hkccr OCI 中继 → cheap-3 拉取校验 → RustFS 分发。
# CI (release.yml) 打包 latest*.yml+安装器为 hkccr yizuo/desktop-releases:current；
# 本工拉取→sha512 校验（yml 为准，规格=拒装前置）→推 tailnet RustFS（yizuo-desktop 桶，匿名读）。
# 幂等：lane 版本同则跳过。凭据：/etc/desktop-lane/env（RustFS AK/SK）+ /etc/tcr-relay/env（hkccr 拉取）。
# (harden-desktop-lane-relay) 落盘名以 lane yml 内 url 为准（electron-builder 原名，可含空格，
# 如 "Platform Setup 1.3.28.exe"；GH release 资产名是点分隔的替换形态——凡从 release 资产
# 同步 lane 的旁路必须按 yml 名落盘；本工走 OCI，天然带原名）。
# (harden-desktop-lane-relay) "SKIP pull failed" 是断链症状（1.3.27/1.3.28 事故：连续数日
# SKIP 无人知晓）——连续 3 次升级为 LANE-STALE FAIL（exit 1）。配置性跳过（env 缺失）仍为 SKIP。
set -euo pipefail
IMG="${DESKTOP_LANE_IMG:-hkccr.ccs.tencentyun.com/yizuo/desktop-releases:current}"
BUCKET="${DESKTOP_LANE_BUCKET:-yizuo-desktop}"
RUSTFS="${DESKTOP_LANE_RUSTFS:-http://100.64.0.10:9000}"
LOG=/var/log/desktop-lane-sync.log
STALE_COUNTER=/var/lib/desktop-lane/pull-fail-count
log(){ echo "$(date -Is) $*" >> "$LOG"; }
[ -f /etc/desktop-lane/env ] || { log "SKIP no env"; exit 0; }
source /etc/desktop-lane/env
[ -n "${RUSTFS_AK:-}" ] && [ -n "${RUSTFS_SK:-}" ] || { log "SKIP rustfs creds missing"; exit 0; }

WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
mkdir -p "$(dirname "$STALE_COUNTER")"

# hkccr 拉取（凭据复用 tcr-relay 的 TCR_USER/TCR_PASS——同注册表）
if [ -f /etc/tcr-relay/env ]; then
  # shellcheck disable=SC1091
  . /etc/tcr-relay/env
  echo "${TCR_PASS:-}" | docker login hkccr.ccs.tencentyun.com --username "${TCR_USER:-}" --password-stdin >/dev/null 2>&1 || true
fi
if ! docker pull -q "$IMG" >/dev/null 2>&1; then
  n=$(($(cat "$STALE_COUNTER" 2>/dev/null || echo 0) + 1))
  echo "$n" > "$STALE_COUNTER"
  if [ "$n" -ge 3 ]; then
    log "LANE-STALE FAIL pull failed x$n (no image yet or registry down) — relay chain broken, releases not reaching the lane"
    exit 1
  fi
  log "SKIP pull failed (x$n, no image yet or registry down)"
  exit 0
fi
echo 0 > "$STALE_COUNTER"
cid=$(docker create --entrypoint / "$IMG" 2>/dev/null)
[ -n "$cid" ] || { log "SKIP docker create failed"; exit 0; }
docker cp "$cid:/lane" "$WORK/" >/dev/null && docker rm "$cid" >/dev/null
[ -f "$WORK/lane/latest.yml" ] || { log "SKIP no latest.yml in image"; exit 0; }

new=$(grep -m1 '^version:' "$WORK/lane/latest.yml" | awk '{print $2}')
[ -n "$new" ] || { log "FAIL unreadable new version"; exit 1; }
cur=$(curl -s -m 10 "$RUSTFS/$BUCKET/latest.yml" 2>/dev/null | grep -m1 '^version:' | awk '{print $2}' || true)
[ "$new" = "$cur" ] && exit 0

# sha512 校验：yml 记 base64 摘要，实物逐一比对
python3 - "$WORK/lane" <<'PY' || { log "FAIL sha mismatch"; exit 1; }
import base64, hashlib, os, re, sys
d = sys.argv[1]
# Unfold wrapped values (openssl-CLI-authored ymls wrap base64 at 64 chars;
# electron-builder's own are single-line) before parsing.
folded = []
for ln in open(os.path.join(d, "latest.yml")).read().splitlines():
    # a wrapped continuation is a bare base64 fragment; key lines never are
    if folded and re.fullmatch(r"[A-Za-z0-9+/=]+", ln):
        folded[-1] += ln
    else:
        folded.append(ln)
yml = "\n".join(folded)
checked = 0
# (harden-desktop-lane-relay) filenames may contain SPACES since 1.3.28
# ("Platform Setup 1.3.28.exe") — (\S+) truncated at the first space and the
# whole yml matched nothing ("yml has no file entries"). Capture lazily up to
# end of line instead.
for m in re.finditer(r"- url: (.*?)\n\s+sha512: (\S+)", yml):
    name, want = m.group(1), m.group(2)
    p = os.path.join(d, name)
    assert os.path.exists(p), f"missing {name}"
    got = base64.b64encode(hashlib.sha512(open(p, "rb").read()).digest()).decode()
    assert got == want, f"sha mismatch {name}"
    checked += 1
assert checked > 0, "yml has no file entries"
print(f"sha ok ({checked} files)")
PY

for f in "$WORK"/lane/*; do
  name=$(basename "$f")
  # URL-encode the key (spaces at minimum) — a raw space breaks the PUT URL.
  enc=$(python3 -c 'import urllib.parse, sys; print(urllib.parse.quote(sys.argv[1]))' "$name")
  # curl 7.88 does not auto-add x-amz-content-sha256 (RustFS rejects without
  # it) — sign it explicitly from the payload.
  PAYLOAD_SHA=$(openssl dgst -sha256 "$f" | awk '{print $NF}')
  code=$(curl -s -m 600 --aws-sigv4 "aws:amz:us-east-1:s3" --user "$RUSTFS_AK:$RUSTFS_SK" \
    -H "x-amz-content-sha256: $PAYLOAD_SHA" \
    -X PUT "$RUSTFS/$BUCKET/$enc" --data-binary "@$f" -o /dev/null -w "%{http_code}")
  [ "$code" = "200" ] || { log "FAIL upload $name (http $code)"; exit 1; }
done
log "SYNCED version=$new (was ${cur:-none})"
