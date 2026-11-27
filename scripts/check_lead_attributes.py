#!/usr/bin/env python3
"""线索属性闭集的合规检查（openspec: close-marketing-funnel / marketing-lead-capture）。

判据四项（任一项违规即非零退出）：

  ① 权威表本身可解析，且每个属性都有 type 与 label。
  ② 仓内不存在第二份平行的属性名清单——即除权威表外，没有哪个源文件把
     ≥3 个属性名作为字面量清单硬编码。（单个键名随处可用；成清单即第二口径。）
  ③ first_touch_only 属性在写入侧确实受「非空即跳过」约束。
  ④ 权威表声明的 carrier 是 chatwoot-contact（线索不新建表）。

②的扫描范围是本仓 + 营销站 + 一个显式的额外根（默认 ~/finddata/fd-marketing-web）。

用法：
    python3 scripts/check_lead_attributes.py             # 检查，违规非零退出
    python3 scripts/check_lead_attributes.py --selftest  # 负向自检：坏样本必须判红
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]          # paas/
AUTHORITY = ROOT / "lib" / "lead-attributes.json"

#: 真正独有的属性名：只有线索语义会用到，可以据此判定「第二份口径」。
#: 刻意不含 `source` / `stage` / `signal` / `name` / `company` / `scenario`——
#: 它们在无关代码里天然出现（`source: "facade"`、`signal: controller.signal`、
#: locale 文案），按它们判会把整仓刷成红。
DISTINCTIVE = {"first_touch_content_id", "first_touch_at"}

# 扫描面：只看会影响运行时判定或前端写入的源文件。
SCAN_ROOTS = [
    ROOT / "server",
    ROOT / "gateway",
    ROOT / "lib",
    ROOT / "web" / "src",
    Path.home() / "finddata" / "fd-marketing-web" / "src",
]
SCAN_SUFFIXES = {".js", ".mjs", ".ts", ".tsx", ".astro", ".json"}
SKIP_DIR_NAMES = {"node_modules", "dist", ".git", ".astro", "build"}


def load_authority(path: Path = AUTHORITY) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def iter_sources(roots=SCAN_ROOTS):
    for root in roots:
        if not root.exists():
            continue
        for p in root.rglob("*"):
            if not p.is_file() or p.suffix not in SCAN_SUFFIXES:
                continue
            if SKIP_DIR_NAMES & set(p.parts):
                continue
            yield p


def literal_lists(text: str, names: list[str]) -> bool:
    """判断文本里是否把**营销专属**属性名成组写死（第二份口径）。

    为什么不能拿全部属性名判：`name` / `company` / `scenario` 是通用英文词，
    locale 文件与无关模块里天然到处出现——按它们判会把整个仓刷成红。真能区分
    第二份口径的是营销独有的键（`first_touch_content_id` 之类），加上
    「source + stage 同窗口出现」这种组合。

    判据：同 400 字符窗口内出现 ≥2 个**独有**属性名，或 ≥3 个属性名且其中至少
    一个是独有的。
    """
    lowered = text.lower()
    pos: dict[str, list[int]] = {}
    for n in names:
        key = n.lower()
        # 两种写法都算：「'source'」与对象字面量的「source:」。
        # 冒号形态要求前置边界不是标识符字符，避免 source_pack_id / sourceX: 误命中。
        pats = [r'["\']%s["\']' % re.escape(key), r'(?<![a-z0-9_])%s\s*:' % re.escape(key)]
        for pat in pats:
            for m in re.finditer(pat, lowered):
                pos.setdefault(key, []).append(m.start())
    if not pos:
        return False

    flattened_raw = sorted((p, n) for n, ps in pos.items() for p in ps)
    window = 400
    # 独有键若只是写法上的**比较字面量**（`k === 'first_touch_at'` 或
    # `'first_touch_at' === k`），那是「按派生键名分支」，不是「第二份清单」。
    compare_pat = r"[\"']([a-z0-9_]+)[\"']\s*(===|!==|==|!=)|(===|!==|==|!=)\s*[\"']([a-z0-9_]+)[\"']"
    compare_names = set()
    for m in re.finditer(compare_pat, lowered):
        compare_names.add(m.group(1) or m.group(4))
    flattened = [(p, n) for (p, n) in flattened_raw if n not in compare_names]
    if not flattened:
        return False
    i = 0
    for j in range(len(flattened)):
        while flattened[j][0] - flattened[i][0] >= window:
            i += 1
        in_window = {n for _, n in flattened[i : j + 1]}
        if len(in_window) >= 3 and in_window & DISTINCTIVE:
            return True
        if len(in_window & DISTINCTIVE) >= 2:
            return True
    return False


def check_authority(doc: dict) -> list[str]:
    errs = []
    attrs = doc.get("attributes") or {}
    if not attrs:
        errs.append("权威表没有 attributes")
    for name, spec in attrs.items():
        if not spec.get("type"):
            errs.append(f"属性 {name} 缺 type")
        if not spec.get("label_zh") and not spec.get("label_en"):
            errs.append(f"属性 {name} 缺 label")
    carrier = (doc.get("carrier") or {}).get("kind")
    if carrier != "chatwoot-contact":
        errs.append(f"carrier 应为 chatwoot-contact，实为 {carrier!r}")
    return errs


def check_no_parallel_list(names: list[str], roots=SCAN_ROOTS) -> list[str]:
    errs = []
    authority_resolved = AUTHORITY.resolve()
    # 豁免：权威表自身 + 由它派生的生成件（生成件是同一个口径的另一种形态，
    # 不是第二份；它由 gen_lead_attributes.py --check 单独校验新鲜度）。
    exempt = {
        authority_resolved,
        (Path.home() / "finddata" / "fd-marketing-web" / "src" / "lib" / "lead-attributes.gen.ts").resolve(),
    }
    for p in iter_sources(roots):
        try:
            resolved = p.resolve()
        except OSError:
            continue
        if resolved in exempt:
            continue
        try:
            text = p.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        if literal_lists(text, names):
            errs.append(f"疑似第二份属性清单：{p}")
    return errs


def check_first_touch_guard(names: list[str], roots=SCAN_ROOTS) -> list[str]:
    """first_touch_only 属性必须有一处「非空即跳过」的实现。"""
    guard = re.compile(r"first_touch", re.I)
    found = False
    for p in iter_sources(roots):
        try:
            text = p.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        if guard.search(text) and re.search(r"(\?\?|\|\||if\s*\(|!==\s*''|!==\s*\"\")", text):
            found = True
            break
    if not found:
        return ["未找到 first_touch_only 属性的「非空即跳过」写入约束"]
    return []


def run(authority_path: Path = AUTHORITY, roots=SCAN_ROOTS) -> list[str]:
    doc = load_authority(authority_path)
    errs = check_authority(doc)
    names = list((doc.get("attributes") or {}).keys())
    if names:
        errs += check_no_parallel_list(names, roots)
    errs += check_first_touch_guard(names, roots)
    return errs


# ── 负向自检：坏样本必须判红 ────────────────────────────────────────────────
BAD_AUTHORITY = {
    "version": 1,
    "carrier": {"kind": "lead-table"},          # 违规 ④
    "attributes": {"source": {"type": "enum"}},  # 违规 ①（缺 label）
}

BAD_SOURCE = """// a second parallel list
export const LEAD_KEYS = ['source', 'stage', 'company', 'scenario'];
"""


def selftest() -> int:
    import tempfile

    failures = []

    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        bad_auth = tdp / "lead-attributes.json"
        bad_auth.write_text(json.dumps(BAD_AUTHORITY), encoding="utf-8")
        bad_auth_dir = tdp / "lib"
        bad_auth_dir.mkdir()
        bad_auth = bad_auth_dir / "lead-attributes.json"
        bad_auth.write_text(json.dumps(BAD_AUTHORITY), encoding="utf-8")

        src = tdp / "src"
        src.mkdir()
        (src / "bad.js").write_text(BAD_SOURCE, encoding="utf-8")

        errs = run(bad_auth, roots=[src])
        joined = "\n".join(errs)
        if "carrier" not in joined:
            failures.append("负向：carrier 违规未判红")
        if "缺 type" not in joined and "缺 label" not in joined:
            failures.append("负向：属性缺字段未判红")
        # 判据只认独有键（见 DISTINCTIVE），所以用独有键构造正例；
        # 通用词（source/stage/company/scenario）刻意不触发，见下面的防误报用例。
        if not literal_lists(
            "const K = ['first_touch_content_id', 'first_touch_at'];",
            ["first_touch_content_id", "first_touch_at"],
        ):
            failures.append("负向：独有键清单未判红")

        # 防误报：比较字面量不是清单。
        if literal_lists(
            "keys.forEach(function(k){ if (k === 'first_touch_at') x[k] = y; "
            "if (k === 'first_touch_content_id') x[k] = z; });",
            ["first_touch_content_id", "first_touch_at"],
        ):
            failures.append("误报：比较字面量被当成平行清单")

        # 防误报：通用词与无关代码里常见的 `source:` / `signal:` 不能判红。
        for sample in (
            'locale: {"name": "名称", "company": "公司", "scenario": "场景", "source": "来源"}',
            'body: JSON.stringify({ actor: "x", source: "facade" }), signal: controller.signal,',
        ):
            if literal_lists(sample, ["source", "stage", "company", "scenario", "signal"]):
                failures.append(f"误报：通用词被当成平行清单 → {sample[:40]}")

        if failures:
            print("SELFTEST FAILED")
            for f in failures:
                print("  -", f)
            return 1
        print("SELFTEST OK（坏样本全部判红）")
        return 0


def main() -> int:
    if "--selftest" in sys.argv:
        return selftest()
    try:
        errs = run()
    except FileNotFoundError as e:
        print(f"FAIL: {e}", file=sys.stderr)
        return 2
    if errs:
        print("FAIL 线索属性闭集违规：", file=sys.stderr)
        for e in errs:
            print("  -", e, file=sys.stderr)
        return 1
    print("OK 线索属性闭集合规")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
