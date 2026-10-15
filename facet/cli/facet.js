#!/usr/bin/env node
// ── @finddatatechnology/facet — 谦面 CLI (add-facet-platform S3; add-ecosystem-bridge) ──
//
// Installs a published pack's skills from the facet marketplace into editor
// targets (Claude Code, Cursor, ZCode, Codex, Gemini CLI). Marketplace fetches
// are the same anonymous public routes the registry uses; a pack reference is
// its id (or any URL/string containing it). The install is a version snapshot
// — no subscription is created, no update push follows (spec: facet-editor-cli).
//
// MCP references are printed with their real connection endpoint and the
// credential requirement. Without a verified caller key on file the CLI writes
// NO MCP configuration into any editor; with one (facet connect), install
// offers to write each target's native MCP config carrying that key.
//
//   npx @finddatatechnology/facet install <packRef> [--target …] [--project <dir>]
//   npx @finddatatechnology/facet connect [--key wgk-…] [--clear] [--show]

import { realpathSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Version lives in package.json only — a hardcoded copy shipped 0.1.0 for
// three releases (caught by `npx @finddatatechnology/facet@0.1.2 --version`).
const VERSION = JSON.parse(
  await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "package.json"), "utf8"),
).version;
const DEFAULT_BASE = process.env.FACET_BASE || "https://facet.finddatatech.cloud";
const DEFAULT_REGISTRY = process.env.FACET_REGISTRY || "https://mcp.finddatatech.cloud";

const USAGE = `facet v${VERSION} — 谦面功能集安装器 / 萬星调用者偏好

用法：
  facet install <packRef> [--target claude-code|cursor|zcode|codex|gemini-cli]
                          [--project <dir>] [--base <url>] [--registry <url>]
  facet update [packRef] [--target <t>] [--base <url>]   # 重取最新版快照（无订阅副作用）
  facet connect [--key wgk-…] [--registry <url>] [--clear] [--show] [--no-open]
  facet prefs <agent-slug> [--key sk-…] [--wanxing <url>]
                          [--set-callback <url> <secret>] [--set-reap <minutes>]
                          [--clear callback|reap|all] [--show]
  facet publish <manifest.json | 功集id> [--from <自部署实例>]
                          [--market <url>] [--pack-id <官方id>] [--new] [--no-open]
  facet help | --version

  <packRef>  功能集 id（市场详情页可见）或含 id 的 URL
  --target   安装目标（默认 claude-code）：写技能到目标编辑器的技能目录
  --project  项目级安装：写进 <dir>/.<target>/skills/ 而非用户级目录
  --base     谦面地址（默认 ${DEFAULT_BASE}）
  --registry 注册处地址——打印 MCP 端点；connect 用它验活与铸造

  connect 子命令（ecosystem-bridge）：铸取并验活 wgk- 调用键，存本地后
  install 可写各编辑器的 MCP 连接配置。--key 免交互粘贴；缺省打开铸造页
  后从 stdin 读入。--show 看已存状态；--clear 清除。

  prefs 子命令（萬星调用者偏好，调用键即凭证）：
  <agent-slug>   目录页的 agent 标识（如 packs-xxxx-agent）
  --key          sub2api 调用键（sk-…）；缺省读环境变量 FACET_CALLER_KEY
  --wanxing      萬星门面地址（默认 https://wanxing.finddatatech.cloud）
  --set-callback 回合完成回调：URL 与 HMAC 签名密钥（两者同设同清）
  --set-reap     上下文收割窗（分钟）；--clear 显式清除即回落平台默认

目标布局（五家同构：<dotdir>/skills/<skill>/SKILL.md）：
  claude-code ~/.claude/skills/…   cursor  ~/.cursor/skills/…
  zcode       ~/.zcode/skills/…    codex   ~/.codex/skills/…
  gemini-cli  ~/.gemini/skills/…   （项目级均为 <dir>/.<target>/skills/…）

  update 子命令（F2.3）：按 ~/.facet/installed.json 的记录重取各包最新版——已最新
  即 no-op，升级打印 v旧 → v新；零订阅副作用（快照模型）。

  publish 子命令（F3.2 回流桥）：把功集 manifest 发到官方市场——本地清单文件，
  或从自部署实例的公开详情拉取（--from <base>，或直接给功集页 URL）。首次运行
  走配对：打开 ${DEFAULT_BASE}/api/mp/bindcode（登录创作者账号）取 6 位绑定码，
  输回终端；之后每次静默续登。token 不落盘；首发记 源id→官方id 映射，同源续推
  自动出新版本（--new 强制新包；--pack-id 手工指定官方 id）。
  creators 门/清单校验/工具声明门/限流 全在官方侧判定，本 CLI 只搬运。

说明：安装即版本快照（不产生订阅）；MCP 需 registry 账号凭据，端点仅打印。`;

