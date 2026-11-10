#!/usr/bin/env node
// [DEBUG-a4f2] Tight feedback loop for the user-questions bridge activation bug.
//
// Symptom under test (failing image smoke gate, 2026-10-13 @896e142):
//   dsh: warning: 1 entry did not activate
//   platform-user-questions-server (…/platform-user-questions-bridge.js):
//     TypeError: ctx.userQuestions.registerProvider is not a function
//   → dsh initialize times out → /api/ready never 200 → image gate blocks.
//
// Why the contracts loop cannot see it: dsh-contracts.mjs spawns dsh with only
// TWO patches (presets + permissions), so the user-questions plugin is never
// composed. The real /api/ready path (dsh-bridge.patchArgs) passes SEVEN,
// including user-questions.patch.yml. This loop reproduces the REAL shape.
//
// ISOLATION (learned the hard way, 2026-10-14): dsh-profile.js binds DSH_HOME at
// MODULE-LEVEL, so DSH_HOME must be set BEFORE the dynamic import — otherwise
// every writer lands in the real ~/.dsh. Same trick dsh-contracts.mjs uses.
//
// RED  = user-questions entry fails to activate, or initialize never completes.
// GREEN= handshake completes and no deactivation names user-questions.
//
// Usage: node scripts/debug-user-questions-loop.mjs [--tree <dsh-install>]

import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TREE = (() => {
  const i = process.argv.indexOf("--tree");
  return i > -1 ? resolve(process.argv[i + 1])
    : join(REPO, "node_modules", ".cache", "dsh-contracts-tree", "eab0fd13e31334e8");
})();
const BIN = join(TREE, "node_modules", ".bin", "dsh");
const NM = join(TREE, "node_modules");

if (!existsSync(BIN)) {
  console.error(`[DEBUG-a4f2] no dsh install at ${BIN}; pass --tree <dir>`);
  process.exit(3);
}

// ── 1. Point every env-var path at a THROWAWAY home BEFORE importing the
//      platform writers (module-level DSH_HOME binding). Do not reorder.
const home = mkdtempSync(join(tmpdir(), "uq-loop-"));
process.env.DSH_HOME = home;
process.env.LLM_API_KEY = "uq-loop-dummy-key";
process.env.LLM_PROVIDERS_STORE = join(home, "llm-providers.json");
process.env.LLM_DEFAULT_STORE = join(home, "llm-default.json");
process.env.DB_PATH = join(home, "uq-loop.db");
process.env.MCP_CONFIG_PATH = join(home, "mcp.json");
console.log(`[DEBUG-a4f2] throwaway home=${home}`);
console.log(`[DEBUG-a4f2] tree=${TREE}`);

// ── 2. Imports AFTER the env is pinned.
await import("@deepseek-ai/dsh-sdk-client");
const dshProfile = await import("../dsh-profile.js");
const { patchArgs } = await import("../dsh-bridge.js");

// Guard: if the writers still resolve outside the throwaway home, abort — never
// let a debug loop mutate the operator's real ~/.dsh.
const realHome = join(process.env.HOME, ".dsh");
if (home === realHome || !home.startsWith(tmpdir())) {
  console.error(`[DEBUG-a4f2] refusing to run: home ${home} is not a throwaway dir`);
  process.exit(3);
}

const dirs = { dshHome: home, profileName: "platform" };
try { dshProfile.ensureDshHome({ dirs }); } catch (e) { console.log(`[DEBUG-a4f2] dshHome: ${e.message}`); }

