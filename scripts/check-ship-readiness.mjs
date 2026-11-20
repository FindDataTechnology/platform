#!/usr/bin/env node
// ── 出片前的事实核对：这次要发的，到底是什么 ─────────────────────────────
//
// 2026-11-20 一天里，同一个问题从三个方向各咬我一次：
//
//   ① 生产 pod 里 `/app/server.js` 缺 9 个 import → 四个路由 404。判据是
//      「在生产里 grep 那句话」，而不是「CI 绿了」。
//   ② 公开镜像仓的 CI 一度停在一天前，4822 个提交从未被任何 CI 判过。判据是
//      「镜像的 baseCommit 是不是我要发的那个」，而不是「我本地跑了测试」。
//   ③ 推送前的 lint 闸读工作树而不是被推的字节，静默放行了一个启动即崩的
//      server.js。判据是「闸判的字节来自 range 本身」。
//
// 三次的共同形状：**拿着一句「应该是好的」当证据**。这个脚本把「应该是」换成
// 「量一遍」，且每条都带一个会真红的判据。
//
// 用法：
//   node scripts/check-ship-readiness.mjs              # 本地三查 + 远程两查
//   node scripts/check-ship-readiness.mjs --offline    # 只查本地 git 事实
//   node scripts/check-ship-readiness.mjs --json
//
// 退出码：0 全绿 · 1 有红项 · 2 判不出来（缺网络/凭据）—— 2 不许当绿读。

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
// `--root` lets a caller judge a DIFFERENT checkout than the one this script
// lives in. Tests need it: the red proof for "forked off an old point" checks
// out a commit from before this gate existed, so the script is not in that tree
// at all. Defaulting to the script's own repo keeps normal use one command.
const rootArg = process.argv.indexOf("--root");
const ROOT = rootArg > -1 ? path.resolve(process.argv[rootArg + 1]) : path.resolve(SCRIPTS_DIR, "..");
const args = new Set(process.argv.slice(2));
const OFFLINE = args.has("--offline");
const JSON_OUT = args.has("--json");

const MIRROR = "FindDataTechnology/platform";
const PROD_URL = "https://platform.finddatatech.cloud";

function git(...argv) {
  try {
    return { ok: true, out: execFileSync("git", argv, { cwd: ROOT, encoding: "utf8", stdio: "pipe" }).trim() };
  } catch (err) {
    return { ok: false, err: String(err.stderr ?? err.message).trim() };
  }
}

function gh(...argv) {
  try {
    return { ok: true, out: execFileSync("gh", argv, { encoding: "utf8", stdio: "pipe" }).trim() };
  } catch (err) {
    return { ok: false, err: String(err.stderr ?? err.message).trim() };
  }
}

const checks = [];
/** status: ok | bad | unknown. `unknown` is never ok — it is "I could not tell". */
function record(id, status, detail) {
  checks.push({ id, status, detail });
}

// ── 1. 我正要发的那个 sha，在不在 main 的祖先线上 ────────────────────────────
// 「从当前分支出片」是常规做法。若这个分支落后 main 上千笔，或者它从旧点分出
// 而 baseCommit 不是 main 的祖先，出出去的片子就是旧的——而它照样 CI 全绿。
{
  git("fetch", "--quiet", "gitee", "main");
  const head = git("rev-parse", "HEAD");
  const main = git("rev-parse", "gitee/main");
  if (!head.ok || !main.ok) {
    record("base-on-main", "unknown", `无法解析 HEAD 或 gitee/main：${head.err ?? main.err}`);
  } else if (head.out === main.out) {
    record("base-on-main", "ok", `HEAD == gitee/main (${head.out.slice(0, 9)})`);
  } else {
    const isAncestor = git("merge-base", "--is-ancestor", head.out, main.out);
    if (isAncestor.ok) {
      record("base-on-main", "ok", `HEAD ${head.out.slice(0, 9)} 是 gitee/main 的祖先（侧分支出片，合法）`);
    } else {
      const behind = git("rev-list", "--count", `${head.out}..${main.out}`);
      const ahead = git("rev-list", "--count", `${main.out}..${head.out}`);
      record(
        "base-on-main",
        "bad",
        behind.ok && Number(behind.out) > 0
          ? `HEAD 落后 gitee/main ${behind.out} 笔且不在其祖先线上；出片会发出旧代码`
          : `HEAD 与 gitee/main 分叉（领先 ${ahead.out ?? "?"} 笔）；确认这是有意的侧分支`,
      );
    }
  }
}