function parseArgs(argv) {
  const out = { command: null, packRef: null, target: "claude-code", project: null, base: DEFAULT_BASE, registry: DEFAULT_REGISTRY, market: DEFAULT_BASE, from: null, packId: null, key: null, wanxing: process.env.FACET_WANXING || "https://wanxing.finddatatech.cloud", setCallback: null, setReap: undefined, clear: null };
  const rest = [...argv];
  out.command = rest.shift() ?? null;
  // A bare flag in command position (`facet --version`, `facet -h`) is the
  // flag, not an unknown command.
  if (out.command === "--version" || out.command === "-v") out.command = "version";
  else if (out.command === "--help" || out.command === "-h") out.command = "help";
  while (rest.length > 0) {
    const a = rest.shift();
    if (a === "--target") {
      out.target = rest.shift();
      out.targetExplicit = true; // update filters only on an explicit target
    }
    else if (a === "--project") out.project = rest.shift();
    else if (a === "--base") out.base = rest.shift();
    else if (a === "--registry") out.registry = rest.shift();
    else if (a === "--key") out.key = rest.shift();
    else if (a === "--wanxing") out.wanxing = rest.shift();
    else if (a === "--from") out.from = rest.shift();
    else if (a === "--market") out.market = rest.shift();
    else if (a === "--pack-id") out.packId = rest.shift();
    else if (a === "--new") out.fresh = true;
    else if (a === "--set-callback") {
      const url = rest.shift();
      const secret = rest.shift();
      if (!url || !secret) throw new Error("--set-callback 需要两个值：<url> <secret>");
      out.setCallback = [url, secret];
    }
    else if (a === "--set-reap") out.setReap = rest.shift();
    else if (a === "--clear") out.clear = out.command === "connect" ? true : rest.shift();
    else if (a === "--no-open") out.noOpen = true;
    else if (a === "--write-mcp") out.writeMcp = true;
    else if (a === "--no-write-mcp") out.noWriteMcp = true;
    else if (a === "--show") out.show = true;
    else if (a === "--help" || a === "-h") out.command = "help";
    else if (a === "--version" || a === "-v") out.command = "version";
    else if (!a.startsWith("-") && !out.packRef) out.packRef = a;
    else throw new Error(`未知参数：${a}`);
  }
  return out;
}

// Accepts a bare id, a URL, or any string containing the id as a path segment.
function extractPackId(ref) {
  if (!ref) return null;
  try {
    const url = new URL(ref);
    const segs = url.pathname.split("/").filter(Boolean);
    const i = segs.indexOf("packs");
    if (i >= 0 && segs[i + 1]) return segs[i + 1];
  } catch {
    /* not a URL */
  }
  return String(ref).trim();
}

// SKILLS_SUBDIR and MCP_TARGETS are exported for the docs-facts single-source
// test (add-facet-docs-view): the shell's documentation view renders target
// directories and native MCP config paths from its own facts table, and
// scripts/test-facet-docs-facts.mjs asserts the two tables are equal — the
// docs cannot drift from the shipped CLI.
const SKILLS_SUBDIR = {
  "claude-code": ".claude",
  cursor: ".cursor",
  zcode: ".zcode",
  codex: ".codex",
  "gemini-cli": ".gemini",
};

// FACET_HOME redirects every user-level path (skills targets, MCP configs,
// credentials) — the test seam; unset means the real home.
const HOME = () => process.env.FACET_HOME || homedir();

// Each target's native MCP configuration: where the file lives and what one
// server entry looks like carrying the wgk- key as an Authorization header.
// Shapes verified against live 2026 conventions:
//   claude-code ~/.claude.json {type,url,headers} · cursor ~/.cursor/mcp.json {url,headers}
//   zcode ~/.zcode/cli/config.json mcp.servers {type,url,headers} ·
//   gemini-cli ~/.gemini/settings.json {httpUrl,headers} · codex ~/.codex/config.toml
//   [mcp_servers.<name>] url= http_headers=
const MCP_TARGETS = {
  "claude-code": {
    userFile: () => path.join(HOME(), ".claude.json"),
    projectFile: (dir) => path.join(dir, ".mcp.json"),
    json: { container: (doc) => doc, key: "mcpServers" },
    entry: (url, headers) => ({ type: "http", url, headers }),
  },
  cursor: {
    userFile: () => path.join(HOME(), ".cursor", "mcp.json"),
    projectFile: (dir) => path.join(dir, ".cursor", "mcp.json"),
    json: { container: (doc) => doc, key: "mcpServers" },
    entry: (url, headers) => ({ url, headers }),
  },
  zcode: {
    userFile: () => path.join(HOME(), ".zcode", "cli", "config.json"),
    json: { container: (doc) => (doc.mcp ??= {}), key: "servers" },
    entry: (url, headers) => ({ type: "http", url, headers }),
  },
  "gemini-cli": {
    userFile: () => path.join(HOME(), ".gemini", "settings.json"),
    json: { container: (doc) => doc, key: "mcpServers" },
    entry: (url, headers) => ({ httpUrl: url, headers }),
  },
  codex: {
    userFile: () => path.join(HOME(), ".codex", "config.toml"),
    toml: true,
  },
};

function readJsonFile(file) {
  return readFile(file, "utf8").then((t) => JSON.parse(t)).catch(() => ({}));
}