// ── 2a. Scaffold + module levels FIRST, exactly as dsh-contracts.mjs does
//       (image parity with /opt/dsh-home). Order matters: copying the template's
//       cordis.patch.yml AFTER the LLM writer would clobber the generated
//       provider rows, and the child then rejects initialize with
//       "no adapter registered for provider X" — a harness artifact, not a bug.
{
  const { copyFileSync, mkdirSync, symlinkSync } = await import("node:fs");
  const profileDir = join(home, "profiles", "platform");
  mkdirSync(profileDir, { recursive: true });
  for (const f of ["package.json", "pnpm-workspace.yaml", "cordis.yml", "cordis.patch.yml"]) {
    copyFileSync(join(REPO, "dsh-profile-template", f), join(profileDir, f));
  }
  const nodeLink = join(profileDir, "node_modules");
  if (!existsSync(nodeLink)) symlinkSync(NM, nodeLink, "dir");
  const dshPkg = join(NM, "@deepseek-ai", "dsh");
  mkdirSync(join(home, "profiles", "node_modules", "@deepseek-ai"), { recursive: true });
  try { symlinkSync(dshPkg, join(home, "profiles", "node_modules", "@deepseek-ai", "dsh"), "dir"); }
  catch (e) { if (e.code !== "EEXIST") console.log(`[DEBUG-a4f2] dsh symlink: ${e.message}`); }
}

// ── 2b. Now the writers. The child refuses initialize for an unregistered
//       provider ("no adapter registered for provider X"), so take the
//       provider/model pair from the same writer the server uses.
let provider = "volces";
let model = "deepseek-v4.1-flash";
try {
  const built = await dshProfile.writeLlmProfile({ dirs, llmApiKey: "uq-loop-dummy-key" });
  provider = Object.keys(built?.providers ?? {})[0] ?? provider;
  model = built?.models?.[0]?.id ?? model;
} catch (e) { console.log(`[DEBUG-a4f2] llm: ${e.message}`); }
try { await dshProfile.ensureCredentialsStore({ dirs }); } catch (e) { console.log(`[DEBUG-a4f2] creds: ${e.message}`); }

// ── 3. Materialize the SAME overlay set the real /api/ready child gets.
//      (mcp + chart-bind included: the child's composed cordis.yml declares
//      rows that resolve through these patches; omitting one leaves the loader
//      with an undefined path and initialize fails with an unrelated error.)
const paths = {};
const overlay = async (label, fn) => {
  try { paths[label] = await fn(); }
  catch (e) { console.log(`[DEBUG-a4f2] ${label}: ${e.message}`); }
};
await overlay("presetsPatchPath", () => dshProfile.writePresetsPatch({ dirs }));
await overlay("permissionsPatchPath", () => dshProfile.writePermissionsPatch());
await overlay("toolSearchPatchPath", async () => dshProfile.writeToolSearchPatch());
await overlay("userQuestionsPatchPath", async () => dshProfile.writeUserQuestionsPatch());
await overlay("chartBindPatchPath", async () => dshProfile.writeChartBindPatch?.());
await overlay("saveLibraryPatchPath", async () => dshProfile.writeSaveLibraryPatch?.());
await overlay("skillsPatchPath", async () => {
  await dshProfile.writeSkillsPatch({ dirs, agentPreset: "standard" });
  return join(home, "profiles", "platform", "skills.patch.yml");
});
await overlay("mcpPatchPath", async () => {
  // writeMcpPatch() takes no required args and returns the patch path.
  const p = await dshProfile.writeMcpPatch();
  return p ?? join(home, "profiles", "platform", "mcp.patch.yml");
});

// Isolation proof: the bridge under test must live in the throwaway home.
for (const k of Object.keys(paths)) {
  const p = paths[k];
  if (typeof p === "string" && !p.startsWith(home)) {
    console.error(`[DEBUG-a4f2] ABORT: ${k} wrote outside throwaway home → ${p}`);
    process.exit(3);
  }
}
console.log(`[DEBUG-a4f2] overlays: ${Object.entries(paths).map(([k, v]) => `${k}=${v ? "ok" : "MISSING"}`).join(" ")}`);

