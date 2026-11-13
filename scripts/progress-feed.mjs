#!/usr/bin/env node
// 项目进度进料器（add-progress-feed）——确定性抽取，不调 LLM。
//
// 它回答一个问题：「项目最近做到哪了」，并且**每条结论都能回指**（提交 sha 或仓内相对路径）。
// 它不下判断：不写「正在改什么」，只写「有 7 个未提交文件」。
//
//   node scripts/progress-feed.mjs --dry            # 只打印，不写（看清这一轮长什么样）
//   node scripts/progress-feed.mjs                  # 写一张页进永忆
//   node scripts/progress-feed.mjs --root <dir>     # 换仓库根（测试用）
//   node scripts/progress-feed.mjs --limit 5        # 只前 N 个仓（冒烟用）
//
// 写面纪律（读代码读出来的，别改）：
//   - /pages 拒绝平台/runner 令牌（service_tokens_carry_no_data_plane_identity），
//     必须用**成员 deployment 令牌**——它才把项目名 "shared" 解析到 d/<fleetId>/shared。
//   - /pages 用随机 slug，**追加不覆盖**，也没有 supersedes 参数。所以每轮只写一张页，
//     体量按「轮」增长，不按「仓」增长。
//
// 失败处理：网络/4xx/5xx 一律记日志 + 非零退出，**不重试到成功**，也不写「失败页」
// （真失败时连失败页也写不出；判据只能是上一张页的 as_of 停摆）。
//
// 环境（只从 env 取，不读仓库里的任何凭据文件）：
//   CELL_MEMORY_URL     永忆地址（如 http://127.0.0.1:8787）
//   CELL_MEMORY_TOKEN   成员 deployment 令牌（**不是**平台令牌、**不是** person 令牌）
//   PROGRESS_PROJECT    分区名，默认 "shared"
//   PROGRESS_REPO_ROOT  仓库根，默认 /Users/chengsishi/finddata
//   FEED_AS_OF          覆盖 as_of（测试用，ISO 字符串）

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SCRIPT = "progress-feed";

// 预算（规格：超限截断并标注，MUST NOT 静默丢）
const BODY_LIMIT = 12000;
const REPO_LINE_LIMIT = 8;

// 不作为「仓」看的目录：归档/历史/缓存
const SKIP_DIRS = new Set([
  "node_modules", "archive", "attic", "graphify-out", "dist", "screenshots",
  ".git", "evidence", "resources", "secrets",
]);

// handoff 只收**显式命名**的（用户裁决：只同步蒸馏后的 handoff，不同步原始会话）
const HANDOFF_RE = /^(handoff[-_].*\.md$|.*-handoff.*\.md$)/i;

