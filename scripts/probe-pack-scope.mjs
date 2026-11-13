// probe-pack-scope.mjs — measurement probe for add-pack-agent-scoping.
//
// Part 1 (default): compose the full vs focused MCP patches into a THROWAWAY
// DSH_HOME (the deployment's own patch files are never touched; the DB is
// only read), parse them back, and live-count each server's tools with a real
// initialize + tools/list handshake over the patch's FINAL transport config —
// credentials resolved exactly as the child would see them. Reports the
// per-mode server/tool roster and the delta.
//
// Part 2 (--turn-trace): same prompt, same model, both modes against a
// RUNNING deployment — set_preset over WS, one turn per mode, usage tokens
// read back from /api/trace. The delta is the per-turn context cost the focus
// removes. Numbers land in the change's measurements record
// (openspec/changes/add-pack-agent-scoping/measurements.md).
//
// Usage:
//   node scripts/probe-pack-scope.mjs [--db PATH] [--mcp PATH] [--data-dir PATH] \
//        [--dsh-home PATH] [--preset AGENT_ID | --pack PACK_ID] [--overlay]
//   node scripts/probe-pack-scope.mjs --turn-trace --url http://127.0.0.1:3000 \
//        [--prompt "..."] [--db PATH] [--preset AGENT_ID] [--json]
//
// --overlay (add-focus-overlay): every persona WITH a stored preference diff
// is reported twice — its derived surface (diff suppressed) beside the
// derived±overlay surface the runtime composes — from the same read-only DB.
//
// Env fallbacks: DB_PATH / MCP_CONFIG_PATH / PLATFORM_DATA_DIR / DSH_HOME (the
// deployment's own values work as-is).

import { mkdtempSync, rmSync, symlinkSync, existsSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import yaml from "js-yaml";

// ── args ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name) => args.includes(`--${name}`);

const OPTS = {
  db: flag("db") || process.env.DB_PATH || null,
  mcp: flag("mcp") || process.env.MCP_CONFIG_PATH || null,
  dataDir: flag("data-dir") || process.env.PLATFORM_DATA_DIR || null,
  dshHome: flag("dsh-home") || process.env.DSH_HOME || path.join(homedir(), ".dsh"),
  preset: flag("preset") || null,
  pack: flag("pack") || null,
  overlay: has("overlay"),
  turnTrace: has("turn-trace"),
  url: flag("url") || "http://127.0.0.1:3000",
  prompt: flag("prompt") || "请用中文简要说明你能访问哪些工具和数据源，并举一个使用场景。",
  json: has("json"),
  auth: flag("auth") || process.env.PROBE_AUTH_TOKEN || null,
};

try { (await import("dotenv")).config(); } catch { /* .env optional — deployments carry real env */ }

// DSH_HOME must point at a temp dir BEFORE dsh-profile is imported (it binds
// its patch paths at import). The real home only lends its .agent-presets
// (read-only existence check inside deriveScope) via symlink.
const PROBE_HOME = mkdtempSync(path.join(tmpdir(), "pack-scope-probe-"));
process.env.DSH_HOME = PROBE_HOME;
const realPresets = path.join(OPTS.dshHome, ".agent-presets");
if (existsSync(realPresets)) {
  try { symlinkSync(realPresets, path.join(PROBE_HOME, ".agent-presets"), "dir"); } catch { /* best-effort */ }
}
if (OPTS.mcp) process.env.MCP_CONFIG_PATH = OPTS.mcp;
if (OPTS.db) process.env.DB_PATH = OPTS.db;
// The deployment's data root (custom-skills/packs/…) — skill-materialize
// binds storeDir at import, so this too must be set before any import.
if (OPTS.dataDir) process.env.PLATFORM_DATA_DIR = OPTS.dataDir;

// ── MCP live tool count (stdio + streamable-http) ────────────────────────────
// 2025-06-18: the registry gateway (mcp.finddatatech.cloud) 406s tools/list
// under the older revision — declare the newer one (accepted everywhere the
// old one was, including the e2e stub).
const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "pack-scope-probe", version: "1.0" };

