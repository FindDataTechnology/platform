#!/usr/bin/env bash
# monday-acceptance.sh — one command to accept the investment fleet's Monday ticks.
#
# Why this exists: the 11-15 reports described this script and recorded it as
# "实跑", but the file existed on no ref — the readings came from hand-run
# probes that left nothing behind. The morning it decides something is the
# morning it must be runnable, so it is a file now.
#
#   ./scripts/monday-acceptance.sh                 # first screen + full scan
#   ./scripts/monday-acceptance.sh --self-test     # offline, no cluster
#   ./scripts/monday-acceptance.sh --now 2026-11-16T02:00:00Z
#
# Exit: 0 = every judged reading is good · 1 = at least one ✗ · 2 = 判不出.
#
# Read-only: the only thing it writes is a temp file inside the (already
# ephemeral) platform pod, removed on the way out. It never PATCHes a member,
# never applies a manifest, never ships an image.
set -uo pipefail

# Mode gate FIRST and it must not be able to fall through: a self-test that
# reaches the production path is how a "harmless" rehearsal ends up waking real
# cells (see the 11-15 note in the reports).
MODE="${1:-run}"
case "$MODE" in
  run|--self-test) ;;
  *) echo "用法：$0 [run|--self-test] [--now ISO8601] [--fleet REGEX]" >&2; exit 2 ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCAN="$SCRIPT_DIR/lib/acceptance-scan.cjs"
[ -f "$SCAN" ] || { echo "✗ 判不出：找不到 $SCAN" >&2; exit 2; }

if [ "$MODE" = "--self-test" ]; then
  node "$SCAN" --self-test
  exit $?
fi

NOW_ARG=""
FLEET_ARG=""
shift || true
while [ $# -gt 0 ]; do
  case "$1" in
    --now) NOW_ARG="${2:-}"; shift 2 ;;
    --fleet) FLEET_ARG="${2:-}"; shift 2 ;;
    *) echo "未知参数 $1" >&2; exit 2 ;;
  esac
done

# ── first screen: where the process stands ──────────────────────────────────
# The risk this screen exists for (§7.40): the scheduler is an in-memory timer,
# so a pod roll swallows any tick that had not fired yet — no history entry, no
# `missed` counter, nothing. The tick window is 01:00–01:35Z (09:00/09:10/09:30
# CST). A roll inside that window is the one fact that makes "no history" mean
# "the process never got there" instead of "the run failed".
echo "── 第一屏：进程起点 ──────────────────────────────────────────"
# Interval expressions `{6,12}` are NOT supported by macOS's BWK awk — the
# pattern then matches nothing and the gate reports "找不到 pod", which is a
# measurement failure wearing the shape of a finding. Keep the regex in grep -E.
POD="$(timeout 60 kubectl -n fd-prod get pods --no-headers 2>/dev/null \
  | awk '$3=="Running"{print $1}' \
  | grep -E '^platform-[a-z0-9]{6,12}-[a-z0-9]{4,6}$' | head -1)"
if [ -z "$POD" ]; then
  echo "  ✗ 判不出：fd-prod 里找不到 Running 的 platform 部署 pod"
  echo "     （严格形状：platform-<rs-hash>-<pod-hash>；CronJob 的 platform-<name>-<epoch>-<rand> 不算）"
  echo "VERDICT hit=0 warn=0 undet=1"
  exit 2
fi
# the pod can be Running while the container we need is gone/restarting
if ! timeout 60 kubectl -n fd-prod get pod "$POD" -o jsonpath='{.spec.containers[*].name}' 2>/dev/null | grep -qw platform; then
  echo "  ✗ 判不出：pod $POD 里没有 platform 容器（容器名变了？）"
  echo "VERDICT hit=0 warn=0 undet=1"
  exit 2
fi
START="$(timeout 60 kubectl -n fd-prod get pod "$POD" -o jsonpath='{.status.startTime}' 2>/dev/null)"
echo "  pod: $POD    startTime: ${START:-取不到}"

TODAY="$(date -u +%Y-%m-%d)"
WINDOW_FROM="${TODAY}T01:00:00Z"
WINDOW_TO="${TODAY}T01:35:00Z"
echo "  最近 5 个 ReplicaSet："
RS_LIST="$(timeout 60 kubectl -n fd-prod get rs --sort-by=.metadata.creationTimestamp \
  -o 'custom-columns=NAME:.metadata.name,CREATED:.metadata.creationTimestamp' --no-headers 2>/dev/null | tail -5)"
