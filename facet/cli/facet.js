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

import { chmod, mkdir, readFile, rm, writeFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
  facet connect [--key wgk-…] [--registry <url>] [--clear] [--show] [--no-open]
  facet prefs <agent-slug> [--key sk-…] [--wanxing <url>]
                          [--set-callback <url> <secret>] [--set-reap <minutes>]
                          [--clear callback|reap|all] [--show]
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

说明：安装即版本快照（不产生订阅）；MCP 需 registry 账号凭据，端点仅打印。`;

function parseArgs(argv) {
  const out = { command: null, packRef: null, target: "claude-code", project: null, base: DEFAULT_BASE, registry: DEFAULT_REGISTRY, key: null, wanxing: process.env.FACET_WANXING || "https://wanxing.finddatatech.cloud", setCallback: null, setReap: undefined, clear: null };
  const rest = [...argv];
  out.command = rest.shift() ?? null;
  // A bare flag in command position (`facet --version`, `facet -h`) is the
  // flag, not an unknown command.
  if (out.command === "--version" || out.command === "-v") out.command = "version";
  else if (out.command === "--help" || out.command === "-h") out.command = "help";
  while (rest.length > 0) {
    const a = rest.shift();
    if (a === "--target") out.target = rest.shift();
    else if (a === "--project") out.project = rest.shift();
    else if (a === "--base") out.base = rest.shift();
    else if (a === "--registry") out.registry = rest.shift();
    else if (a === "--key") out.key = rest.shift();
    else if (a === "--wanxing") out.wanxing = rest.shift();
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

async function readKeyFromStdin() {
  const rl = (await import("node:readline/promises")).createInterface({ input: process.stdin });
  try {
    const k = (await rl.question("粘贴 wgk- 调用键（回车确认）：")).trim();
    if (!k) throw new Error("未读入调用键");
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
    console.log(`  ✓ ${path.join(skillDir, "SKILL.md")}`);
  }

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

export { parseArgs, extractPackId, targetDir };

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.command === "help" || opts.command === null) console.log(USAGE);
    else if (opts.command === "version") console.log(VERSION);
    else if (opts.command === "install") await install(opts);
    else if (opts.command === "connect") await connectRun(opts);
    else if (opts.command === "prefs") await prefs(opts);
    else {
      console.error(`未知命令：${opts.command}\n\n${USAGE}`);
      process.exit(2);
    }
  } catch (e) {
    console.error(`facet: ${e.message}`);
    process.exit(1);
  }
}