#!/usr/bin/env python3
"""registry 审计 → fd-wire 计量推送（ecosystem-bridge 3.1 接线）。

Mongo 审计库只绑 loopback（安全姿态），故不做 DB 暴露，改由本脚本在
cheap-1 上周期读增量、POST 到 fd-wire 的 /internal/metering/events
（产品自带通道，Bearer 令牌鉴权，fail-closed）。

水位：本地 state 文件记最后推送的 timestamp；重叠窗 5 分钟，fd-wire 侧
幂等键去重（同 request_id 不双记）。

用法：
  python3 push_audit_to_wire.py            # 推送一轮
  python3 push_audit_to_wire.py --dry-run  # 只看会推多少
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

STATE = Path("/opt/mcp-gateway-registry/.audit-push-state.json")
ENV_FILE = Path("/opt/mcp-gateway-registry/.env")
WIRE_URL = os.environ.get("FD_WIRE_METERING_URL", "http://100.64.0.8:31883/internal/metering/events")
TOKEN_FILE = Path("/opt/mcp-gateway-registry/.wire-ingest-token")
OVERLAP = timedelta(minutes=5)
LIMIT = 500


def env_value(key: str) -> str:
    for line in ENV_FILE.read_text().splitlines():
        if line.startswith(key + "="):
            return line.split("=", 1)[1].strip()
    return ""


def load_state() -> str | None:
    try:
        return json.loads(STATE.read_text()).get("since")
    except Exception:
        return None


def save_state(ts: str) -> None:
    STATE.write_text(json.dumps({"since": ts, "updated": datetime.now(timezone.utc).isoformat()}))


def fetch_batch(since: str | None) -> list[dict]:
    """经 mongosh 读一批 mcp_server_access 事件（避免引入 pymongo 依赖）。"""
    pw = env_value("DOCUMENTDB_PASSWORD")
    if not pw:
        raise SystemExit("DOCUMENTDB_PASSWORD 未配置")
    filt = '{"log_type": "mcp_server_access"}'
    if since:
        filt = json.dumps({"log_type": "mcp_server_access", "timestamp": {"$gt": since}})
    js = (
        'const d = db.getSiblingDB("mcp_registry");'
        f'const rows = d.audit_events_default.find({filt}).sort({{timestamp: 1}}).limit({LIMIT}).toArray();'
        "print(JSON.stringify(rows));"
    )
    out = subprocess.run(
        ["docker", "exec", "mcp-mongodb", "mongosh", "-u", "admin", "-p", pw,
         "--authenticationDatabase", "admin", "--quiet", "--eval", js],
        capture_output=True, text=True, timeout=60,
    )
    if out.returncode != 0:
        raise SystemExit(f"mongosh 失败: {out.stderr[:200]}")
    # 取最后一个 JSON 行（mongosh 可能带其它输出）
    for line in reversed(out.stdout.strip().splitlines()):
        line = line.strip()
        if line.startswith("["):
            return json.loads(line)
    return []


def push(events: list[dict], token: str) -> dict:
    req = urllib.request.Request(
        WIRE_URL,
        data=json.dumps(events).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    since = load_state()
    if since:
        try:
            since = (datetime.fromisoformat(since.replace("Z", "+00:00")) - OVERLAP).isoformat()
        except ValueError:
            pass
    events = fetch_batch(since)
    if not events:
        print("无新事件")
        return 0
    if args.dry_run:
        print(f"将推送 {len(events)} 条（since={since}）")
        return 0

    token = TOKEN_FILE.read_text().strip() if TOKEN_FILE.exists() else os.environ.get("METERING_INGEST_TOKEN", "")
    if not token:
        raise SystemExit("ingest 令牌缺失（写 /opt/mcp-gateway-registry/.wire-ingest-token）")
    try:
        result = push(events, token)
    except urllib.error.HTTPError as e:
        print(f"推送失败 HTTP {e.code}: {e.read().decode()[:200]}", file=sys.stderr)
        return 1
    except Exception as e:  # noqa: BLE001
        print(f"推送失败: {type(e).__name__} {e}", file=sys.stderr)
        return 1

    last_ts = events[-1].get("timestamp")
    if last_ts:
        save_state(last_ts)
    print(f"推送 {len(events)} 条 → {result}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
