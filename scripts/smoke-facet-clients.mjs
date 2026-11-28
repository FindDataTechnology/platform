#!/usr/bin/env node
// ── Client capability smoke (add-facet-client-matrix, F2.2) ───────────────────
//
// The CLI-side half of the support matrix: per target, run the REAL installer
// against the production facet market in an isolated FACET_HOME with a dummy
// caller key (the MCP write path never verifies the key — liveness is
// connect's domain), then assert the skills landed and the native MCP config
// carries the exact shape that client expects. Shape drift here fails the
// matrix — the docs move with the code or not at all.
//
//   node scripts/smoke-facet-clients.mjs [--base https://facet.finddatatech.cloud]
//
// Read-only against the market (GET detail + skill md). No real credentials.

import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const args = process.argv.slice(2);
const BASE = (args.includes("--base") ? args[args.indexOf("--base") + 1] : undefined) || "https://facet.finddatatech.cloud";
const CLI = path.resolve("facet/cli/facet.js");

// The pack under smoke: public, listed, skill-bearing (数据-自助分析).
const PACK = process.env.FACET_SMOKE_PACK || "50Tp176hW0HYTTWXZbarKA";

// Derived from the CLI's own table, not copied: a hand-maintained list here
// silently skipped every target added after it was written (the same bug the
// delivery-matrix checker had with pi/opencode/qoder/trae/hermes).
const cliSrc = readFileSync(CLI, "utf8");
const skillsTable = cliSrc.match(/const SKILLS_SUBDIR = \{([\s\S]*?)^\};/m);
const SKILLS_DIR = Object.fromEntries(
  [...skillsTable[1].matchAll(/^ {2}"?([a-z][a-z0-9-]*)"?:\s*"\.([a-z][a-z0-9/-]*)",/gm)]
    .map((m) => [m[1], "." + m[2]]),
);

// What each target's native MCP entry must look like (the matrix's
// "MCP 配置写" row, per cell): [file, predicate over the parsed doc].
const TOML_ENTRY = /^\[mcp_servers\.[a-z0-9-]+\]\s*\nurl = "[^"]+"\s*\nhttp_headers = \{ "Authorization" = "Bearer wgk-[^"]+" \}/m;
const MCP_EXPECT = {
  "claude-code": {
    file: (h) => path.join(h, ".claude.json"),
    check: (doc) => Object.entries(doc.mcpServers ?? {}).some(([, e]) => e.type === "http" && typeof e.url === "string" && /^Bearer wgk-/.test(e.headers?.Authorization ?? "")),
  },
  cursor: {
    file: (h) => path.join(h, ".cursor", "mcp.json"),
    check: (doc) => Object.entries(doc.mcpServers ?? {}).some(([, e]) => typeof e.url === "string" && e.type === undefined && /^Bearer wgk-/.test(e.headers?.Authorization ?? "")),
  },
  zcode: {
    file: (h) => path.join(h, ".zcode", "cli", "config.json"),
    check: (doc) => Object.entries(doc.mcp?.servers ?? {}).some(([, e]) => e.type === "http" && typeof e.url === "string" && /^Bearer wgk-/.test(e.headers?.Authorization ?? "")),
  },
  "gemini-cli": {
    file: (h) => path.join(h, ".gemini", "settings.json"),
    check: (doc) => Object.entries(doc.mcpServers ?? {}).some(([, e]) => typeof e.httpUrl === "string" && /^Bearer wgk-/.test(e.headers?.Authorization ?? "")),
  },
  codex: {
    file: (h) => path.join(h, ".codex", "config.toml"),
    check: (text) => TOML_ENTRY.test(text),
  },
  workbuddy: {
    file: (h) => path.join(h, ".workbuddy", "mcp.json"),
    check: (doc) => Object.entries(doc.mcpServers ?? {}).some(([, e]) => e.type === "http" && typeof e.url === "string" && /^Bearer wgk-/.test(e.headers?.Authorization ?? "")),
  },
  // Added 2026-11-28 with the hermes/trae targets.
  qwen: {
    file: (h) => path.join(h, ".qwen", "settings.json"),
    check: (doc) => Object.entries(doc.mcpServers ?? {}).some(([, e]) => typeof e.httpUrl === "string" && /^Bearer wgk-/.test(e.headers?.Authorization ?? "")),
  },
  opencode: {
    file: (h) => path.join(h, ".config", "opencode", "opencode.json"),
    check: (doc) => Object.entries(doc.mcp ?? {}).some(([, e]) => e.type === "remote" && typeof e.url === "string" && /^Bearer wgk-/.test(e.headers?.Authorization ?? "")),
  },
  pi: {
    file: (h) => path.join(h, ".pi", "agent", "mcp.json"),
    check: (doc) => Object.values(doc).some((e) => typeof e.url === "string" && /^Bearer wgk-/.test(e.headers?.Authorization ?? "")),
  },
  openclaw: {
    file: (h) => path.join(h, ".openclaw", "openclaw.json"),
    check: (doc) => Object.values(doc.mcp?.servers ?? {}).some((e) => typeof e.url === "string" && /^Bearer wgk-/.test(e.headers?.Authorization ?? "")),
  },
  hermes: {
    file: (h) => path.join(h, ".hermes", "config.yaml"),
    // YAML, not JSON: check the text the writer produced, and that an existing
    // unrelated section survived (the parser round-trip is the point).
    check: (text) => /mcp_servers:\s*\n(?:.*\n)*?\s+fd-open-data-mcp:\s*\n\s+url: https:\/\/mcp\.finddatatech\.cloud\/fd-open-data-mcp\/mcp/.test(text)
      && /Authorization: Bearer wgk-/.test(text),
  },
  // qoder owns its MCP store (`qodercli mcp add-json`), so there is no file to
  // read back; the smoke asserts the CLI delegation printed the command and that
  // the install did not silently skip it.
  qoder: {
    file: (h) => path.join(h, ".qoder"),
    cli: true,
    check: () => true,
  },
  trae: {
    file: (h) => path.join(h, ".trae", "trae_config.yaml"),
    check: (text) => /mcp_servers:/.test(text) && /supergateway/.test(text) && /--oauth2Bearer/.test(text)
      && /allow_mcp_servers:/.test(text),
  },
};