// Upsert one JSON MCP entry; returns the file path written.
async function upsertJsonMcp(file, container, key, name, entry) {
  const doc = await readJsonFile(file);
  const box = container(doc);
  box[key] ??= {};
  box[key][name] = entry;
  const existed = await stat(file).then(() => true).catch(() => false);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(doc, null, 2) + "\n", "utf8");
  if (!existed) await chmod(file, 0o600); // the file now carries the caller key
  return file;
}

// Upsert one [mcp_servers.<name>] TOML block; returns the file path written.
async function upsertTomlMcp(file, name, url, headers) {
  const block = [
    `[mcp_servers.${name}]`,
    `url = "${url}"`,
    `http_headers = { ${Object.entries(headers).map(([k, v]) => `"${k}" = "${v}"`).join(", ")} }`,
    "",
  ].join("\n");
  const existed = await stat(file).then(() => true).catch(() => false);
  let text = existed ? await readFile(file, "utf8") : "";
  const re = new RegExp(`\\[mcp_servers\\.${name}\\][^\\[]*`, "s");
  if (re.test(text)) text = text.replace(re, block);
  else text = text.replace(/\s*$/, "\n") + (text.trim() ? "\n" : "") + block;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, "utf8");
  if (!existed) await chmod(file, 0o600);
  return file;
}

// Write the pack's MCP references into the target's native config. Returns
// the list of files written (for the CLI's report). Only ever user-level
// except claude-code, whose native project-level surface is <dir>/.mcp.json.
async function writeMcpConfig(target, { registry, servers, key, project }) {
  const t = MCP_TARGETS[target];
  if (!t) throw new Error(`目标「${target}」没有 MCP 配置约定`);
  const files = [];
  for (const s of servers) {
    const url = `${registry}/${s.registryName}/mcp`;
    const headers = { Authorization: `Bearer ${key}` };
    if (t.toml) files.push(await upsertTomlMcp(t.userFile(), s.registryName, url, headers));
    else {
      const file = project && t.projectFile ? t.projectFile(project) : t.userFile();
      files.push(await upsertJsonMcp(file, t.json.container, t.json.key, s.registryName, t.entry(url, headers)));
    }
  }
  return files;
}

function targetDir({ target, project }) {
  const dotdir = SKILLS_SUBDIR[target];
  if (!dotdir) {
    throw new Error(`不支持的目标「${target}」——支持：${Object.keys(SKILLS_SUBDIR).join("、")}`);
  }
  const root = project ? path.resolve(project) : HOME();
  return { dir: path.join(root, dotdir, "skills"), scope: project ? "项目级" : "用户级" };
}

async function fetchJson(url) {
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r.json();
}

// ── connect: 生态调用键（add-ecosystem-bridge） ─────────────────────────────
// The external developer's surface: mint a wgk- caller key in the registry
// console (browser), paste it, have the CLI verify it live against the
// registry and store it locally (0600). Installs then offer to write editor
// MCP configuration carrying this key. The key never travels anywhere but
// the registry it belongs to.

export function credentialsPath() {
  return process.env.FACET_CREDENTIALS_PATH || path.join(HOME(), ".facet", "credentials.json");
}

// ── Install records (add-facet-cli-update, F2.3) ───────────────────────────────
// The update path's single source of truth: which packs are installed where,
// at which snapshot version. Skill frontmatter carries no version, so a
// local record is the only reliable map; re-running install re-enrolls.
export function installedPath() {
  return process.env.FACET_INSTALLED_PATH || path.join(HOME(), ".facet", "installed.json");
}

async function loadInstalled() {
  try {
    const doc = JSON.parse(await readFile(installedPath(), "utf8"));
    return Array.isArray(doc?.installs) ? doc.installs : [];
  } catch {
    return [];
  }
}

async function saveInstalled(installs) {
  await mkdir(path.dirname(installedPath()), { recursive: true });
  await writeFile(installedPath(), JSON.stringify({ installs }, null, 2) + "\n", "utf8");
}

const installKey = (r) => `${r.packId}\u0000${r.target}\u0000${r.scope}\u0000${r.project ?? ""}`;

async function recordInstall(rec) {
  const installs = await loadInstalled();
  const key = installKey(rec);
  const next = installs.filter((r) => installKey(r) !== key);
  next.push(rec);
  await saveInstalled(next);
}

// The snapshot write path shared by install and update — an update's bytes
// are a fresh install's bytes by construction.
async function writeSkillSnapshot(base, detail, dir, { quiet = false } = {}) {
  const version = detail.version;
  const skills = detail.manifest?.skills ?? [];
  let ok = 0;
  for (const skill of skills) {
    const mdUrl = `${base}/api/packs/${encodeURIComponent(detail.id)}/versions/${version}/skills/${encodeURIComponent(skill.name)}.md`;
    const r = await fetch(mdUrl, { headers: { Accept: "text/markdown" } });
    if (!r.ok) {
      console.log(`  ✗ ${skill.name} — 下载失败 HTTP ${r.status}`);
      continue;
    }
    const body = await r.text();
    const skillDir = path.join(dir, skill.name);
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, "SKILL.md"), body, "utf8");
    if (!quiet) console.log(`  ✓ ${path.join(skillDir, "SKILL.md")}`);
    ok += 1;
  }
  return ok;
}

