#!/usr/bin/env bash
# ── Supply spine store dump (add-supply-store-unification 1.5) ───────────────
#
# 脊柱库（packs.db，含 packs + mcp_servers + skills + 审计）的在线一致性备份。
# better-sqlite3 WAL 模式下用 sqlite3 .backup —— 在线快照、不锁写、随取随用；
# 迁移窗口的 pre-cutover dump 双份留存也走本脚本（tasks 3.2）。
#
# 用法：
#   scripts/supply-store-dump.sh <packs.db 路径> [输出目录]
# 缺省输出目录：./supply-store-dumps/<时间戳>/
# 输出：packs-<时间戳>.db（一致性别名）+ SHA256 校验 + 行数清单。
#
# 生产路径（facet pod，CELL_DATA_ROOT 数据盘）：
#   kubectl --context cheap-ts -n fd-prod exec deploy/facet -- \
#     node scripts/supply-store-dump.js /data/packs.db /data/dumps
# （pod 内 Node 侧走 supply-store-dump.mjs，同语义；本脚本用于宿主机有
#   sqlite3 CLI 的场景。）

set -euo pipefail

DB_FILE="${1:?usage: supply-store-dump.sh <packs.db> [out-dir]}"
OUT_DIR="${2:-./supply-store-dumps/$(date -u +%Y%m%dT%H%M%SZ)}"

command -v sqlite3 >/dev/null || { echo "sqlite3 CLI not found; use supply-store-dump.mjs (Node) instead" >&2; exit 2; }
[ -f "$DB_FILE" ] || { echo "no such db file: $DB_FILE" >&2; exit 2; }

mkdir -p "$OUT_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TARGET="$OUT_DIR/packs-$STAMP.db"

# .backup = online consistent snapshot (WAL-safe, no write lock)
sqlite3 "$DB_FILE" ".backup '$TARGET'"

ROW_MCP="$(sqlite3 "$TARGET" 'SELECT count(*) FROM mcp_servers' 2>/dev/null || echo 'n/a')"
ROW_SKILLS="$(sqlite3 "$TARGET" 'SELECT count(*) FROM skills' 2>/dev/null || echo 'n/a')"
ROW_PACKS="$(sqlite3 "$TARGET" 'SELECT count(*) FROM packs' 2>/dev/null || echo 'n/a')"
SHA="$(shasum -a 256 "$TARGET" | awk '{print $1}')"

{
  echo "db=$TARGET"
  echo "sha256=$SHA"
  echo "rows: packs=$ROW_PACKS mcp_servers=$ROW_MCP skills=$ROW_SKILLS"
  echo "integrity: $(sqlite3 "$TARGET" 'PRAGMA integrity_check')"
} | tee "$OUT_DIR/packs-$STAMP.sha256.txt"

echo "[supply-store-dump] done -> $TARGET"