// ── 2. HEAD 引用的相对模块，是不是都在 HEAD 里 ──────────────────────────────
// 2026-11-20 `23c78073e fix(build): 补交 runtime-revision 三件套 —— HEAD 引用
// 未提交文件，出片必崩`。快照只打 HEAD（`git archive <ref>`），所以判据是
// **HEAD 自身的一致性**，与工作树无关：HEAD 里有一行 import，被引文件却不在
// HEAD 里，那个镜像就启动即崩。
//
// 判据用 `git cat-file -e HEAD:<path>`，不看磁盘 —— 磁盘上有正是这个 bug 的
// 成因（本地跑得起来，出片崩）。第一版写成「未跟踪但存在」，红证构造时立刻
// 露馅：把文件删掉它就判绿了，而 HEAD 的断链一点没变。
{
  const broken = [];
  const entryFiles = ["server.js", "gateway/index.js", "facet/index.js"];

  for (const entry of entryFiles) {
    const shown = git("show", `HEAD:${entry}`);
    if (!shown.ok) continue;
    for (const m of shown.out.matchAll(/(?:from\s+|import\s*\(\s*)["'](\.[^"']+)["']/g)) {
      const spec = m[1];
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(entry), spec));
      const candidates = [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, path.posix.join(base, "index.js")];
      if (!candidates.some((c) => git("cat-file", "-e", `HEAD:${c}`).ok)) {
        broken.push(`${entry} → ${spec}`);
      }
    }
  }
  if (broken.length) {
    record(
      "committed-refs",
      "bad",
      `HEAD 引用了 HEAD 里不存在的模块，快照里是断链、启动即崩：\n    ${broken.join("\n    ")}`,
    );
  } else {
    record("committed-refs", "ok", "三个入口在 HEAD 里的相对 import 全部指向 HEAD 内的文件");
  }
}

// ── 3. 出片闸自己能跑吗 ─────────────────────────────────────────────────────
// 一个「因为没装依赖而静默跳过」的闸，和没有闸一样（2026-11-11 两个推送都是
// 这么过去的）。这里只问「它在不在、跑不跑得起来」。
{
  const gates = [
    "scripts/test-route-assembly.mjs",
    "scripts/test-lint-changed-source.mjs",
    "scripts/check-import-integrity.mjs",
  ];
  const missing = gates.filter((g) => !git("cat-file", "-e", `HEAD:${g}`).ok);
  if (missing.length) record("gates-present", "bad", `出片前闸缺文件：${missing.join(", ")}`);
  else record("gates-present", "ok", `${gates.length} 道闸都在 HEAD 里`);
}