export async function loadCredentials() {
  try {
    const doc = JSON.parse(await readFile(credentialsPath(), "utf8"));
    if (typeof doc?.key === "string" && doc.key) return doc;
    return null;
  } catch {
    return null;
  }
}

async function saveCredentials(doc) {
  const file = credentialsPath();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(doc, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  await chmod(file, 0o600); // mode only applies at creation; enforce on rewrite too
}

export async function clearCredentials() {
  await rm(credentialsPath(), { force: true });
}

export function maskKey(key) {
  if (!key) return "（未存）";
  return key.length <= 8 ? key.slice(0, 4) + "…" : `${key.slice(0, 4)}…${key.slice(-4)}`;
}

// Liveness = the key authenticates on the registry's own /api surface (patch
// keys ride Bearer on both MCP proxy and /api paths). Visible servers are
// best-effort: the read face is per-caller filtered, but an older registry
// without it must not fail the connect.
export async function verifyCallerKey(registry, key) {
  const headers = { Authorization: `Bearer ${key}` };
  const listed = await fetch(`${registry}/api/patch-keys`, { headers }).catch((e) => {
    throw new Error(`注册处不可达：${e.cause?.code || e.message}`);
  });
  if (listed.status === 401 || listed.status === 403) {
    throw new Error(`键验活失败（HTTP ${listed.status}）——键无效、已吊销或无权访问，未存任何内容`);
  }
  if (!listed.ok) {
    throw new Error(`键验活失败（HTTP ${listed.status}）——未存任何内容`);
  }
  let servers = null;
  try {
    const r = await fetch(`${registry}/api/servers`, { headers });
    if (r.ok) {
      const doc = await r.json();
      servers = (Array.isArray(doc) ? doc : doc?.servers ?? [])
        .map((s) => s?.name ?? s?.server?.name ?? s?.id)
        .filter(Boolean);
    }
  } catch { /* best-effort */ }
  return { servers };
}

async function readKeyFromStdin(prompt = "粘贴 wgk- 调用键（回车确认）：") {
  const rl = (await import("node:readline/promises")).createInterface({ input: process.stdin });
  try {
    const k = (await rl.question(prompt)).trim();
    if (!k) throw new Error("未读入输入");
    return k;
  } finally {
    rl.close();
  }
}

// ── Device authorization (RFC 8628) — optional registry capability ─────────
// When the registry advertises device authorization, connect completes with
// no paste at all; otherwise the paste flow runs. The advertised access token
// is treated as the caller key and goes through the same live verification.
export async function discoverDeviceAuth(registry) {
  const r = await fetch(`${registry}/.well-known/oauth-authorization-server`, {
    headers: { Accept: "application/json" },
  }).catch(() => null);
  if (!r?.ok) return null;
  const doc = await r.json().catch(() => null);
  return doc?.device_authorization_endpoint && doc?.token_endpoint ? doc : null;
}

export async function deviceFlow(_registry, meta, { noOpen = false, onCode = () => {} } = {}) {
  const da = await fetch(meta.device_authorization_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ client_id: "facet-cli" }),
  });
  if (!da.ok) throw new Error(`设备授权起点失败（HTTP ${da.status}）`);
  const d = await da.json();
  onCode(d);
  console.log(`打开并输入代码完成授权：${d.verification_uri}`);
  if (d.user_code) console.log(`用户代码：${d.user_code}`);
  if (!noOpen && process.platform !== "win32") {
    const { execFile } = await import("node:child_process");
    const open = process.platform === "darwin" ? "open" : "xdg-open";
    execFile(open, [d.verification_uri_complete || d.verification_uri], () => {});
  }
  const intervalMs = Math.max(1, Number(d.interval) || 5) * 1000;
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const tr = await fetch(meta.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: d.device_code,
        client_id: "facet-cli",
      }),
    });
    const t = await tr.json().catch(() => ({}));
    if (tr.ok && t.access_token) return t.access_token;
    if (t.error === "authorization_pending" || t.error === "slow_down") continue;
    throw new Error(`设备授权未完成：${t.error || `HTTP ${tr.status}`}`);
  }
  throw new Error("设备授权超时（5 分钟）");
}

