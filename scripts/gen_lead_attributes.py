#!/usr/bin/env python3
"""从 paas/lib/lead-attributes.json 生成前端可 import 的键名模块。

前端是独立仓库（fd-marketing-web），构建期不能跨仓读文件——所以派生成一份
生成件，让「属性键名」在前端也只从权威表派生，不再各写一份（spec
marketing-lead-capture「属性闭集出现第二份即判红」）。

用法：
    python3 scripts/gen_lead_attributes.py            # 写生成件
    python3 scripts/gen_lead_attributes.py --check    # 只校验生成件是否最新
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
AUTHORITY = ROOT / "lib" / "lead-attributes.json"
OUT = Path.home() / "finddata" / "fd-marketing-web" / "src" / "lib" / "lead-attributes.gen.ts"

HEADER = """// 生成件，勿手改。来源：paas/lib/lead-attributes.json
// 重新生成：python3 ~/finddata/paas/scripts/gen_lead_attributes.py
// 校验最新：python3 ~/finddata/paas/scripts/gen_lead_attributes.py --check
"""


def render(doc: dict) -> str:
    attrs = doc.get("attributes") or {}
    keys = sorted(attrs)
    lines = [HEADER]
    lines.append(f"export const LEAD_ATTRIBUTES_VERSION = {doc.get('version', 0)};\n")
    lines.append("export const LEAD_ATTRIBUTE_KEYS = [")
    for k in keys:
        lines.append(f"  {json.dumps(k)},")
    lines.append("] as const;\n")
    lines.append("export type LeadAttributeKey = (typeof LEAD_ATTRIBUTE_KEYS)[number];\n")
    lines.append("export const FIRST_TOUCH_KEYS = [")
    for k in keys:
        if attrs[k].get("first_touch_only"):
            lines.append(f"  {json.dumps(k)},")
    lines.append("] as const;\n")
    lines.append("export const ATTRIBUTE_ENUMS: Record<string, readonly string[]> = {")
    for k in keys:
        vals = attrs[k].get("values")
        if vals:
            lines.append(f"  {json.dumps(k)}: {json.dumps(vals)},")
    lines.append("};\n")
    return "\n".join(lines)


def main() -> int:
    doc = json.loads(AUTHORITY.read_text(encoding="utf-8"))
    body = render(doc)
    if "--check" in sys.argv:
        if not OUT.exists():
            print(f"FAIL 生成件不存在：{OUT}", file=sys.stderr)
            return 1
        if OUT.read_text(encoding="utf-8") != body:
            print(f"FAIL 生成件已过期：{OUT}（重跑 gen_lead_attributes.py）", file=sys.stderr)
            return 1
        print("OK 生成件是最新的")
        return 0
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(body, encoding="utf-8")
    print(f"wrote {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