// ── 4. 公开镜像仓跑的是不是我要发的那个 base ────────────────────────────────
// CI 跑在镜像仓上，不跑在本仓。镜像的 baseCommit 落后 = 本地全绿也没有意义。
if (!OFFLINE) {
  const raw = gh("api", `repos/${MIRROR}/contents/BUILD-INFO.json`, "--jq", ".content");
  if (!raw.ok) {
    record("mirror-base", "unknown", `读不到 ${MIRROR}/BUILD-INFO.json（gh 未登录或网络不通）`);
  } else {
    let info = null;
    try {
      info = JSON.parse(Buffer.from(raw.out, "base64").toString("utf8"));
    } catch {
      /* fall through to unknown */
    }
    if (!info?.baseCommit) {
      record("mirror-base", "unknown", "BUILD-INFO.json 里没有 baseCommit");
    } else if (!git("cat-file", "-e", `${info.baseCommit}^{commit}`).ok) {
      record("mirror-base", "unknown", `镜像 base ${info.baseCommit.slice(0, 9)} 不在本仓历史里，判不出亲疏`);
    } else {
      const behind = git("rev-list", "--count", `${info.baseCommit}..gitee/main`);
      const n = behind.ok ? Number(behind.out) : NaN;
      // A snapshot is cut, then main moves on — being a few commits behind is
      // the normal steady state, not a defect. The defect is CI judging code
      // that is far off the line: 2026-11-20 the mirror sat a DAY and 4882
      // commits behind while every local gate read "green". Threshold, not zero.
      const LAG_BAD = 50;
      record(
        "mirror-base",
        !Number.isFinite(n) ? "unknown" : n <= LAG_BAD ? "ok" : "bad",
        !Number.isFinite(n)
          ? `镜像 base ${info.baseCommit.slice(0, 9)} 落后笔数判不出`
          : n === 0
            ? `镜像 base ${info.baseCommit.slice(0, 9)} == gitee/main（CI 判的就是当前代码）`
            : n <= LAG_BAD
              ? `镜像 base ${info.baseCommit.slice(0, 9)} 落后 ${n} 笔（快照常态，阈值 ${LAG_BAD}）`
              : `镜像 base ${info.baseCommit.slice(0, 9)} 落后 gitee/main ${n} 笔 —— CI 绿不覆盖这几百笔，先同步镜像`,
      );
    }
  }
}

// ── 5. 生产上那几个「曾经 404」的面，现在答什么 ──────────────────────────────
// 判据是响应体，不是状态码：SPA 兜底会把不存在的 /api 路径也答成 404 HTML。
if (!OFFLINE) {
  const probes = ["/api/input-requests", "/api/teams/cards"];
  const results = [];
  for (const p of probes) {
    try {
      const res = execFileSync(
        "curl",
        ["-s", "--noproxy", "*", "-o", "-", "-w", "\n%{http_code}", "--max-time", "15", `${PROD_URL}${p}`],
        { encoding: "utf8", stdio: "pipe" },
      );
      const nl = res.lastIndexOf("\n");
      const body = res.slice(0, nl).trim();
      const code = res.slice(nl + 1).trim();
      const isSpaHtml = body.startsWith("<!DOCTYPE") || body.includes("<html");
      results.push({ p, code, unrouteable: isSpaHtml });
    } catch (err) {
      results.push({ p, code: "ERR", unrouteable: null, err: String(err.message).slice(0, 60) });
    }
  }
  const unrouted = results.filter((r) => r.unrouteable === true);
  if (results.some((r) => r.code === "ERR")) {
    record("prod-routes", "unknown", `探针打不通：${results.map((r) => `${r.p}=${r.code}`).join(", ")}`);
  } else if (unrouted.length) {
    record(
      "prod-routes",
      "bad",
      `以下路径落到 SPA 兜底 HTML，说明路由没装配：${unrouted.map((r) => `${r.p}(${r.code})`).join(", ")}`,
    );
  } else {
    record("prod-routes", "ok", results.map((r) => `${r.p}=${r.code}`).join(", "));
  }
}

// ── 输出 ────────────────────────────────────────────────────────────────────
const worst = checks.some((c) => c.status === "bad")
  ? "bad"
  : checks.some((c) => c.status === "unknown")
    ? "unknown"
    : "ok";

if (JSON_OUT) {
  console.log(JSON.stringify({ verdict: worst, checks }, null, 2));
} else {
  const mark = { ok: "✓", bad: "✗", unknown: "?" };
  for (const c of checks) console.log(`${mark[c.status]} [${c.id}] ${c.detail}`);
  console.log(
    worst === "ok"
      ? "\n全绿。"
      : worst === "bad"
        ? "\n有红项 —— 先修，别出片。"
        : "\n有判不出来的项（不是「没事」）—— 补上凭据/网络再跑。",
  );
}

process.exit(worst === "ok" ? 0 : worst === "bad" ? 1 : 2);