export async function connectRun(opts) {
  const registry = String(opts.registry).replace(/\/+$/, "");

  if (opts.clear === true) {
    await clearCredentials();
    console.log("已清除本地调用键。");
    return;
  }
  if (opts.show) {
    const doc = await loadCredentials();
    if (!doc) return console.log("本地未存调用键——运行 facet connect 铸取。");
    console.log(`调用键 ${maskKey(doc.key)}（验活于 ${doc.verifiedAt}）`);
    console.log(`注册处 ${doc.registry}`);
    if (doc.servers?.length) console.log(`可见 server：${doc.servers.join("、")}`);
    return;
  }

  let key = opts.key;
  if (!key) {
    const meta = await discoverDeviceAuth(registry).catch(() => null);
    if (meta) {
      key = await deviceFlow(registry, meta, { noOpen: opts.noOpen });
    } else {
      console.log(`铸造页：${registry}（登录后 → API Keys / Patch Keys → 生成个人 wgk- 键）`);
      if (!opts.noOpen && process.platform !== "win32") {
        const { execFile } = await import("node:child_process");
        const open = process.platform === "darwin" ? "open" : "xdg-open";
        execFile(open, [registry], () => {}); // best-effort; the URL is printed regardless
      }
      key = await readKeyFromStdin();
    }
  }
  key = String(key).trim();
  if (!key.startsWith("wgk-")) {
    throw new Error("调用键应以 wgk- 开头（sk- 是 sub2api 键，属 prefs 域）——未存任何内容");
  }

  const { servers } = await verifyCallerKey(registry, key);
  await saveCredentials({ key, registry, verifiedAt: new Date().toISOString(), servers });
  console.log(`✓ 键验活通过，已存 ${credentialsPath()}（0600）`);
  if (servers?.length) console.log(`  可见 server：${servers.join("、")}`);
  console.log("之后 install 将在征得同意后写入各编辑器的 MCP 连接配置。");
}

async function install(opts) {
  const base = String(opts.base).replace(/\/+$/, "");
  const registry = String(opts.registry).replace(/\/+$/, "");
  const packId = extractPackId(opts.packRef);
  if (!packId) throw new Error("缺少功能集引用——用法见 facet help");

  const detail = await fetchJson(`${base}/api/packs/${encodeURIComponent(packId)}`).catch(() => null);
  if (!detail?.id) throw new Error(`功能集未找到：${packId}（检查 id，或该包为私有/已下架）`);

  const { dir, scope } = targetDir(opts);
  const version = detail.version;
  const skills = detail.manifest?.skills ?? [];

  console.log(`谦面 Facet · 安装 ${detail.name}（${detail.id}）v${version} → ${opts.target}（${scope}）`);
  if (skills.length === 0) console.log("  （该功能集没有技能条目）");
  await writeSkillSnapshot(base, detail, dir);
  await recordInstall({ packId: detail.id, name: detail.name, target: opts.target, scope, project: opts.project ? path.resolve(opts.project) : null, version, installedAt: new Date().toISOString() });

  const mcp = detail.manifest?.mcpServers ?? [];
  if (mcp.length > 0) {
    const stored = await loadCredentials();
    if (!stored) {
      console.log("\nMCP 引用（未写入任何编辑器配置——本地未存调用键）：");
      for (const s of mcp) {
        const endpoint = `${registry}/${s.registryName}/mcp`;
        const group = s.requiredGroup ? `（需要组：${s.requiredGroup}）` : "";
        console.log(`  · ${s.registryName}${group}`);
        console.log(`    端点 ${endpoint} — 连接需 wgk- 调用键`);
      }
      console.log("  运行 facet connect 铸取并验活调用键；之后 install 可代写连接配置。");
    } else {
      const shouldWrite = opts.writeMcp === true || (opts.noWriteMcp !== true && process.stdin.isTTY
        ? await (async () => {
            const rl = (await import("node:readline/promises")).createInterface({ input: process.stdin });
            try {
              const a = (await rl.question("已存调用键——写入本 target 的 MCP 连接配置？[y/N] ")).trim().toLowerCase();
              return a === "y" || a === "yes";
            } finally { rl.close(); }
          })()
        : false);
      if (!shouldWrite) {
        console.log("\nMCP 引用（持键但未写入；--write-mcp 启用写入）：");
        for (const s of mcp) {
          const endpoint = `${registry}/${s.registryName}/mcp`;
          const group = s.requiredGroup ? `（需要组：${s.requiredGroup}）` : "";
          console.log(`  · ${s.registryName}${group} — 端点 ${endpoint}`);
        }
      } else {
        const files = await writeMcpConfig(opts.target, {
          registry, servers: mcp, key: stored.key, project: opts.project,
        });
        console.log("\nMCP 连接配置已写入：");
        for (const f of [...new Set(files)]) console.log(`  ✓ ${f}`);
        for (const s of mcp) {
          if (s.requiredGroup) console.log(`  注：${s.registryName} 需要组 ${s.requiredGroup}——键的组不含它时调用会被拒。`);
        }
      }
    }
  }

  if (opts.target === "cursor") {
    console.log("\n注：Cursor 的技能目录支持随版本而异；若该目录未被读取，可将 SKILL.md 内容接入 Cursor Rules（.cursor/rules/）。");
  }
  if (opts.target === "codex") {
    console.log("\n注：Codex 亦有 ~/.agents/skills/ 约定但发现尚不稳定；本安装写官方 ~/.codex/skills/ 路径。");
  }
  console.log(`\n完成：${detail.id} v${version}（快照安装，无订阅副作用）。`);
  console.log(`把功能集装进运行时（对话/Agent 服务）请到壹座：设置 → 功能集 → 我的功能集（订阅后一键安装）。`);
}

