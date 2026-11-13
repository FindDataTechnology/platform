#!/usr/bin/env node
// ── @finddatatechnology/facet — 谦面 CLI (add-facet-platform S3; add-ecosystem-bridge) ──
//
// Installs a published pack's skills from the facet marketplace into editor
// targets (Claude Code, Cursor, ZCode, Codex, Gemini CLI, WorkBuddy). Marketplace fetches
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
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LANE, LANE_LABEL, findCapability, selectLane } from "./mcp-auth-capability.js";

// Version lives in package.json only — a hardcoded copy shipped 0.1.0 for
// three releases (caught by `npx @finddatatechnology/facet@0.1.2 --version`).
const VERSION = JSON.parse(
  await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "package.json"), "utf8"),
).version;
const DEFAULT_BASE = process.env.FACET_BASE || "https://facet.finddatatech.cloud";
const DEFAULT_REGISTRY = process.env.FACET_REGISTRY || "https://mcp.finddatatech.cloud";
// Keyless MCP lane (add-workbuddy-mcp-lane, 2026-10-30): a pre-registered
// PUBLIC client on our Logto tenant. Server side is fully live and was
// verified end-to-end with a headless PKCE round-trip in the SDK's exact
// semantics: static client_id (no DCR) → authorize → token (aud = the
// gateway origin) → gateway 200 → 160+ tools, zero pasted keys. The tenant's
// custom-JWT script injects roles/email for gateway-audience tokens, and the
// auth-server accepts the gateway's own advertised resource URL as audience
// (fork patch c216f479).
// CLIENT-side caveat, established by reading the shipped app.asar (5.9.3):
// the static oauth.clientId is honored on the connector/marketplace-template
// paths (toConnectorMcpItem/toDependencyItem read descriptor.oauth.clientId),
// but the USER-level mcp.json loader is not there yet — parseMcpServerEntry
// keeps only transport/trust fields and UserMcpProvider's auth mapper passes
// provider:{name} only, so a file entry falls back to DCR (which our Logto
// does not offer). The entry written here matches the client's own connector
// shape, so it is the forward-compatible form; key-based connect remains
// the working path on 5.9.3. App id overridable for non-prod registries.
const DEFAULT_OAUTH_CLIENT_ID = process.env.FACET_OAUTH_CLIENT_ID || "tvmzkpz3ld5kqlmse5se9";
const DEFAULT_OAUTH_SCOPE = "openid gateway:access offline_access";

const USAGE = `facet v${VERSION} — 谦面智能体安装器 / 萬星调用者偏好

用法：
  facet install <packRef> [--target CC|cursor|zcode|codex|gemini-cli|workbuddy]
                          [--project <dir>] [--base <url>] [--registry <url>]
                          [--write-mcp|--no-write-mcp] [--oauth [--oauth-client <id>]]
  facet update [packRef] [--target <t>] [--base <url>]   # 重取最新版快照（无订阅副作用）
  facet list [--base <url>] [--line <l>] [--limit <n>] [--json]     # 列目录（不知 id 时用）
  facet search <关键词> [--base <url>] [--line <l>] [--limit <n>] [--json]
  facet auth [packRef] [--target <t>] [--project <dir>] [--write-mcp]
                          [--server <name>] [--status] [--refresh] [--no-open]
  facet connect [--key wgk-…] [--registry <url>] [--clear] [--show] [--no-open]
  facet prefs <agent-slug> [--key sk-…] [--wanxing <url>]
                          [--set-callback <url> <secret>] [--set-reap <minutes>]
                          [--clear callback|reap|all] [--show]
  facet publish <manifest.json | packRef> [--from <自部署实例>]
                          [--market <url>] [--pack-id <官方id>] [--new] [--no-open]
  facet help | --version

  <packRef>  智能体 id（市场详情页可见）或含 id 的 URL
  --target   安装目标（默认 CC）：写技能到目标编辑器的技能目录
  --project  项目级安装：写进 <dir>/<dotdir>/skills/ 而非用户级目录
  --base     谦面地址（默认 ${DEFAULT_BASE}）
  --registry 注册处地址——打印 MCP 端点；connect 用它验活与铸造
  --oauth    workbuddy 免键(OAuth)条目：mcp.json 写 oauth.clientId（静态客户端，与
             客户端连接器模板同形）。服务端侧已端到端实证；5.9.3 客户端的用户文件加载
             器暂不消费该块——今日真连接用贴键（connect + --write-mcp）。暂仅 workbuddy
  --oauth-client 覆盖免键条目的 OAuth client_id（默认 facet-mcp-keyless 应用）

  auth 子命令（免键连接，add-universal-keyless-mcp-auth）：按能力表选道—
  L1 原生 OAuth（写静态 client_id，客户端自己授权，零凭据落盘）/
  L2 代持令牌（CLI 授权后写短 Bearer，兼容所有客户端）/
  L3 调用键。--status 看令牌余期与可续期性；--refresh 静默续期。

  connect 子命令（ecosystem-bridge）：铸取并验活 wgk- 调用键，存本地后
  install 可写各编辑器的 MCP 连接配置。--key 免交互粘贴；缺省打开铸造页
  后从 stdin 读入。--show 看已存状态；--clear 清除。

  prefs 子命令（萬星调用者偏好，调用键即凭证）：
  <agent-slug>   目录页的 agent 标识（如 packs-xxxx-agent）
  --key          sub2api 调用键（sk-…）；缺省读环境变量 FACET_CALLER_KEY
  --wanxing      萬星门面地址（默认 https://wanxing.finddatatech.cloud）
  --set-callback 回合完成回调：URL 与 HMAC 签名密钥（两者同设同清）
  --set-reap     上下文收割窗（分钟）；--clear 显式清除即回落平台默认

目标布局（技能同为 <dotdir>/skills/<skill>/SKILL.md）：
  CC ~/.claude/skills/…   cursor  ~/.cursor/skills/…
  zcode       ~/.zcode/skills/…    codex   ~/.codex/skills/…
  gemini-cli  ~/.gemini/skills/…   workbuddy  ~/.workbuddy/skills/…
  （项目级均为 <dir>/<dotdir>/skills/…；workbuddy 的 MCP 配置同为 .workbuddy 下：
    用户级 ~/.workbuddy/mcp.json、项目级 <dir>/.workbuddy/mcp.json）

  update 子命令（F2.3）：按 ~/.facet/installed.json 的记录重取各包最新版——已最新
  即 no-op，升级打印 v旧 → v新；零订阅副作用（快照模型）。来源市场随记录走：
  装自哪个谦面就从哪个谦面更新（--base 可覆盖；老记录无 base 才回落官方并明说）。

  list / search 子命令（fix-supply-machine-faces 5.x）：不知道 id 时先看目录。
  读的是 install 用的同一个 /api/packs，打印的 id 可直接喂给 install。
  --line 按产品线过滤（lex / wire …），--limit 最多 100，--json 出原始行。

  publish 子命令（F3.2 回流桥）：把智能体 manifest 发到官方市场——本地清单文件，
  或从自部署实例的公开详情拉取（--from <base>，或直接给智能体页 URL）。首次运行
  走配对：打开 ${DEFAULT_BASE}/api/mp/bindcode（登录创作者账号）取 6 位绑定码，
  输回终端；之后每次静默续登。token 不落盘；首发记 源id→官方id 映射，同源续推
  自动出新版本（--new 强制新包；--pack-id 手工指定官方 id）。
  creators 门/清单校验/工具声明门/限流 全在官方侧判定，本 CLI 只搬运。

说明：安装即版本快照（不产生订阅）；MCP 需 registry 账号凭据，端点仅打印。`;