if [ -z "$RS_LIST" ]; then
  echo "    · 取不到 RS 列表（不影响判定，但少一条证据）"
else
  echo "$RS_LIST" | sed 's/^/    /'
  # Lexicographic comparison is exact here: same ISO-8601 shape, UTC, zero-padded.
  IN_WINDOW="$(echo "$RS_LIST" | awk -v a="$WINDOW_FROM" -v b="$WINDOW_TO" '{ if ($2 >= a && $2 <= b) print $1 }')"
  if [ -n "$IN_WINDOW" ]; then
    echo "  ⚠ 有部署滚版落在三 tick 窗口（$WINDOW_FROM .. ${WINDOW_TO}）里：$IN_WINDOW"
    echo "    ⇒ 未到点的 tick 会随进程消失且不留痕；下面若报「缺轮」，先怀疑这一条。"
  else
    echo "  · 三 tick 窗口内没有新的 ReplicaSet（部署没滚版）"
  fi
fi
# A pod can also be recreated inside the SAME ReplicaSet (eviction / OOM / node
# pressure). Then no new RS appears and the check above reads green while the
# ticks were killed — so the pod's own start time is a separate fact to judge.
if [ -n "${START:-}" ] && [[ "$START" > "$WINDOW_FROM" && "$START" < "$WINDOW_TO" ]]; then
  echo "  ⚠ 这个 pod 是刚刚重建的（startTime $START 落在三 tick 窗口里，RS 未变）"
  echo "    ⇒ 窗口内已起的 tick 会被这次重建打断；下面逐岗报「滚动打断」的即是它们。"
fi
echo

# ── second: the scan itself, run inside the pod ─────────────────────────────
# better-sqlite3 lives at /app/node_modules inside the image; the host has no
# business opening a 14MB sqlite over a pipe, so the read happens where the
# data is. `cat >` + `node` keeps it to one round trip and no kubectl cp.
echo "── 第二屏：投研队读数 ────────────────────────────────────────"
# The pod's own start time separates "still running" from "killed by a restart":
# task-engine writes the history row at start, so an open row older than the pod
# was killed mid-flight — §7.40's swallowed tick, whose remedy is a manual catch-up.
ENVS="FD_ACC_POD_START='${START:-}' "
[ -n "$NOW_ARG" ] && ENVS="${ENVS}FD_ACC_NOW='$NOW_ARG' "
[ -n "$FLEET_ARG" ] && ENVS="${ENVS}FD_ACC_FLEET='$FLEET_ARG' "
SCAN_RC=0
SCAN_OUT="$(timeout 180 kubectl -n fd-prod exec -i "$POD" -c platform -- \
  sh -c "cat > /tmp/fd-acc-scan.cjs && ${ENVS}node /tmp/fd-acc-scan.cjs --scan; rc=\$?; rm -f /tmp/fd-acc-scan.cjs; exit \$rc" \
  < "$SCAN" 2>&1)" || SCAN_RC=$?
echo "$SCAN_OUT"
# The scan always ends with a VERDICT line. Its absence means the read never
# happened — that is 判不出 (2), and must never be reported as 命中 (1): a
# transport error must not wear the shape of a mechanism conclusion.
if ! printf '%s' "$SCAN_OUT" | grep -q '^VERDICT hit='; then
  echo
  echo "  ✗ 判不出：扫描没有产出 VERDICT 行（kubectl rc=$SCAN_RC）——这是读不到，不是「全部正常」，也不是「有命中」"
  echo "VERDICT hit=0 warn=0 undet=1"
  exit 2
fi

echo
case "$SCAN_RC" in
  0) echo "结论：判据全绿（已知未交付项按 ⚠ 打印，不计命中）。" ;;
  1) echo "结论：有命中 —— 上面的 ✗ 行逐条点名了是谁、哪一轮、原文是什么。" ;;
  2) echo "结论：判不出 —— 读不到平台自己的持久化，这不是「全部正常」。" ;;
  *) echo "结论：扫描异常退出（rc=${SCAN_RC}），看上面的栈；别把它读成绿。" ;;
esac
exit "$SCAN_RC"