// ── prefs: 萬星调用者偏好（add-caller-preferences） ─────────────────────────
// The caller's own surface for their per-agent preferences: the sub2api
// caller key is the credential (no login, matching the A2A door's rule).
async function prefs(opts) {
  const base = String(opts.wanxing).replace(/\/+$/, "");
  const slug = opts.packRef;
  if (!slug) throw new Error("缺少 agent slug——用法见 facet help");
  const key = opts.key || process.env.FACET_CALLER_KEY || "";
  if (!key) throw new Error("需要调用键：--key sk-… 或环境变量 FACET_CALLER_KEY");

  const call = async (method, body) => {
    const r = await fetch(`${base}/api/wanxing/v1/prefs/${encodeURIComponent(slug)}`, {
      method,
      headers: { Authorization: `Bearer ${key}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const doc = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(doc?.error?.message || doc?.error || `HTTP ${r.status}`);
    return doc;
  };

  const patch = {};
  if (opts.setCallback) {
    patch.callbackUrl = opts.setCallback[0];
    patch.callbackSecret = opts.setCallback[1];
  }
  if (opts.setReap !== undefined) {
    const n = Number(opts.setReap);
    if (!Number.isInteger(n) || n < 1) throw new Error("--set-reap 需要正整数分钟数");
    patch.reapMinutes = n;
  }
  if (opts.clear !== null) {
    if (!["callback", "reap", "all"].includes(opts.clear)) throw new Error("--clear 只接受 callback | reap | all");
    if (opts.clear === "callback" || opts.clear === "all") {
      patch.callbackUrl = null;
      patch.callbackSecret = null;
    }
    if (opts.clear === "reap" || opts.clear === "all") patch.reapMinutes = null;
  }

  const show = (p) => {
    console.log(`调用者偏好 · ${slug}`);
    console.log(`  回合完成回调：${p.callbackUrl ?? "（未设）"}${p.callbackSecretSet ? "（签名密钥已设）" : ""}`);
    console.log(`  上下文收割窗：${p.reapMinutes != null ? `${p.reapMinutes} 分钟` : "（平台默认）"}`);
  };
  if (Object.keys(patch).length > 0) {
    show((await call("PUT", patch)).prefs);
    console.log("已保存。");
  } else {
    show((await call("GET")).prefs);
  }
}

export { parseArgs, extractPackId, targetDir, SKILLS_SUBDIR, MCP_TARGETS };

// Both sides go through realpath: npm/npx run the bin through a symlink in
// node_modules/.bin, so argv[1] is the link while import.meta.url is already
// the real file — comparing them raw made the whole CLI exit silently (0.2.0).
const realOrSelf = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};
// ── update (add-facet-cli-update, F2.3): re-fetch the latest snapshot ─────────
// No-arg refreshes every recorded install; a pack reference narrows to it
// (--target further). Same write path as install — an update's bytes are a
// fresh install's bytes; zero subscription semantics by construction.
async function update(opts) {
  const base = String(opts.base).replace(/\/+$/, "");
  const installs = await loadInstalled();
  const wantRef = opts.packRef ? extractPackId(opts.packRef) : null;
  const targets = installs.filter(
    (r) => (!wantRef || r.packId === wantRef) && (!opts.targetExplicit || r.target === opts.target),
  );
  if (installs.length === 0) {
    console.log("本地无安装记录——facet install 会落记录（旧安装重跑一次 install 即入册）。");
    return;
  }
  if (wantRef && targets.length === 0) {
    console.log(`记录里没有 ${wantRef}${opts.targetExplicit ? `（target=${opts.target}）` : ""} 的安装——先 facet install。`);
    return;
  }
  let upgraded = 0;
  for (const rec of targets) {
    const label = `${rec.name ?? rec.packId}（${rec.target}${rec.scope === "项目级" ? " · 项目级" : ""}）`;
    const detail = await fetchJson(`${base}/api/packs/${encodeURIComponent(rec.packId)}`).catch(() => null);
    if (!detail?.id) {
      console.log(`✗ ${label} — 功能集已不可解析（下架/私有/网络），记录保持 v${rec.version}`);
      continue;
    }
    if (detail.version === rec.version) {
      console.log(`✓ ${label} 已最新 v${rec.version}`);
      continue;
    }
    const root = rec.scope === "项目级" && rec.project ? rec.project : HOME();
    const dir = path.join(root, SKILLS_SUBDIR[rec.target], "skills");
    console.log(`↻ ${label} v${rec.version} → v${detail.version}（重取快照）`);
    await writeSkillSnapshot(base, detail, dir);
    await recordInstall({ ...rec, version: detail.version, installedAt: new Date().toISOString() });
    upgraded += 1;
  }
  console.log(upgraded > 0 ? `完成：${upgraded} 笔更新（无订阅副作用——快照模型）。` : "没有需要更新的安装。");
}

// ── publish (add-facet-publish-bridge, F3.2): return a pack to the official market ──
// The cross-instance transport is THIS process: read a local manifest file or
// pull the stored manifest from the source instance's public detail, then push
// it through the market's own publish route. Auth is the market's device-
// pairing surface — pair once via a bind code minted from the author's web
// session, silently re-login every run (the token never rests on disk; only
// the device identity and the source→official id map do). Every gate —
// creators group, manifest validation, tool declarations, author rate limit —
// stays on the market; this side only transports and reports verdicts.

function publishKeypairPath() {
  return process.env.FACET_PUBLISH_KEY_PATH || path.join(HOME(), ".facet", "publish-key.json");
}
function publishIdentityPath() {
  return process.env.FACET_PUBLISH_IDENTITY_PATH || path.join(HOME(), ".facet", "publish-identity.json");
}
function publishMapPath() {
  return process.env.FACET_PUBLISH_MAP_PATH || path.join(HOME(), ".facet", "publish-map.json");
}

// One device identity for every market: the keypair never leaves this machine
// (PEM at 0600); each market's binding store holds only the public half. The
// pubkey wire format is app-auth's: base64url of the raw 32-byte Ed25519 key
// (JWK `x`), so it round-trips the server's KeyObject wrap exactly.
async function ensurePublishDevice() {
  try {
    const doc = JSON.parse(await readFile(publishKeypairPath(), "utf8"));
    if (doc?.deviceId && doc?.privateKeyPem && doc?.publicKey) return doc;
  } catch { /* absent or unreadable — mint below */ }
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const doc = {
    deviceId: crypto.randomBytes(12).toString("base64url"),
    publicKey: publicKey.export({ format: "jwk" }).x,
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
    createdAt: new Date().toISOString(),
  };
  await mkdir(path.dirname(publishKeypairPath()), { recursive: true });
  await writeFile(publishKeypairPath(), JSON.stringify(doc, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  await chmod(publishKeypairPath(), 0o600);
  return doc;
}

async function loadPublishIdentity(market) {
  try {
    const doc = JSON.parse(await readFile(publishIdentityPath(), "utf8"));
    return doc?.markets?.[market] ?? null;
  } catch {
    return null;
  }
}

async function savePublishIdentity(market, entry) {
  let doc = {};
  try {
    doc = JSON.parse(await readFile(publishIdentityPath(), "utf8")) ?? {};
  } catch { /* first write */ }
  doc.markets ??= {};
  doc.markets[market] = entry;
  await mkdir(path.dirname(publishIdentityPath()), { recursive: true });
  await writeFile(publishIdentityPath(), JSON.stringify(doc, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
}

const publishMapKey = (market, sourceId) => `${market}|${sourceId}`;

async function loadPublishMap() {
  try {
    return (JSON.parse(await readFile(publishMapPath(), "utf8")) ?? {}).maps ?? {};
  } catch {
    return {};
  }
}

async function savePublishMapEntry(market, sourceId, officialId) {
  let doc = {};
  try {
    doc = JSON.parse(await readFile(publishMapPath(), "utf8")) ?? {};
  } catch { /* first write */ }
  doc.maps ??= {};
  doc.maps[publishMapKey(market, sourceId)] = officialId;
  await mkdir(path.dirname(publishMapPath()), { recursive: true });
  await writeFile(publishMapPath(), JSON.stringify(doc, null, 2) + "\n", "utf8");
}

// Always-fresh credentials: silent login (single-use challenge + Ed25519
// signature) each run; pair via bind code only when the market says the device
// is unknown or was revoked. The returned token lives in this invocation only.
async function publishToken(market, opts, device) {
  const identity = await loadPublishIdentity(market);
  if (identity) {
    const ch = await fetch(`${market}/api/app/challenge`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ deviceId: device.deviceId }),
    });
    const chDoc = await ch.json().catch(() => ({}));
    if (ch.ok && chDoc.nonce) {
      const signature = crypto
        .sign(null, Buffer.from(`${device.deviceId}:${chDoc.nonce}`, "utf8"), crypto.createPrivateKey(device.privateKeyPem))
        .toString("base64url");
      const lg = await fetch(`${market}/api/app/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ deviceId: device.deviceId, nonce: chDoc.nonce, signature }),
      });
      const lgDoc = await lg.json().catch(() => ({}));
      if (lg.ok && lgDoc.token) return { token: lgDoc.token, email: lgDoc.email };
      throw new Error(`静默登录失败（HTTP ${lg.status} ${lgDoc.error || ""}）`);
    }
    // binding_required (unknown/revoked device) falls through to pairing;
    // anything else means the market did not offer the door at all.
    if (ch.status !== 401 || chDoc.error !== "binding_required") {
      throw new Error(`市场 challenge 不可用（HTTP ${ch.status} ${chDoc.error || ""}）——该部署可能未开设备配对`);
    }
  }

  console.log(`首次配对 ${market}（或既有配对已被吊销）：`);
  console.log(`  打开并登录创作者账号，取 6 位绑定码：${market}/api/mp/bindcode`);
  if (!opts.noOpen && process.platform !== "win32") {
    const { execFile } = await import("node:child_process");
    const open = process.platform === "darwin" ? "open" : "xdg-open";
    execFile(open, [`${market}/api/mp/bindcode`], () => {}); // best-effort; the URL is printed regardless
  }
  const code = await readKeyFromStdin("输入 6 位绑定码（回车确认）：");
  const pr = await fetch(`${market}/api/app/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ code, deviceId: device.deviceId, pubkey: device.publicKey, label: "facet-cli publish" }),
  });
  const pd = await pr.json().catch(() => ({}));
  if (!pr.ok) throw new Error(`配对失败（HTTP ${pr.status}）${pd.error ? `：${pd.error}` : ""}`);
  await savePublishIdentity(market, { email: pd.email, pairedAt: new Date().toISOString() });
  console.log(`✓ 已配对为 ${pd.email}（设备身份存 ${publishKeypairPath()}，0600）`);
  return { token: pd.token, email: pd.email };
}

async function publishRun(opts) {
  const market = String(opts.market || DEFAULT_BASE).replace(/\/+$/, "");
  const ref = String(opts.packRef || "").trim();
  if (!ref) throw new Error("缺少发布载荷——给 manifest 文件路径，或功集 id 配 --from <源实例>");

  let manifest;
  let sourceId = null;
  const asFile = path.resolve(ref);
  const fileExists = await stat(asFile).then(() => true).catch(() => false);
  if (fileExists) {
    try {
      manifest = JSON.parse(await readFile(asFile, "utf8"));
    } catch (e) {
      throw new Error(`清单文件不是合法 JSON：${e.message}`);
    }
    console.log(`载荷：本地清单 ${asFile}`);
  } else {
    let fromBase = opts.from ? String(opts.from).replace(/\/+$/, "") : null;
    if (!fromBase) {
      try {
        fromBase = new URL(ref).origin; // a detail-page URL names its own source
      } catch { /* bare id — --from is required */ }
    }
    if (!fromBase) throw new Error("跨实例发布需要 --from <源实例地址>（或直接给功集详情页 URL）");
    sourceId = extractPackId(ref);
    const detail = await fetchJson(`${fromBase}/api/packs/${encodeURIComponent(sourceId)}`).catch(() => null);
    if (!detail?.manifest) {
      throw new Error(`源实例 ${fromBase} 上找不到公开功集 ${sourceId}——私有/下架包不可搬运（先转公开，或改用本地清单文件）`);
    }
    manifest = detail.manifest;
    console.log(`载荷：${fromBase} 的 ${detail.name ?? sourceId} v${detail.version}（存储 manifest，含技能内容）`);
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("载荷不是 manifest 对象——官方侧校验是唯一权威，但基本形状须成立");
  }

  const device = await ensurePublishDevice();
  const { token, email } = await publishToken(market, opts, device);

  let packId = typeof opts.packId === "string" && opts.packId.trim() ? opts.packId.trim() : null;
  if (!packId && sourceId && !opts.fresh) {
    const mapped = (await loadPublishMap())[publishMapKey(market, sourceId)];
    if (mapped) {
      packId = mapped;
      console.log(`沿用 id 映射 ${sourceId} → ${packId}（续推新版本；--new 强制发新包）`);
    }
  }

  const r = await fetch(`${market}/api/packs`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ packId, manifest }),
  });
  const doc = await r.json().catch(() => ({}));
  if (!r.ok) {
    const errors = Array.isArray(doc?.errors) ? doc.errors.map((e) => e?.error ?? String(e)).join("；") : "";
    if (r.status === 403 && doc?.error === "Creator group required") {
      throw new Error(`官方市场拒绝：配对账号 ${email} 不在创作者组——用创作者组成员的会话铸造绑定码，重新配对`);
    }
    if (r.status === 404) throw new Error(`官方包 ${packId} 不存在——核对 --pack-id，或用 --new 发新包`);
    if (r.status === 403) {
      throw new Error(`官方市场拒绝（403）：${doc?.error || ""}${packId ? `——${packId} 的作者不是 ${email}，新版本须由原作者发布` : ""}`);
    }
    throw new Error(`发布失败 HTTP ${r.status}${doc?.error ? `：${doc.error}` : ""}${errors ? `\n  ${errors}` : ""}`);
  }
  console.log(`✓ 已发布到官方市场：${doc.id} v${doc.version}（作者 ${email}）`);
  console.log(`  ${market}/#/packs`);
  if (sourceId && doc.id) {
    await savePublishMapEntry(market, sourceId, doc.id);
    console.log(
      packId
        ? `  版本已续推（${sourceId} → ${doc.id} 映射不变）`
        : `  已记 id 映射 ${sourceId} → ${doc.id}：下次同源发布会自动续推新版本`,
    );
  }
}

const isMain =
  process.argv[1] &&
  realOrSelf(fileURLToPath(import.meta.url)) === realOrSelf(path.resolve(process.argv[1]));
if (isMain) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.command === "help" || opts.command === null) console.log(USAGE);
    else if (opts.command === "version") console.log(VERSION);
    else if (opts.command === "install") await install(opts);
    else if (opts.command === "connect") await connectRun(opts);
    else if (opts.command === "prefs") await prefs(opts);
    else if (opts.command === "update") await update(opts);
    else if (opts.command === "publish") await publishRun(opts);
    else {
      console.error(`未知命令：${opts.command}\n\n${USAGE}`);
      process.exit(2);
    }
  } catch (e) {
    console.error(`facet: ${e.message}`);
    process.exit(1);
  }
}