function parseArgs(argv) {
  const out = { command: null, packRef: null, target: "claude-code", project: null, base: DEFAULT_BASE, baseExplicit: false, registry: DEFAULT_REGISTRY, market: DEFAULT_BASE, from: null, packId: null, key: null, wanxing: process.env.FACET_WANXING || "https://wanxing.finddatatech.cloud", setCallback: null, setReap: undefined, clear: null };
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
    else if (a === "--base") { out.base = rest.shift(); out.baseExplicit = true; }
    else if (a === "--registry") out.registry = rest.shift();
    else if (a === "--key") out.key = rest.shift();
    else if (a === "--wanxing") out.wanxing = rest.shift();
    else if (a === "--from") out.from = rest.shift();
    else if (a === "--market") out.market = rest.shift();
    else if (a === "--pack-id") out.packId = rest.shift();
    else if (a === "--limit") out.limit = rest.shift();
    else if (a === "--line") out.line = rest.shift();
    else if (a === "--species") out.species = rest.shift();
    else if (a === "--json") out.json = true;
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
    else if (a === "--oauth") out.oauth = true;
    else if (a === "--oauth-client") out.oauthClient = rest.shift();
    else if (a === "--refresh") out.refresh = true;
    else if (a === "--status") out.status = true;
    else if (a === "--server") out.server = rest.shift();
    else if (a === "--auth-url") out.authUrl = rest.shift();
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
  // WorkBuddy's user-level skills directory is `.workbuddy/skills` — verified on
  // a real install (2026-10-30): a probe SKILL.md placed there appeared in the
  // client's own `.skill-list-cache.json` with `source: "userSettings"`, while
  // the same probe under `~/.codebuddy/skills` was NOT picked up. The client's
  // code agrees (`createSkillsService`: join(resolveWorkbuddyConfigDir(), "skills")).
  // The docs' Project page mentions `.codebuddy/skills/` for repository-scoped
  // code-development config; that is a DIFFERENT surface from the user-level
  // skill list this target writes, and it is not what the client scans for
  // user skills. MCP config lives apart too — see MCP_TARGETS below.
  workbuddy: ".workbuddy",
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
  // WorkBuddy keeps both skills and MCP under its own dotdir: skills at
  // ~/.workbuddy/skills (see SKILLS_SUBDIR) and MCP at
  // ~/.workbuddy/mcp.json (its MCP guide; client code getMcpConfigPath() =
  // <configDir>/mcp.json). Same root, not two — verified on a real install
  // 2026-10-30, which also disproved the earlier ".codebuddy" reading.
  // Remote transport is declared explicitly (type "http"). TWO connection
  // forms:
  //  - entry(): header-keyed (wgk- caller key) — the working path on 5.9.3,
  //    also what headless/CI callers use.
  //  - entryOauth(): keyless — the client's own connector-template shape
  //    (`oauth.clientId` short-circuits DCR on the connector/plugin paths,
  //    per the shipped app.asar). The USER-level mcp.json loader does not yet
  //    consume this block on 5.9.3 (parseMcpServerEntry drops it), so the
  //    written entry is the forward-compatible form; see the keyless-lane
  //    note above DEFAULT_OAUTH_CLIENT_ID. Tokens would live in the CLIENT's
  //    encrypted store, never in this file.
  workbuddy: {
    userFile: () => path.join(HOME(), ".workbuddy", "mcp.json"),
    projectFile: (dir) => path.join(dir, ".workbuddy", "mcp.json"),
    json: { container: (doc) => doc, key: "mcpServers" },
    entry: (url, headers) => ({ type: "http", url, headers }),
    entryOauth: (url, clientId, scope) => ({
      type: "http",
      url,
      oauth: { name: "facet", clientId, scope },
    }),
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
// the list of files written (for the CLI's report). Project-level writes go
// to whichever targets declare a projectFile (CC: <dir>/.mcp.json,
// WorkBuddy: <dir>/.workbuddy/mcp.json); the rest are user-level only.
async function writeMcpConfig(target, { registry, servers, key, project, oauth }) {
  const t = MCP_TARGETS[target];
  if (!t) throw new Error(`目标「${target}」没有 MCP 配置约定`);
  if (oauth && !t.entryOauth) {
    throw new Error(`目标「${target}」未证实免键(OAuth)连接面——免键车道目前仅 workbuddy；其余目标用 wgk- 调用键（facet connect 铸键）。`);
  }
  const files = [];
  for (const s of servers) {
    const url = `${registry}/${s.registryName}/mcp`;
    if (oauth) {
      const clientId = typeof oauth === "string" ? oauth : DEFAULT_OAUTH_CLIENT_ID;
      const entry = t.entryOauth(url, clientId, DEFAULT_OAUTH_SCOPE);
      const file = project && t.projectFile ? t.projectFile(project) : t.userFile();
      files.push(await upsertJsonMcp(file, t.json.container, t.json.key, s.registryName, entry));
      continue;
    }
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
    // Paginated read (registry-list-completeness): one page is not the full
    // set. Best-effort stays best-effort — any failure here must not fail
    // the connect, and a walk that cannot complete still shows what it got.
    const PAGE = 500;
    const names = [];
    let offset = 0;
    for (let page = 0; page < 100; page += 1) {
      const r = await fetch(`${registry}/api/servers?limit=${PAGE}&offset=${offset}`, { headers });
      if (!r.ok) break;
      const doc = await r.json();
      const rows = Array.isArray(doc) ? doc : doc?.servers ?? [];
      names.push(...rows.map((s) => s?.name ?? s?.server?.name ?? s?.id).filter(Boolean));
      const total = Number.isFinite(Number(doc?.total_count)) ? Number(doc.total_count) : null;
      const hasNext =
        typeof doc?.has_next === "boolean"
          ? doc.has_next
          : total !== null
            ? names.length < total
            : rows.length >= PAGE;
      if (!hasNext || rows.length === 0) break;
      offset += rows.length;
    }
    if (names.length) servers = names;
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

// ── auth: 免键连接（add-universal-keyless-mcp-auth D1/D2） ───────────────────
// Three lanes, chosen by the capability table rather than by hope:
//   L1 原生 OAuth   — write the static client id; the client authorizes.
//   L2 代持令牌     — we authorize, then write a SHORT access token into the
//                     target's static Authorization header. Needs no client
//                     OAuth support, so it covers every client that honours
//                     static headers (today: all six targets).
//   L3 调用键       — device-flow wgk-, unchanged.
// The L2 refresh token is kept in ~/.facet/oauth.json (0600) and is NEVER
// written into a client config — a client config gets an access token only.
const DEFAULT_AUTH_URL = process.env.FACET_AUTH_URL || "https://auth.finddatatech.cloud/oidc";

function oauthTokenPath() {
  return path.join(path.dirname(credentialsPath()), "oauth.json");
}

export async function loadOAuthToken() {
  try {
    const doc = JSON.parse(await readFile(oauthTokenPath(), "utf8"));
    if (typeof doc?.access_token === "string" && doc.access_token) return doc;
    return null;
  } catch {
    return null;
  }
}

export async function saveOAuthToken(doc) {
  const file = oauthTokenPath();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(doc, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  await chmod(file, 0o600); // mode applies at creation only; enforce on rewrite
}

export async function clearOAuthToken() {
  await rm(oauthTokenPath(), { force: true });
}

const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function decodeJwtClaims(token) {
  try {
    const part = String(token).split(".")[1];
    if (!part) return null;
    return JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch {
    return null;
  }
}

/** Expiry/claims view of a stored token — what --status prints. */
export function describeToken(doc) {
  const claims = doc?.access_token ? decodeJwtClaims(doc.access_token) : null;
  let expiresAt = null;
  if (claims?.exp) expiresAt = new Date(claims.exp * 1000);
  else if (doc?.obtained_at && doc?.expires_in) expiresAt = new Date(doc.obtained_at + doc.expires_in * 1000);
  const expired = expiresAt ? expiresAt.getTime() <= Date.now() : false;
  return {
    claims,
    expiresAt,
    expired,
    minutesLeft: expiresAt ? Math.round((expiresAt.getTime() - Date.now()) / 60000) : null,
    renewable: typeof doc?.refresh_token === "string" && doc.refresh_token.length > 0,
    audience: claims?.aud ?? null,
    username: claims?.username ?? null,
    roles: Array.isArray(claims?.roles) ? claims.roles : [],
  };
}

// Standard authorization-code + PKCE, against a pre-registered static client.
// The callback is a random-port loopback (RFC 8252 port-agnostic matching), so
// the same registered URI works every run. `prompt=consent` is deliberate: our
// Logto only issues a refresh token when consent is forced (D4).
export async function pkceAuthorize({ authBase, clientId, scope, resource, noOpen = false, onAuthorizeUrl = null }) {
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const state = crypto.randomBytes(8).toString("hex");

  const { codeP, redirectUri } = await new Promise((resolve) => {
    let settle;
    const codeP = new Promise((res, rej) => { settle = { res, rej }; });
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, "http://127.0.0.1");
      if (u.pathname !== "/oauth/callback") { res.writeHead(404).end(); return; }
      const err = u.searchParams.get("error");
      const code = u.searchParams.get("code");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<p>${err ? `授权失败：${err}` : "授权完成，可以关闭此页面。"}</p>`);
      if (err) settle.rej(new Error(`授权被拒：${err}`));
      else if (code) settle.res(code);
      server.close();
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ codeP, redirectUri: `http://127.0.0.1:${server.address().port}/oauth/callback` });
    });
  });

  const url = new URL(`${authBase}/auth`);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", scope);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "consent");
  if (resource) url.searchParams.set("resource", resource);

  console.log(`\n授权端点：${url.origin}${url.pathname}　回调：${redirectUri}`);
  if (onAuthorizeUrl) {
    // Test seam: the caller drives the authorization URL itself (no browser).
    Promise.resolve(onAuthorizeUrl(url.toString())).catch(() => {});
  } else if (noOpen) {
    console.log(`请手动打开下面的地址完成授权：\n${url.toString()}\n`);
  } else {
    const { execFile } = await import("node:child_process");
    const openCmd = process.platform === "darwin" ? "open" : "xdg-open";
    execFile(openCmd, [url.toString()], () => {}); // best-effort; the URL is printed above
    console.log("已在浏览器打开授权页；完成后回到终端。");
  }

  const code = await codeP;
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  if (resource) form.set("resource", resource);
  const r = await fetch(`${authBase}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const doc = await r.json().catch(() => ({}));
  if (!r.ok || !doc.access_token) {
    throw new Error(`换取令牌失败（HTTP ${r.status}）${doc?.error ? `：${doc.error}` : ""}`);
  }
  return { ...doc, obtained_at: Date.now(), redirect_uri: redirectUri, client_id: clientId, resource: resource || null, scope };
}

// Silent renewal: refresh hits the token endpoint only, no browser.
//
// Two live constraints, both measured against production Logto:
//   1. `resource` MUST be replayed. Without it the response is a client-bound
//      opaque token with no `aud` — it would not authenticate at the gateway.
//   2. `scope` MUST NOT be replayed. Our Logto rejects any refresh that names a
//      scope the refresh token does not carry (`invalid_scope: refresh token
//      missing requested scope`) — and it never carries `gateway:access`, since
//      that is a resource scope granted at authorization time, not an
//      refreshable OIDC scope.
export async function refreshOAuthToken({ authBase, clientId }) {
  const current = await loadOAuthToken();
  if (!current?.refresh_token) return null;
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: current.refresh_token,
  });
  if (current.resource) form.set("resource", current.resource);
  const r = await fetch(`${authBase}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const doc = await r.json().catch(() => ({}));
  if (!r.ok || !doc.access_token) return null;
  const next = { ...current, ...doc, obtained_at: Date.now() };
  if (!doc.refresh_token) next.refresh_token = current.refresh_token; // rotation may omit on reuse
  await saveOAuthToken(next);
  return next;
}

function printTokenStatus(doc, { target } = {}) {
  if (!doc) {
    console.log("\n免键令牌：未登录（先跑 facet auth <packRef> --target <t> --write-mcp）");
    return;
  }
  const s = describeToken(doc);
  console.log("\n免键令牌：");
  console.log(`  账号    ${s.username ?? "（令牌无 username 声明）"}`);
  console.log(`  受众    ${s.audience ?? "（无 aud）"}`);
  console.log(`  角色    ${s.roles.length ? s.roles.join("、") : "（无）"}`);
  console.log(
    `  有效期  ${s.expiresAt ? `${s.expiresAt.toLocaleString()}（${s.expired ? `已过期 ${Math.abs(s.minutesLeft)} 分钟` : `剩 ${s.minutesLeft} 分钟`}）` : "未知"}`,
  );
  console.log(`  可续期  ${s.renewable ? "是（有 refresh_token，--refresh 静默续期）" : "否（无 refresh_token——需重跑授权）"}`);
  if (target) {
    const rec = findCapability(target);
    if (rec) {
      console.log(`  ${target} 能力表：原生 OAuth ${rec.oauthClientId === true ? "✅" : rec.oauthClientId === false ? "❌" : "未验"}　静态头 ${rec.headerStatic ? "✅" : "❌"}　证据 ${rec.evidence.build}${rec.stale ? "（stale）" : ""}`);
    }
  }
}

// 401 三分类（spec: Refusal is classified）。The gateway's refusals differ in
// text and status; guessing "bad token" for all three is what makes a group
// problem look like a credential problem.
export function classifyRefusal(status, body = "") {
  const text = String(body).toLowerCase();
  if (status === 401) {
    if (/expired|invalid_token|jwt expired/.test(text)) return { kind: "expired", advice: "令牌过期或被吊销——跑 facet auth --refresh（无 refresh_token 时重跑授权）" };
    return { kind: "expired", advice: "凭据未被接受——跑 facet auth --refresh；仍失败请核对是否用了别的部署" };
  }
  if (status === 403) {
    if (/group|role|scope|forbidden/.test(text)) return { kind: "group", advice: "账号不持该 server 要求的组/角色——到注册处申请组，或换账号授权" };
    return { kind: "group", advice: "调用被拒（403）——多为组/角色不匹配" };
  }
  if (status === 405) return { kind: "disabled", advice: "该 server 在你的组里已停用（405），属注册处侧判定" };
  return { kind: "other", advice: `未分类拒绝（HTTP ${status}）` };
}

/**
 * `facet auth` — pick a lane, establish it, write the target's config.
 *   facet auth <packRef> --target workbuddy --write-mcp   # authorize + write
 *   facet auth --status                                   # token + capability view
 *   facet auth --refresh                                  # silent renewal
 */
// Rewrite brokered tokens already sitting in client configs.
//
// Renewal is only half the job: the config still holds the OLD bearer string, so
// a refreshed token that is never written back leaves the client failing while
// the CLI reports success. Found on a real machine (the config kept a 58-minute
// token while the freshly renewed one sat in ~/.facet/oauth.json).
//
// Which entries to touch is decided by AUDIENCE, not by string equality. Exact
// matching looked safer but is wrong in practice: a config written before this
// fix holds a token that was never rotated again, so it will never equal the
// current stored token and would be stale forever — the exact case we must heal.
// So: decode each bearer, rewrite it only when it is one of OUR tokens (its `aud`
// equals the new token's `aud`). Caller keys (`wgk-…`) do not decode as JWTs and
// another deployment's JWT carries a different `aud`; both are left untouched
// instead of being silently hijacked.
async function rewriteBrokeredTokens({ newToken, project = null, targets = null }) {
  const newAud = decodeJwtClaims(newToken)?.aud ?? null;
  if (!newAud) return []; // can't identify our own tokens → refuse to guess
  const rewritten = [];
  const list = targets ?? Object.keys(MCP_TARGETS);
  for (const target of list) {
    const t = MCP_TARGETS[target];
    if (!t || t.toml) continue; // TOML targets carry [mcp_servers.*]; handled separately if ever used
    const candidates = [];
    if (t.userFile) candidates.push(t.userFile());
    if (project && t.projectFile) candidates.push(t.projectFile(project));
    for (const file of candidates) {
      const doc = await readJsonFile(file);
      const box = t.json.container(doc)?.[t.json.key];
      if (!box || typeof box !== "object") continue;
      let touched = false;
      for (const entry of Object.values(box)) {
        const h = entry?.headers?.Authorization;
        if (typeof h !== "string" || !h.startsWith("Bearer ")) continue;
        const bearer = h.slice("Bearer ".length).trim();
        if (bearer === newToken) continue; // already current
        const claims = decodeJwtClaims(bearer);
        if (!claims || claims.aud !== newAud) continue; // not ours (key, other issuer)
        entry.headers.Authorization = `Bearer ${newToken}`;
        touched = true;
      }
      if (touched) {
        await writeFile(file, JSON.stringify(doc, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
        await chmod(file, 0o600).catch(() => {});
        rewritten.push(file);
      }
    }
  }
  return rewritten;
}

export async function authRun(opts) {
  const authBase = opts.authUrl || DEFAULT_AUTH_URL;
  const clientId = opts.oauthClient || DEFAULT_OAUTH_CLIENT_ID;

  if (opts.show || opts.status) {
    printTokenStatus(await loadOAuthToken(), { target: opts.target });
    return;
  }

  if (opts.refresh) {
    const refreshed = await refreshOAuthToken({ authBase, clientId });
    if (refreshed) {
      const s = describeToken(refreshed);
      console.log(`✓ 已静默续期（剩 ${s.minutesLeft} 分钟）`);
      // Write the renewed token back, or the client keeps the expired one.
      const files = await rewriteBrokeredTokens({
        newToken: refreshed.access_token,
        project: opts.project,
      });
      if (files.length > 0) {
        console.log("  已原地改写配置：");
        for (const f of files) console.log(`    ✓ ${f}`);
      } else {
        console.log("  没有配置携带旧令牌（未写过 MCP，或已换过账号）——无需改写。");
      }
      return;
    }
    console.log("无 refresh_token 或续期失败——需要重新授权一次：");
    const doc = await pkceAuthorize({
      authBase, clientId, scope: DEFAULT_OAUTH_SCOPE, resource: opts.registry, noOpen: opts.noOpen,
    });
    await saveOAuthToken(doc);
    const s = describeToken(doc);
    console.log(`✓ 已重新授权（剩 ${s.minutesLeft} 分钟${s.renewable ? "，可静默续期" : "，无 refresh_token"}）`);
    const files = await rewriteBrokeredTokens({ newToken: doc.access_token, project: opts.project });
    if (files.length > 0) {
      console.log("  已原地改写配置：");
      for (const f of files) console.log(`    ✓ ${f}`);
    }
    return;
  }

  // `--no-open` means "print the URL instead of launching a browser" — the
  // browser still exists, so it must NOT demote the lane. Only an explicit
  // headless environment (FACET_NO_BROWSER) does that.
  const hasBrowser = process.env.FACET_NO_BROWSER !== "1";
  const pick = selectLane(opts.target, { hasBrowser, hasCallerKey: Boolean(await loadCredentials()) });
  console.log(`\n选道：${LANE_LABEL[pick.lane]}`);
  console.log(`  理由：${pick.reason}`);

  if (pick.lane === LANE.KEY) {
    console.log("\n该客户端走调用键：facet connect 铸 wgk- 调用键，然后 install --write-mcp。");
    return;
  }

  if (pick.lane === LANE.NATIVE) {
    if (!opts.packRef) throw new Error("原生 OAuth 写入需要 <packRef>（从智能体详情页取 id）");
    const detail = await fetchJson(`${opts.base}/api/packs/${encodeURIComponent(extractPackId(opts.packRef))}`).catch((e) => {
      throw new Error(`取不到智能体 ${opts.packRef}：${e.message}`);
    });
    const servers = detail.manifest?.mcpServers ?? [];
    if (!servers.length) { console.log("\n该智能体没有 MCP 引用，无需连接。"); return; }
    const files = await writeMcpConfig(opts.target, {
      registry: opts.registry, servers, project: opts.project, oauth: clientId,
    });
    console.log("\nMCP 免键配置已写入（零凭据落盘）：");
    for (const f of [...new Set(files)]) console.log(`  ✓ ${f}`);
    return;
  }

  // L2 brokered token: authorize here, write a short access token.
  let doc = await loadOAuthToken();
  let s = doc ? describeToken(doc) : null;
  if (!doc || s.expired) {
    doc = await pkceAuthorize({
      authBase, clientId, scope: DEFAULT_OAUTH_SCOPE, resource: opts.registry, noOpen: opts.noOpen,
    });
    await saveOAuthToken(doc);
    s = describeToken(doc);
  }
  if (!s.renewable) {
    console.log("  注：本次授权未返回 refresh_token（静默续期不可用）——过期后需重跑一次授权；");
    console.log("      这是身份侧配置缺陷，已在 add-universal-keyless-mcp-auth 任务 3.1/3.2 跟踪。");
  }

  if (!opts.packRef && !opts.server) {
    console.log(`\n已取得令牌（剩 ${s.minutesLeft} 分钟，账号 ${s.username ?? "?"}）。`);
    console.log("要写入某个智能体的 MCP 配置：facet auth <packRef> --target <t> --write-mcp");
    console.log("要看状态：facet auth --status");
    return;
  }

  const servers = opts.server
    ? [{ registryName: opts.server }]
    : (await fetchJson(`${opts.base}/api/packs/${encodeURIComponent(extractPackId(opts.packRef))}`)).manifest?.mcpServers ?? [];
  if (!servers.length) { console.log("\n该智能体没有 MCP 引用，无需连接。"); return; }

  const shouldWrite = opts.writeMcp === true || (opts.noWriteMcp !== true && process.stdin.isTTY
    ? await (async () => {
        const rl = (await import("node:readline/promises")).createInterface({ input: process.stdin });
        try {
          const a = (await rl.question("写入 MCP 连接配置（Bearer 短令牌）？[y/N] ")).trim().toLowerCase();
          return a === "y" || a === "yes";
        } finally { rl.close(); }
      })()
    : false);
  if (!shouldWrite) {
    console.log("\n未写入。加 --write-mcp 启用写入。");
    for (const sv of servers) console.log(`  · ${sv.registryName} — ${opts.registry}/${sv.registryName}/mcp`);
    return;
  }

  const files = await writeMcpConfig(opts.target, {
    registry: opts.registry, servers, project: opts.project, key: doc.access_token,
  });
  console.log(`\nMCP 连接配置已写入（L2 代持令牌，剩 ${s.minutesLeft} 分钟）：`);
  for (const f of [...new Set(files)]) console.log(`  ✓ ${f}`);
  console.log("  续期：facet auth --refresh（有 refresh_token 时静默，否则一步重授权）");
  for (const sv of servers) {
    if (sv.requiredGroup) console.log(`  注：${sv.registryName} 需要组 ${sv.requiredGroup}——授权账号不持该角色时调用会被拒。`);
  }
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
  if (!packId) throw new Error("缺少智能体引用——用法见 facet help");

  const detail = await fetchJson(`${base}/api/packs/${encodeURIComponent(packId)}`).catch(() => null);
  if (!detail?.id) throw new Error(`智能体未找到：${packId}（检查 id，或该智能体为私有/已下架）`);

  const { dir, scope } = targetDir(opts);
  const version = detail.version;
  const skills = detail.manifest?.skills ?? [];

  console.log(`谦面 Facet · 安装 ${detail.name}（${detail.id}）v${version} → ${opts.target}（${scope}）`);
  if (skills.length === 0) console.log("  （该智能体没有技能条目）");
  await writeSkillSnapshot(base, detail, dir);
  // 记下装自哪个市场（fix-supply-machine-faces 6.1）：update 之前一律回落到
  // 官方基址，自部署者装完再更新会静默从别人的市场拉同一 id——装成不是自己
  // 发布的那份。base 随记录走，update 才能按记录解析。
  await recordInstall({ packId: detail.id, name: detail.name, target: opts.target, scope, project: opts.project ? path.resolve(opts.project) : null, version, base, installedAt: new Date().toISOString() });

  const mcp = detail.manifest?.mcpServers ?? [];
  if (mcp.length > 0) {
    if (opts.oauth) {
      // 免键车道（add-workbuddy-mcp-lane）：条目带 oauth.clientId（与客户端连接器模板
      // 同形）。服务端侧端到端实证就绪；WorkBuddy 5.9.3 的用户级 mcp.json 加载器暂不
      // 消费该块（见上注），写入的是前瞻形状——token 若被消费也只存客户端加密库。
      const shouldWrite = opts.writeMcp === true || (opts.noWriteMcp !== true && process.stdin.isTTY
        ? await (async () => {
            const rl = (await import("node:readline/promises")).createInterface({ input: process.stdin });
            try {
              const a = (await rl.question("写入免键(OAuth 授权)连接配置？[y/N] ")).trim().toLowerCase();
              return a === "y" || a === "yes";
            } finally { rl.close(); }
          })()
        : false);
      if (!shouldWrite) {
        console.log("\nMCP 引用（--oauth 但未写入；--write-mcp 启用写入）：");
        for (const s of mcp) {
          console.log(`  · ${s.registryName} — 端点 ${registry}/${s.registryName}/mcp`);
        }
      } else {
        const files = await writeMcpConfig(opts.target, {
          registry, servers: mcp, project: opts.project, oauth: opts.oauthClient || true,
        });
        console.log("\nMCP 免键连接配置已写入（无凭据落盘）：");
        for (const f of [...new Set(files)]) console.log(`  ✓ ${f}`);
        if (opts.target === "workbuddy") {
          console.log("  注：服务端免键车道已端到端实证（静态 client_id 绕开动态注册）。");
          console.log("      WorkBuddy 5.9.3 的用户级 mcp.json 加载器暂不消费 oauth 块（客户端连接器/市场模板路径才消费）——");
          console.log("      该条目为前瞻形状，与客户端连接器模板同形；今日真连接仍走贴键（facet connect 后 --write-mcp）。");
        }
        for (const s of mcp) {
          if (s.requiredGroup) console.log(`  注：${s.registryName} 需要组 ${s.requiredGroup}——授权账号不持该角色时调用会被拒。`);
        }
      }
    } else {
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
      if (opts.target === "workbuddy") {
        console.log("  workbuddy 亦可免键：重跑本命令加 --oauth（写前瞻条目——服务端已实证就绪，5.9.3 客户端用户文件暂不消费该块）。");
      }
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
  }

  if (opts.target === "cursor") {
    console.log("\n注：Cursor 的技能目录支持随版本而异；若该目录未被读取，可将 SKILL.md 内容接入 Cursor Rules（.cursor/rules/）。");
  }
  if (opts.target === "codex") {
    console.log("\n注：Codex 亦有 ~/.agents/skills/ 约定但发现尚不稳定；本安装写官方 ~/.codex/skills/ 路径。");
  }
  if (opts.target === "workbuddy") {
    console.log(
      "\n注：WorkBuddy 的技能目录是 ~/.workbuddy/skills/（真机实证：放进去的 SKILL.md 会进客户端技能列表，source=userSettings）；"
      + "MCP 配置在同目录的 mcp.json。若客户端未识别技能，检查「已安装」列表与技能开关（关闭≠未安装），并确认客户端已重启或该目录在监听表内。"
    );
    console.log("    免键车道（两层状态，2026-10-30 定案）：授权/网关侧已端到端实证（静态 client_id 绕开动态注册，token 零落盘）；WorkBuddy 5.9.3 客户端的用户级 mcp.json 加载器暂不消费 oauth 块（仅连接器/市场模板路径消费）——`facet install … --oauth --write-mcp` 写的是同形前瞻条目，今日真连接走 facet connect 贴键 + --write-mcp。两层证据与去向见 docs/ecosystem/workbuddy.md §1a。");
  }
  console.log(`\n完成：${detail.id} v${version}（快照安装，无订阅副作用）。`);
  console.log(`把智能体装进运行时（对话/Agent 服务）请到壹座：设置 → 智能体 → 我的（订阅后一键安装）。`);
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
    // 按记录解析来源（fix-supply-machine-faces 6.2）：显式 --base 覆盖一切；
    // 否则用安装时记下的市场；老记录没有 base 才回落官方，并且**说出来**
    // ——原来那个坑之所以难查，正是因为它一声不响。
    const recordedBase = typeof rec.base === "string" && rec.base ? rec.base : null;
    const base = String(
      opts.baseExplicit ? opts.base : recordedBase || DEFAULT_BASE,
    ).replace(/\/+$/, "");
    const fromNote = opts.baseExplicit
      ? `来源 ${base}（--base）`
      : recordedBase
        ? `来源 ${base}（随记录）`
        : `来源 ${base}（记录无 base，默认官方市场）`;
    const detail = await fetchJson(`${base}/api/packs/${encodeURIComponent(rec.packId)}`).catch(() => null);
    if (!detail?.id) {
      console.log(`✗ ${label} — 智能体已不可解析（下架/私有/网络），记录保持 v${rec.version}；${fromNote}`);
      continue;
    }
    if (detail.version === rec.version) {
      console.log(`✓ ${label} 已最新 v${rec.version}；${fromNote}`);
      continue;
    }
    const root = rec.scope === "项目级" && rec.project ? rec.project : HOME();
    const dir = path.join(root, SKILLS_SUBDIR[rec.target], "skills");
    console.log(`↻ ${label} v${rec.version} → v${detail.version}（重取快照）；${fromNote}`);
    await writeSkillSnapshot(base, detail, dir);
    await recordInstall({ ...rec, base, version: detail.version, installedAt: new Date().toISOString() });
    upgraded += 1;
  }
  console.log(upgraded > 0 ? `完成：${upgraded} 笔更新（无订阅副作用——快照模型）。` : "没有需要更新的安装。");
}

// ── list / search (fix-supply-machine-faces 5.x): 不知道 id 也能走到 install ──
// 读的是 install 用的同一个目录 API（/api/packs），没有第二份目录、没有本地
// 缓存。打印出来的 id 就是 facet install 接受的那个字符串——管道里能直接用。
const LISTABLE_SPECIES = ["pack"];

function listingBase(opts) {
  return String(opts.base || DEFAULT_BASE).replace(/\/+$/, "");
}

async function fetchListing(opts, { search = "" } = {}) {
  const base = listingBase(opts);
  const species = String(opts.species || "pack");
  if (!LISTABLE_SPECIES.includes(species)) {
    throw new Error(
      `--species ${species} 暂不由本命令列出（当前只列 pack）；${species} 的目录面：${base}/api/${species === "mcp" ? "mcp-catalog" : "skills-catalog"}`,
    );
  }
  const limit = Math.min(Math.max(1, Number(opts.limit) || 50), 100);
  const qs = new URLSearchParams({ page: "1", pageSize: String(limit) });
  if (search) qs.set("search", search);
  if (opts.line) qs.set("category", String(opts.line));
  let payload;
  try {
    payload = await fetchJson(`${base}/api/packs?${qs.toString()}`);
  } catch (e) {
    throw new Error(`目录不可达：${base}（${e.message}）——未打印任何半截目录`);
  }
  return { base, payload, limit };
}

function printListing({ base, payload }, { search = "" } = {}) {
  const rows = payload.packs ?? [];
  if (rows.length === 0) {
    const what = search ? `匹配「${search}」的智能体` : "已上架的智能体";
    console.log(`无匹配：${base} 上没有${what}（目录可达，结果为空）。`);
    return;
  }
  for (const p of rows) {
    const line = p.category ? ` · ${p.category}` : "";
    const desc = String(p.description ?? "").replace(/\s+/g, " ").slice(0, 80);
    console.log(`${p.id}  v${p.version}  ${p.name}${line}`);
    if (desc) console.log(`    ${desc}`);
  }
  const total = Number(payload.total ?? rows.length);
  if (total > rows.length) {
    console.log(`\n共 ${total} 个，显示前 ${rows.length} 个（--limit 可到 100）。`);
  }
  console.log(`\n安装：npx @finddatatechnology/facet install <id>${base === DEFAULT_BASE ? "" : ` --base ${base}`}`);
}

async function listRun(opts) {
  const listing = await fetchListing(opts);
  if (opts.json) {
    console.log(JSON.stringify(listing.payload.packs ?? [], null, 2));
    return;
  }
  console.log(`谦面目录 · ${listing.base}${opts.line ? ` · ${opts.line}` : ""}`);
  console.log("");
  printListing(listing);
}

async function searchRun(opts) {
  const query = String(opts.packRef ?? "").trim();
  if (!query) throw new Error("缺少查询词——用法：facet search <关键词> [--base …] [--line …]");
  const listing = await fetchListing(opts, { search: query });
  if (opts.json) {
    console.log(JSON.stringify(listing.payload.packs ?? [], null, 2));
    return;
  }
  console.log(`谦面搜索 · ${listing.base} · 「${query}」`);
  console.log("");
  printListing(listing, { search: query });
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
  if (!ref) throw new Error("缺少发布载荷——给 manifest 文件路径，或智能体 id 配 --from <源实例>");

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
    if (!fromBase) throw new Error("跨实例发布需要 --from <源实例地址>（或直接给智能体详情页 URL）");
    sourceId = extractPackId(ref);
    const detail = await fetchJson(`${fromBase}/api/packs/${encodeURIComponent(sourceId)}`).catch(() => null);
    if (!detail?.manifest) {
      throw new Error(`源实例 ${fromBase} 上找不到公开智能体 ${sourceId}——私有/已下架的智能体不可搬运（先转公开，或改用本地清单文件）`);
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
    else if (opts.command === "auth") await authRun(opts);
    else if (opts.command === "prefs") await prefs(opts);
    else if (opts.command === "update") await update(opts);
    else if (opts.command === "list") await listRun(opts);
    else if (opts.command === "search") await searchRun(opts);
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