function arg(name, dflt = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return dflt;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

function sh(cmd, args, cwd) {
  try {
    return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function isGitRepo(dir) {
  return existsSync(path.join(dir, ".git"));
}

export function repoBlock(dir, rel) {
  const head = sh("git", ["log", "-1", "--format=%h%x09%cI"], dir);
  if (head === null) return { block: null, reason: "git log 失败" };
  const [sha, iso] = head.split("\t");
  const branch = sh("git", ["rev-parse", "--abbrev-ref", "HEAD"], dir) ?? "?";
  // 跟踪内的改动与未跟踪文件分开数：`??` 里通常是构建产物，把它们并进「未提交」
  // 会让一个仓看起来像在打仗（实测 paas 报过 4803，几乎全是未跟踪产物）。
  const porcelain = (sh("git", ["status", "--porcelain"], dir) ?? "").split("\n").filter(Boolean);
  const untracked = porcelain.filter((l) => l.startsWith("??")).length;
  const changed = porcelain.length - untracked;
  const subjects = (sh("git", ["log", "-3", "--format=%h %s"], dir) ?? "").split("\n").filter(Boolean);

  const dirtyBit = changed ? `改动 ${changed}` : "无改动";
  const untrackedBit = untracked ? ` · 未跟踪 ${untracked}` : "";
  const lines = [`- 分支 \`${branch}\` · HEAD \`${sha}\` · ${iso} · ${dirtyBit}${untrackedBit}`];
  for (const s of subjects) lines.push(`  - ${s}`);
  const openspec = openspecBlock(dir);
  if (openspec.length) lines.push(...openspec);

  return { block: { rel, sha, iso, changed, untracked, lines }, reason: null };
}

export function openspecBlock(dir) {
  const changesDir = path.join(dir, "openspec", "changes");
  if (!existsSync(changesDir)) return [];
  let names;
  try {
    names = readdirSync(changesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== "archive")
      .map((d) => d.name);
  } catch {
    return ["  - ⚠ openspec/changes 不可读"];
  }
  if (!names.length) return [];
  const rows = [];
  for (const name of names.sort()) {
    const tasksPath = path.join(changesDir, name, "tasks.md");
    let progress = "";
    if (existsSync(tasksPath)) {
      try {
        const md = readFileSync(tasksPath, "utf8");
        const done = (md.match(/^- \[x\]/gim) ?? []).length;
        const todo = (md.match(/^- \[ \]/gim) ?? []).length;
        // 读得到但 0 条任务，与读不到，是两件不同的事——分别标出来，别都落成空串。
        progress = done + todo > 0 ? ` ${done}/${done + todo}` : " · 读得到但 0 条任务";
      } catch (e) {
        // 读失败**必须写在页上**：静默吞掉会让"tasks.md 坏了"和"这个变更没任务"同形，
        // 而这两者对读者意味着完全不同的事（数据问题 vs 进度问题）。
        progress = ` · ⚠ 读不到 tasks.md（${e?.code ?? e?.message ?? "unknown"}）`;
      }
    }
    rows.push(`  - 在途变更 \`${name}\`${progress}`);
  }
  return rows;
}

export function handoffsOf(dir) {
  const docsDir = path.join(dir, "docs");
  if (!existsSync(docsDir)) return [];
  const out = [];
  const walk = (d, depth) => {
    if (depth > 1) return;
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p, depth + 1); continue; }
      if (!HANDOFF_RE.test(e.name)) continue;
      let title = e.name;
      try {
        const firstLine = readFileSync(p, "utf8").split("\n").find((l) => l.trim().startsWith("#"));
        if (firstLine) title = firstLine.replace(/^#+\s*/, "").slice(0, 80);
      } catch { /* 标题读不到就用文件名 */ }
      out.push({ file: path.relative(dir, p), title });
    }
  };
  walk(docsDir, 0);
  return out.slice(0, 5);
}

export function scan(root) {
  const status = { ok: true, repos: 0, changes: 0, handoffs: 0, failures: [] };
  const blocks = [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (e) {
    return { status: { ok: false, repos: 0, changes: 0, handoffs: 0, failures: [`仓库根不可读: ${e.message}`] }, blocks: [] };
  }
  const dirs = entries
    .filter((d) => d.isDirectory() && !SKIP_DIRS.has(d.name))
    .map((d) => d.name)
    .sort();

  for (const name of dirs) {
    const dir = path.join(root, name);
    if (!isGitRepo(dir)) continue;
    const r = repoBlock(dir, name);
    if (!r.block) { status.failures.push(`${name}: ${r.reason}`); status.ok = false; continue; }
    status.repos += 1;
    status.changes += openspecBlock(dir).length;
    const hf = handoffsOf(dir);
    status.handoffs += hf.length;
    if (hf.length) r.block.lines.push(`  - handoff：${hf.map((h) => `${h.title}（\`${h.file}\`）`).join("、")}`);
    blocks.push(r.block);
  }
  // 最近有动静的排前面（进度页的第一屏就是「最近在做什么」）。
  // 按 Date.parse 排，不按字符串——各仓的 cI 带不同时区后缀，字典序会排错。
  const ts = (b) => { const t = Date.parse(b.iso); return Number.isFinite(t) ? t : 0; };
  blocks.sort((a, b) => ts(b) - ts(a));
  return { status, blocks };
}

// 进度页的 `source_head`：前 N 个仓的「仓@sha」。**只在这里定义一次**——
// 两个写者共用（成员令牌的 writePage 分支，与 person 令牌的 write-person-progress.mjs）。
// 2026-11-12 实测教训：person 令牌那条腿原先不写这个键，而书记读到的进度页正是它写的，
// 于是书记只能如实说「该页缺 source_head，只能用 as_of 与 authored_by 定位」——
// 不是服务丢了字段，是**两个写者口径不一致**。
export function sourceHeadOf(blocks, n = 5) {
  return (blocks ?? []).slice(0, n).map((b) => `${b.rel}@${b.sha}`).join(",");
}

export function compose(blocks, status, asOf) {
  const head = [
    `# 项目进度 · ${asOf}`,
    "",
    `> 确定性抽取（不调模型）：git HEAD / 未提交 / 最近提交、openspec 在途变更计数、显式 handoff 标题。`,
    `> 每条都带 sha 或仓内路径，可回仓核对。**引用时必须同时报 as_of 与距今时长。**`,
    "",
    `## 进料状态`,
    "",
    `- 结果：\`${status.ok ? "ok" : status.failures.length ? "partial" : "failed"}\``,
    `- 计数：仓 ${status.repos} · 在途变更 ${status.changes} · handoff ${status.handoffs}`,
    `- as_of：\`${asOf}\``,
  ];
  for (const f of status.failures) head.push(`- 失败：${f}`);
  head.push("");

  // 两级：最近动的仓详列（第一屏就是「最近在做什么」），其余一仓一行。
  // 一屏装不下 66 个仓的全部细节，但「全部仓都在」比「前 10 个仓很详细」更有用——
  // 书记要能回答「全线现在什么状态」，而不是只知道最热的三个。
  const DETAILED = 12;
  const detailed = blocks.slice(0, DETAILED);
  const rest = blocks.slice(DETAILED);

  const parts = [head.join("\n")];
  for (const b of detailed) {
    const lines = b.lines.slice(0, REPO_LINE_LIMIT);
    if (b.lines.length > REPO_LINE_LIMIT) lines.push(`  - …（已截断，共 ${b.lines.length} 行）`);
    parts.push(`## ${b.rel}\n\n${lines.join("\n")}\n`);
  }
  if (rest.length) {
    const rows = rest.map((b) => {
      const bits = [`- **${b.rel}**`, `\`${b.sha}\``, b.iso.slice(0, 16).replace("T", " ")];
      if (b.changed) bits.push(`改动 ${b.changed}`);
      if (b.untracked) bits.push(`未跟踪 ${b.untracked}`);
      return bits.join(" · ");
    });
    parts.push(`## 其余仓（按最后提交时间倒序）\n\n${rows.join("\n")}\n`);
  }

  let body = parts.join("\n");
  if (body.length > BODY_LIMIT) {
    const keep = body.slice(0, BODY_LIMIT);
    const cut = body.length - BODY_LIMIT;
    body = `${keep}\n\n…（正文已截断 ${cut} 字符，剩余仓请直接回仓核对）\n`;
  }
  return body;
}

async function writePage({ url, token, project, title, body, metadata }) {
  const res = await fetch(`${url.replace(/\/+$/, "")}/pages`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ project, title, body, metadata }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`pages HTTP ${res.status}: ${text.slice(0, 200)}`);
  return text;
}