// --patches <a,b,c> narrows the set (minimisation). Default: every overlay that
// materialized. Vars: presets,permissions,toolSearch,userQuestions,chartBind,skills,mcp
const patchSel = (() => {
  const i = process.argv.indexOf("--patches");
  return i > -1 ? new Set(process.argv[i + 1].split(",")) : null;
})();
const chosen = Object.fromEntries(
  Object.entries(paths).filter(([k, p]) => typeof p === "string" && existsSync(p)
    && (patchSel === null || patchSel.has(k.replace(/PatchPath$/, ""))),
));
const args = ["--profile", "platform", ...patchArgs(chosen)];
console.log(`[DEBUG-a4f2] patches used: ${Object.keys(chosen).join(",") || "(none)"}`);
console.log(`[DEBUG-a4f2] argv: dsh ${args.map((a) => (a.startsWith("/") ? a.split("/").slice(-1)[0] : a)).join(" ")}`);

// ── 4. Spawn exactly like the platform does.
const childEnv = dshProfile.buildScrubbedEnv() ?? { ...process.env };
for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete childEnv[k];
childEnv.DSH_HOME = home;
childEnv.NODE_PATH = NM;
childEnv.PATH = `${join(NM, ".bin")}:${process.env.PATH}`;

// Capture the child's stderr: it names any plugin that failed to activate.
let log = "";
const { spawn } = await import("node:child_process");
const child = spawn(process.execPath, [BIN, ...args], { cwd: REPO, env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
child.stderr.on("data", (b) => { log += b.toString(); });
child.stdout.on("data", (b) => { log += b.toString(); });

// Drive the handshake exactly as dsh-contracts.mjs does: initialize needs
// cwd/provider/model/agentPreset (a bare initialize with no cwd makes the
// child's own startup path resolve undefined → a paths[0] error that would
// look like a product bug but is a harness artifact).
const initId = 1;
child.stdin.write(`${JSON.stringify({
  jsonrpc: "2.0", id: initId, method: "initialize",
  params: {
    cwd: REPO,
    provider,
    model,
    agentPreset: "standard",
  },
})}\n`);

const HANDSHAKE_MS = 30000;
let initReply = null;
const responded = await new Promise((res) => {
  const t = setTimeout(() => res(false), HANDSHAKE_MS);
  const onData = (b) => {
    const s = b.toString();
    const m = s.match(new RegExp(`\\{"jsonrpc".*?"id":\\s*${initId}[^}]*\\}`));
    if (m) { initReply = s; clearTimeout(t); res(true); }
    else if (new RegExp(`"id":\\s*${initId}`).test(s)) { initReply = s; clearTimeout(t); res(true); }
  };
  child.stdout.on("data", onData);
  child.on("exit", () => { clearTimeout(t); res(false); });
});
try { child.kill("SIGKILL"); } catch { /* gone */ }

const UQ_FAIL = /user-questions[\s\S]{0,600}?(registerProvider|is not a function)/.test(log);
const DEACT = (log.match(/did not activate/g) ?? []).length;
// A reply carrying an error object is NOT a healthy handshake — treating it as
// one would be a false green (the mistake this loop exists to avoid).
const initErrored = Boolean(initReply && /"error"\s*:/.test(initReply));

console.log("── child stderr/stdout (tail) ──");
console.log(log.trim().split("\n").slice(-16).join("\n") || "(empty)");
console.log("── verdict ──");
console.log(`responded=${responded} initErrored=${initErrored} uqActivationFailure=${UQ_FAIL} didNotActivate=${DEACT}`);
if (UQ_FAIL) { console.log("[DEBUG-a4f2] RED — user-questions plugin failed to activate (image symptom)"); process.exit(1); }
if (!responded) { console.log("[DEBUG-a4f2] RED — initialize never answered"); process.exit(1); }
if (initErrored) { console.log("[DEBUG-a4f2] RED — initialize answered with an ERROR (see above)"); process.exit(1); }
if (DEACT > 0) { console.log(`[DEBUG-a4f2] RED — ${DEACT} profile entry/entries failed to activate`); process.exit(1); }
console.log("[DEBUG-a4f2] GREEN — initialize ok, user-questions plugin activated");
process.exit(0);