function parseMaybeSse(text) {
  // streamable-http answers may be plain JSON or an SSE body — accept both.
  const t = text.trim();
  if (t.startsWith("{") || t.startsWith("[")) return JSON.parse(t);
  const dataLines = t.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
  for (let i = dataLines.length - 1; i >= 0; i--) {
    try { return JSON.parse(dataLines[i]); } catch { /* keep walking back */ }
  }
  throw new Error("unparsable MCP response body");
}

async function httpRpc(url, headers, body, timeoutMs = 12_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return { headers: r.headers, body: parseMaybeSse(await r.text()) };
  } finally {
    clearTimeout(timer);
  }
}

async function countHttpTools(config) {
  const init = await httpRpc(config.url, config.headers || {}, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
  });
  const sessionId = init.headers.get("mcp-session-id");
  const list = await httpRpc(config.url, { ...(config.headers || {}), ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}) }, {
    jsonrpc: "2.0", id: 2, method: "tools/list", params: {},
  });
  const tools = list.body?.result?.tools;
  if (!Array.isArray(tools)) throw new Error("no tools in result");
  return tools.length;
}

function countStdioTools(config) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.command, config.args || [], {
      cwd: config.cwd || process.cwd(),
      env: { ...process.env, ...(config.env || {}) },
      stdio: ["pipe", "pipe", "ignore"],
    });
    let buf = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("timeout")); }, 15_000);
    const onLine = (line) => {
      line = line.trim();
      if (!line) return;
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.id === 1) {
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
      } else if (msg.id === 2) {
        clearTimeout(timer);
        child.kill();
        const tools = msg.result?.tools;
        if (!Array.isArray(tools)) reject(new Error("no tools in result"));
        else resolve(tools.length);
      }
    };
    child.stdout.on("data", (d) => {
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop();
      lines.forEach(onLine);
    });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
    })}\n`);
  });
}

// Count once per unique server config; failures are reported, not fatal — a
// server the probe cannot reach still counts as present in the roster.
const toolCountCache = new Map();
async function countTools(entry) {
  const key = JSON.stringify(entry.config);
  if (toolCountCache.has(key)) return toolCountCache.get(key);
  let result;
  try {
    result = entry.config.transport === "stdio"
      ? await countStdioTools(entry.config)
      : await countHttpTools(entry.config);
  } catch (e) {
    result = `? (${e.message})`;
  }
  toolCountCache.set(key, result);
  return result;
}

// ── Part 1: patch composition + roster report ────────────────────────────────
function parsePatch(patchPath) {
  const doc = yaml.load(readFileSync(patchPath, "utf8"));
  return doc.flatMap((row) => row.insert ?? []);
}

async function probePatches() {
  const db = await import("../db.js");
  await db.initDb();
  const { writeMcpPatch, writeSkillsPatch, deriveScope } = await import("../dsh-profile.js");

  // Focus targets: --preset, the installed packs' agents (--pack narrows), or
  // the cell's custom presets (add-custom-presets — one more focused-role
  // family, reported per preset the same way).
  let targets = [];
  if (OPTS.preset) {
    targets = [{ packId: null, preset: OPTS.preset }];
  } else if (db.isDbReady()) {
    for (const installed of db.listInstalledPacks()) {
      if (OPTS.pack && installed.packId !== OPTS.pack) continue;
      const report = new Map((installed.report?.agents ?? []).map((r) => [r.id, r.status]));
      for (const a of installed.manifest?.agents ?? []) {
        if (report.get(a.id) === "installed") targets.push({ packId: installed.packId, packName: installed.name, preset: a.id });
      }
    }
    for (const preset of db.listUserPresets()) {
      targets.push({ packId: null, customPreset: preset.id, preset: preset.id });
    }
  }
  if (!targets.length) console.log("(no focus targets: no --preset, no --pack match, no installed packs, no custom presets)");

  const fullPatch = await writeMcpPatch();
  const fullEntries = fullPatch ? parsePatch(fullPatch) : [];
  const fullCounts = [];
  for (const e of fullEntries) fullCounts.push([e.config.serverName, await countTools(e)]);

  const modes = [{ mode: "full", preset: null, counts: fullCounts }];
  for (const t of targets) {
    const scope = await deriveScope(t.preset);
    if (!scope.packId && scope.source !== "custom") {
      modes.push({ mode: "unfocused", preset: t.preset, counts: null, note: "deriveScope ⇒ full (preset not a focused role here)" });
      continue;
    }
    // --overlay (add-focus-overlay): a role with a stored preference diff is
    // reported twice — the derived surface (diff suppressed) beside the
    // derived±overlay surface the runtime actually composes — so the diff's
    // effect on the role's surface is directly readable. The diff-suppressed
    // pass reuses the same writers via noOverlay (read-only, no state churn).
    const stored = db.isDbReady() ? db.getFocusOverlay(t.preset) : null;
    const composeFocused = async (noOverlay, modeLabel) => {
      const patch = await writeMcpPatch({ agentPreset: t.preset, noOverlay });
      const entries = patch ? parsePatch(patch) : [];
      const counts = [];
      for (const e of entries) counts.push([e.config.serverName, await countTools(e)]);
      // Compose the skills patch too: it BUILDS the persona compose root when
      // the persona declares skills (an ADR-0002 disposable artifact —
      // identical to what the next focused boot writes), so the skills-root
      // report below is the one a real focused session would load. The patch
      // itself lands in the probe's temp DSH_HOME; the deployment's patch
      // files stay untouched.
      const skillsPatch = await writeSkillsPatch({ agentPreset: t.preset, noOverlay });
      const skillsDirs = skillsPatch
        ? yaml.load(readFileSync(skillsPatch, "utf8"))[0].config.customSkillDirs.map((d) => path.resolve(d))
        : [];
      modes.push({
        mode: modeLabel, preset: t.preset, packId: scope.packId, packName: scope.packName,
        customPresetId: scope.customPresetId ?? null, customPresetName: scope.customPresetName ?? null, counts,
        persona: scope.persona, mcpKeep: scope.mcpKeep, skillsDirs,
        skillsDecl: scope.skillsDecl ?? null, overlay: noOverlay ? null : stored,
      });
    };
    if (OPTS.overlay && stored) await composeFocused(true, "focused-derived");
    await composeFocused(false, OPTS.overlay ? "focused-overlay" : "focused");
    if (OPTS.overlay && !stored) {
      modes.push({ mode: "note", preset: t.preset, counts: null, note: "no stored overlay — derived surface only (identical with --overlay)" });
    }
  }

  const totalOf = (counts) => counts?.reduce((n, [, c]) => n + (typeof c === "number" ? c : 0), 0);
  const out = { generatedAt: new Date().toISOString(), packBaselineMcp: process.env.PACK_BASELINE_MCP || "", modes: [] };
  for (const m of modes) {
    const servers = m.counts?.length ?? 0;
    const tools = totalOf(m.counts) ?? null;
    if (!OPTS.json) {
      console.log(`\n== ${m.mode}${m.preset ? ` preset=${m.preset}` : ""}${m.packName ? ` pack=${m.packName}` : ""}${m.customPresetName ? ` custom="${m.customPresetName}"` : ""}${m.persona ? ` persona=${m.persona}` : ""} ==`);
      if (m.note) console.log(`   ${m.note}`);
      if (m.skillsDecl !== undefined && m.mode.startsWith("focused")) {
        console.log(`   declaration: ${m.skillsDecl ? `${m.skillsDecl.length} skill(s) declared` : "no skill declaration (whole pack root)"}`);
      }
      if (m.overlay) {
        console.log(`   overlay: +mcp[${m.overlay.addMcp?.join(", ") || "-"}] -mcp[${m.overlay.removeMcp?.join(", ") || "-"}] +skills[${m.overlay.addSkills?.join(", ") || "-"}] -skills[${m.overlay.removeSkills?.join(", ") || "-"}]`);
      }
      console.log(`   effective MCP servers: ${servers}, total MCP tools: ${tools}`);
      for (const [name, c] of m.counts ?? []) console.log(`   - ${name}: ${typeof c === "number" ? `${c} tools` : c}`);
      if (m.skillsDirs) {
        for (const d of m.skillsDirs.slice(1)) console.log(`   skills root: ${d}`);
        if (m.skillsDirs.length === 1) console.log("   skills root: (baseline only — no pack/persona skills)");
      }
    }
    out.modes.push({ mode: m.mode, preset: m.preset, packId: m.packId, persona: m.persona ?? null,
      customPresetId: m.customPresetId ?? null, customPresetName: m.customPresetName ?? null,
      servers, tools,
      perServer: Object.fromEntries(m.counts ?? []), skillsDirs: m.skillsDirs ?? null, mcpKeep: m.mcpKeep ?? null,
      skillsDecl: m.skillsDecl ?? null, overlay: m.overlay ?? null });
  }
  const full = out.modes.find((m) => m.mode === "full");
  for (const m of out.modes.filter((x) => x.mode.startsWith("focused"))) {
    const delta = full.tools != null && m.tools != null ? m.tools - full.tools : null;
    m.toolDeltaVsFull = delta;
    if (!OPTS.json) console.log(`\ndelta ${m.preset}: ${delta != null ? `${delta >= 0 ? "+" : ""}${delta} MCP tools vs full` : "(unmeasurable — a server was unreachable)"}`);
  }
  if (OPTS.json) console.log(JSON.stringify(out, null, 2));
  return out;
}

// ── Part 2: turn-trace token comparison over WS ──────────────────────────────
async function turnTrace() {
  const { default: WebSocket } = await import("ws");
  const base = OPTS.url.replace(/\/+$/, "");
  const wsUrl = base.replace(/^http/, "ws") + "/probe";

  // Focus targets (add-persona-resource-sets; custom presets join the set —
  // add-custom-presets): --preset narrows to one; otherwise EVERY installed
  // pack persona plus every custom preset — one full-mode reference turn,
  // then one turn per focused role, same prompt, same model.
  let targets = [];
  if (OPTS.preset) {
    targets = [OPTS.preset];
  } else if (OPTS.db) {
    const db = await import("../db.js");
    await db.initDb();
    for (const installed of db.listInstalledPacks()) {
      const report = new Map((installed.report?.agents ?? []).map((r) => [r.id, r.status]));
      for (const a of installed.manifest?.agents ?? []) {
        if (report.get(a.id) === "installed") targets.push(a.id);
      }
    }
    for (const preset of db.listUserPresets()) targets.push(preset.id);
  }
  if (!targets.length) throw new Error("--turn-trace needs focused role(s) (--preset) or installed packs/custom presets in --db");

  // Authenticated deployments (fd-prod, AUTH_MODE=mp) gate the WS too —
  // --auth <token> (or PROBE_AUTH_TOKEN) rides along as a Bearer header.
  const ws = OPTS.auth
    ? new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${OPTS.auth}` } })
    : new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });

  // list_presets answers only once the agent is live; poll it as the
  // readiness gate ("ready" itself is a mid-boot-only sync).
  const queryCurrent = () =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error("list_presets timeout")); }, 30_000);
      const onMessage = (raw) => {
        let m;
        try { m = JSON.parse(raw.toString()); } catch { return; }
        if (m.type === "presets") { cleanup(); resolve(m.current); }
        if (m.type === "error") { cleanup(); reject(new Error(`server error: ${m.message}`)); }
      };
      const cleanup = () => { clearTimeout(timer); ws.off("message", onMessage); };
      ws.on("message", onMessage);
      ws.send(JSON.stringify({ type: "list_presets" }));
    });
  // Drive the runtime to a preset by polling, not broadcast correlation:
  // set_preset early-returns without a broadcast when the preset is already
  // current (a leftover from an earlier run), and the switch restart takes
  // seconds — polling list_presets is idempotent against both.
  const ensurePreset = async (presetId) => {
    for (let i = 0; i < 40; i++) {
      let current = null;
      try { current = await queryCurrent(); } catch { /* bridge mid-restart */ }
      if (current === presetId) return;
      if (i === 0) ws.send(JSON.stringify({ type: "set_preset", id: presetId }));
      await new Promise((r) => setTimeout(r, 3000));
    }
    throw new Error(`preset never became ${presetId}`);
  };
  const waitFor = (type, timeoutMs = 300_000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`timeout waiting for ${type}`)); }, timeoutMs);
    const onMessage = (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.type === "error") { cleanup(); reject(new Error(`server error: ${m.message}`)); }
      if (m.type === type) { cleanup(); resolve(m); }
    };
    const cleanup = () => { clearTimeout(timer); ws.off("message", onMessage); };
    ws.on("message", onMessage);
  });
  const runTurn = async (presetId) => {
    await ensurePreset(presetId);
    ws.send(JSON.stringify({ type: "new_session" }));
    await waitFor("session_loaded", 60_000);
    ws.send(JSON.stringify({ type: "prompt", text: OPTS.prompt }));
    await waitFor("done", 300_000);
  };

  console.log(`turn-trace: full (standard) then focused (${targets.join(", ")}) — same prompt, same model`);
  await runTurn("standard");
  for (const t of targets) await runTurn(t);
  ws.close();

  // Usage tokens from the trace viewer: newest turns first, matched by prompt.
  const needed = 1 + targets.length;
  const traceHeaders = OPTS.auth ? { Authorization: `Bearer ${OPTS.auth}` } : {};
  const turns = (await (await fetch(`${base}/api/trace/turns?limit=${Math.max(8, needed + 4)}`, { headers: traceHeaders })).json()).turns;
  const usageOf = async (turnId) => {
    const doc = await (await fetch(`${base}/api/trace/turns/${turnId}`, { headers: traceHeaders })).json();
    for (const e of doc.events ?? []) {
      const c = e.payload?.event?.data?.chunk ?? e.payload?.data?.chunk;
      // dsh emits token usage as its own chunk after the text blocks.
      if (c?.type === "usage" && c.usage) return c.usage;
    }
    return null;
  };
  const matched = [];
  for (const t of turns) {
    const doc = await (await fetch(`${base}/api/trace/turns/${t.turnId}`, { headers: traceHeaders })).json();
    const user = (doc.events ?? []).find((e) => e.eventType === "user/message");
    if (user && (user.summary || "").includes(OPTS.prompt.slice(0, 20))) matched.push(t);
    if (matched.length >= needed) break;
  }
  if (matched.length < needed) throw new Error(`expected ${needed} traced turns for the prompt, found ${matched.length}`);
  // Newest first → reverse to run order: the full reference, then per persona.
  const ordered = matched.slice(0, needed).reverse();
  const fullUsage = await usageOf(ordered[0].turnId);
  const sum = (u) => (u.inputTokens ?? u.input_tokens ?? 0) + (u.outputTokens ?? u.output_tokens ?? 0) + (u.reasoningTokens ?? u.reasoning_tokens ?? 0);
  const result = {
    prompt: OPTS.prompt,
    full: { turnId: ordered[0].turnId, model: ordered[0].model, provider: ordered[0].provider, usage: fullUsage },
    personas: [],
  };
  for (let i = 0; i < targets.length; i++) {
    const t = ordered[i + 1];
    const usage = await usageOf(t.turnId);
    result.personas.push({
      preset: targets[i],
      turnId: t.turnId,
      model: t.model,
      provider: t.provider,
      usage,
      deltaVsFull: fullUsage && usage ? sum(usage) - sum(fullUsage) : null,
    });
  }
  console.log(JSON.stringify(result, null, 2));
  return result;
}

// ── main ─────────────────────────────────────────────────────────────────────
try {
  if (OPTS.turnTrace) await turnTrace();
  else await probePatches();
} finally {
  try { rmSync(PROBE_HOME, { recursive: true, force: true }); } catch { /* best-effort */ }
}