async function main() {
  const dry = arg("dry", false) === true;
  const root = arg("root", process.env.PROGRESS_REPO_ROOT || "/Users/chengsishi/finddata");
  const limit = Number(arg("limit", 0)) || 0;
  const project = process.env.PROGRESS_PROJECT || "shared";
  const asOf = process.env.FEED_AS_OF || new Date().toISOString().replace(/\.\d+Z$/, "Z");

  const { status, blocks } = scan(root);
  const trimmed = limit > 0 ? blocks.slice(0, limit) : blocks;
  const body = compose(trimmed, status, asOf);
  const title = `项目进度 · ${asOf.slice(0, 10)}`;

  if (!status.repos) {
    // 一个仓都没读到 = 整轮失败。不写页（design D5：失败页在真失败时也写不出）。
    console.error(`[${SCRIPT}] FAILED: 没有可读的 git 仓（root=${root}）`);
    for (const f of status.failures) console.error(`  - ${f}`);
    process.exit(1);
  }

  if (dry) {
    console.log(`[${SCRIPT}] dry-run · project=${project} · repos=${status.repos} · bytes=${body.length}`);
    console.log("─".repeat(70));
    console.log(body);
    return;
  }

  const url = process.env.CELL_MEMORY_URL;
  const token = process.env.CELL_MEMORY_TOKEN;
  if (!url || !token) {
    console.error(`[${SCRIPT}] FAILED: 缺 CELL_MEMORY_URL 或 CELL_MEMORY_TOKEN（成员 deployment 令牌）`);
    process.exit(1);
  }
  try {
    const out = await writePage({
      url, token, project, title, body,
      metadata: {
        kind: "progress",
        as_of: asOf,
        source_head: sourceHeadOf(trimmed),
        authored_by: "agent:progress-feed",
        feed_status: status.ok ? "ok" : status.failures.length ? "partial" : "failed",
      },
    });
    console.log(`[${SCRIPT}] ok · repos=${status.repos} · ${out.slice(0, 200)}`);
  } catch (e) {
    // 失败要带名字与坐标：只写 "fetch failed" 的报错，半夜没人能从日志里判出
    // 是 URL 写错、令牌过期还是服务没起（本项目反复吃这个亏）。
    const cause = e?.cause?.code || e?.cause?.message || e?.message || String(e);
    console.error(`[${SCRIPT}] FAILED: 写入 ${url} 失败 · project=${project} · 原因=${cause}`);
    process.exit(2);
  }
}

// Only run when invoked directly: a test suite imports the pure functions
// above, and an unguarded top-level await would execute main() (and try to POST
// to a memory service) the moment it is imported.
const invokedDirectly =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) await main();