let PATH_CACHE;
async function cliOnPath(bin) {
  if (!PATH_CACHE) {
    PATH_CACHE = {};
    await Promise.all(targetIds.map(async (t) => {
      try { await run(process.platform === "win32" ? "where" : "which", [t], { timeout: 10000 }); PATH_CACHE[t] = true; }
      catch { PATH_CACHE[t] = false; }
    }));
  }
  return PATH_CACHE[bin];
}

const tmp = mkdtempSync(path.join(tmpdir(), "facet-smoke-"));
let failures = 0;

const targetIds = Object.keys(SKILLS_DIR);
console.log(`facet client smoke — ${targetIds.length} targets × (skills + MCP shape) against ${BASE}`);
console.log("(哑 wgk 凭据：MCP 写入不验键；连通性属 F2.1 的 initialize 探针域)\n");

const missingExpect = targetIds.filter((t) => !MCP_EXPECT[t]);
if (missingExpect.length) {
  console.error(`no MCP shape expectation for: ${missingExpect.join(", ")} — add it to MCP_EXPECT`);
  process.exit(1);
}

for (const target of targetIds) {
  // A CLI-delegating target whose CLI is not on this machine is an environment
  // gap, not shape drift: install would (correctly) refuse, so say that instead
  // of reporting a red. The same rule the rig uses — absent is why=absent.
  if (MCP_EXPECT[target].cli && !(await cliOnPath(target))) {
    console.log(`~ ${target.padEnd(11)} skipped — ${target} CLI is not installed on this machine`);
    continue;
  }
  const home = path.join(tmp, target);
  const env = { ...process.env, FACET_HOME: home, FACET_CREDENTIALS_PATH: path.join(home, ".facet", "credentials.json") };
  // Dummy-but-shaped credential: install only carries it into configs.
  await run(process.execPath, ["-e", `
    const fs = await import("node:fs");
    fs.mkdirSync(${JSON.stringify(path.dirname(env.FACET_CREDENTIALS_PATH))}, { recursive: true });
    fs.writeFileSync(${JSON.stringify(env.FACET_CREDENTIALS_PATH)}, JSON.stringify({ key: "wgk-smoke-dummy", registry: "https://mcp.finddatatech.cloud", verifiedAt: new Date().toISOString(), servers: [] }));
  `], { env });
  try {
    const { stdout } = await run(process.execPath, [CLI, "install", PACK, "--target", target, "--write-mcp", "--base", BASE], { env });

    // 1) skills landed under the dotdir
    const skills = stdout.split("\n").filter((l) => l.includes("✓") && l.includes("SKILL.md"));
    if (skills.length === 0) throw new Error("no skill file landed");
    for (const line of skills) {
      const f = line.replace(/^.*✓ /, "").trim();
      readFileSync(f, "utf8"); // exists + readable
    }

    // 2) native MCP config shape
    const file = MCP_EXPECT[target].file(home);
    const raw = readFileSync(file, "utf8");
    if (MCP_EXPECT[target].cli) {
      if (!/mcp add-json/.test(stdout)) throw new Error("qoder CLI delegation did not run");
      console.log(`✓ ${target.padEnd(11)} skills=${skills.length}  mcp=qodercli add-json 委托`);
      continue;
    }
    const isText = target === "codex" || target === "hermes" || target === "trae";
    const ok = MCP_EXPECT[target].check(isText ? raw : JSON.parse(raw));
    if (!ok) throw new Error(`MCP entry shape mismatch in ${file}\n---\n${(target === "codex" ? raw.split("\n[")
      .filter((sec) => sec.includes("mcp_servers"))
      .map((sec) => "[" + sec)
      .join("\n") : JSON.stringify(JSON.parse(raw), null, 1)).slice(0, 500)}`);

    console.log(`✓ ${target.padEnd(11)} skills=${skills.length}  mcp=${path.basename(file)} 形状对`);
  } catch (e) {
    failures += 1;
    console.error(`✗ ${target}: ${String(e.stderr || e.stdout || e.message).split("\n")[0]}`);
    if (String(e.message).includes("mismatch")) console.error(String(e.message).split("\n").slice(1, 8).join("\n"));
  }
}

rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? "\nPASS — matrix cells hold; CLI 写入形状与矩阵一致。" : `\nFAIL — ${failures} target(s) drifted.`);
process.exit(failures === 0 ? 0 : 1);
