#!/usr/bin/env node
// scripts/dsh-contracts.mjs — the dsh-contracts runner (add-dsh-contracts,
// design D1/D2; ADR-0007 upgrade gate).
//
// Candidate mode: run the six v1 contracts against ANY dsh install —
//
//   npm run dsh:contracts                          # the frozen matrix scratch tree
//   npm run dsh:contracts -- --tree /opt/dsh       # an image install
//   npm run dsh:contracts -- --tree <dir> --bin <dsh-path>   # any manual install
//   npm run dsh:contracts -- --fresh               # rebuild the scratch tree
//
// What it does, in order: resolve the candidate tree → materialize an
// ISOLATED throwaway profile home (mkdtemp + the platform's own parameterized
// writers from dsh-profile.js — the temp home is the only DSH_HOME anyone
// sees; a real ~/.dsh or /opt/dsh-home is never touched) → spawn the candidate
// `dsh --profile platform --patch …` through HarnessClient and complete the
// initialize handshake → run every contract from scripts/lib/dsh-contracts/
// contracts.mjs sequentially, each in its own try/catch so one failure cannot
// drag the rest → print the per-contract report → exit 0 only when all pass.
//
// The child's LLM route points at a local dummy endpoint the runner owns:
// contracts assert routing/registration/credential layers, never a real
// upstream (candidate mode must not spend tokens).

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { HarnessClient } from "@deepseek-ai/dsh-sdk-client";
import { CONTRACTS, ensureScratchTree, firstLine, sleep, treeDshVersion, withTimeout } from "./lib/dsh-contracts/contracts.mjs";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HANDSHAKE_BUDGET_MS = 30_000; // design D3
const CONTRACT_TIMEOUT_MS = 60_000;
const SCAFFOLD_FILES = ["package.json", "pnpm-workspace.yaml", "cordis.yml", "cordis.patch.yml"];
const TEMPLATE_DIR = join(REPO_ROOT, "dsh-profile-template");
const PROFILE_NAME = "platform";
const AGENT_PRESET = "standard"; // the platform's DEFAULT_AGENT_PRESET
const INITIAL_KEY = `sk-contracts-initial-${Date.now()}`;

function usage(code) {
  console.log(`usage: node scripts/dsh-contracts.mjs [--tree <install-root>] [--bin <dsh-path>] [--fresh]

  --tree   candidate install root (a dir containing node_modules/); default:
           the dsh-matrix scratch npm-ci tree, cached under node_modules/.cache
  --bin    dsh binary; default <tree>/node_modules/.bin/dsh
  --fresh  force a rebuild of the scratch tree (ignored with --tree)`);
  process.exit(code);
}

function parseArgs(argv) {
  const opts = { fresh: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--tree") opts.tree = argv[++i];
    else if (argv[i] === "--bin") opts.bin = argv[++i];
    else if (argv[i] === "--fresh") opts.fresh = true;
    else if (argv[i] === "--help" || argv[i] === "-h") usage(0);
    else {
      console.error(`unknown argument: ${argv[i]}`);
      usage(2);
    }
  }
  return opts;
}

// The dummy OpenAI-compatible endpoint: records every request's headers (the
// credential-rotation probe reads the Authorization header back) and answers
// with a well-formed completion so the probe turn settles cleanly.
function startDummyLlm() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let json = null;
      try {
        json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        /* non-JSON body */
      }
      requests.push({
        t: Date.now(),
        method: req.method,
        url: req.url,
        auth: req.headers.authorization || "",
        model: json?.model ?? null,
        stream: json?.stream === true,
      });
      if (req.method !== "POST") {
        res.writeHead(404);
        res.end();
        return;
      }
      if (json?.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`${JSON.stringify({ id: "dsh-contracts", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })}\n\n`);
        res.write(`${JSON.stringify({ id: "dsh-contracts", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
        res.end("data: [DONE]\n\n");
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "dsh-contracts",
            object: "chat.completion",
            choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
      }
    });
  });
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      // unref: the endpoint must never be the thing keeping the process alive —
      // an early failure path exits instead of hanging on the listener.
      server.unref();
      resolvePromise({ url: `http://127.0.0.1:${port}/v1`, requests, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

// The initialize handshake with the adapter-registration race retry (same
// pattern as dsh-bridge: the llm-pi-ai adapter registers asynchronously after
// the settings file loads). Everything else fails fast. Under the overall
// 30s budget a hung boot surfaces as a timeout, which IS boot-crash evidence
// for contract ③.
async function handshake(client, params) {
  const deadline = Date.now() + HANDSHAKE_BUDGET_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await withTimeout(client.initialize(params), Math.max(1_000, deadline - Date.now()), "initialize handshake");
      return { ok: true, result };
    } catch (e) {
      const msg = String(e?.message || e);
      if (!/no adapter registered for provider/.test(msg) || Date.now() >= deadline - 500) {
        return { ok: false, error: msg };
      }
      if (attempt === 0) console.log("[dsh-contracts] initialize racing adapter registration; retrying…");
      await sleep(500);
    }
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  // 1. Resolve the candidate tree + bin.
  let tree;
  let treeLabel;
  if (opts.tree) {
    tree = resolve(opts.tree);
    treeLabel = "--tree";
    if (!existsSync(join(tree, "node_modules", "@deepseek-ai", "dsh"))) {
      throw new Error(`${tree} has no node_modules/@deepseek-ai/dsh — pass the install root (the dir npm ci ran in)`);
    }
  } else {
    const scratch = ensureScratchTree({ fresh: opts.fresh });
    tree = scratch.tree;
    treeLabel = scratch.cached ? `matrix scratch tree (cache ${scratch.key})` : `matrix scratch tree (fresh ci ${scratch.key})`;
  }
  const bin = opts.bin || join(tree, "node_modules", ".bin", "dsh");
  if (!existsSync(bin)) {
    throw new Error(`dsh binary not found at ${bin} — pass --bin <path> (for a global install, e.g. --bin $(which dsh))`);
  }

  // 2. Throwaway home + workspace, dummy LLM endpoint.
  const home = mkdtempSync(join(tmpdir(), "dsh-contracts-home-"));
  const workspace = mkdtempSync(join(tmpdir(), "dsh-contracts-ws-"));
  const dummyLlm = await startDummyLlm();
  let client = null;
  let watcher = null;
  let pump = null;
  let currentContract = "(handshake)";

  try {
    // 3. Point EVERYTHING the platform writers read at the temp domain BEFORE
    // importing dsh-profile.js (its module-level DSH_HOME const is how
    // resolveShippedPresetRoot anchors onto the candidate tree). LLM_API_KEY is
    // the dummy key the credentials store seeds and the rotation probe replaces.
    process.env.DSH_HOME = home;
    process.env.LLM_API_KEY = INITIAL_KEY;
    process.env.LLM_PROVIDERS_STORE = join(home, "llm-providers.json");
    process.env.LLM_DEFAULT_STORE = join(home, "llm-default.json");
    process.env.DB_PATH = join(home, "contracts.db");
    process.env.MCP_CONFIG_PATH = join(home, "mcp.json");

    const profileDir = join(home, "profiles", PROFILE_NAME);
    mkdirSync(profileDir, { recursive: true });
    for (const file of SCAFFOLD_FILES) copyFileSync(join(TEMPLATE_DIR, file), join(profileDir, file));
    // Module levels, matching the image layout (/opt/dsh-home):
    //  - profiles/<name>/node_modules → the candidate's whole tree (what the
    //    profile's plugins resolve through — same shape as /opt/dsh);
    //  - profiles/node_modules/@deepseek-ai/dsh → JUST the dsh package. The
    //    profile writer's preset-root anchor resolves through it, and dsh's
    //    boot healer (healProfilesModuleFallback) owns this dir: it keeps a
    //    correct absolute link and fills in the rest of the closure itself.
    //    A whole-dir symlink here makes the leaf a real dir and the healer
    //    refuses to boot ("exists and is not a symlink").
    symlinkSync(join(tree, "node_modules"), join(profileDir, "node_modules"), "dir");
    const dshPkg = join(tree, "node_modules", "@deepseek-ai", "dsh");
    mkdirSync(join(home, "profiles", "node_modules", "@deepseek-ai"), { recursive: true });
    symlinkSync(dshPkg, join(home, "profiles", "node_modules", "@deepseek-ai", "dsh"), "dir");

    const dshProfile = await import(pathToFileURL(join(REPO_ROOT, "dsh-profile.js")).href);
    const dirs = { dshHome: home, profileName: PROFILE_NAME };
    const settingsPath = join(home, "settings.yaml");
    const credentialsPath = join(home, ".credentials.yaml");
    const { providers, models } = await dshProfile.writeLlmProfile({
      dirs,
      llmApiKey: INITIAL_KEY,
      llmBaseUrl: dummyLlm.url,
    });
    await dshProfile.ensureCredentialsStore({ dirs });
    const presetsPatchPath = await dshProfile.writePresetsPatch({ dirs, requireRoster: false });
    const permissionsPatchPath = await dshProfile.writePermissionsPatch();
    const provider = Object.keys(providers)[0];
    const model = models[0]?.id;

    console.log(`dsh-contracts — candidate: ${tree} (${treeLabel}, dsh@${treeDshVersion(tree) ?? "?"})`);
    console.log(`  bin: ${bin}`);
    console.log(`  home: ${home} (throwaway; the real DSH_HOME is never touched)`);
    console.log(`  route: provider=${provider} model=${model} → ${dummyLlm.url} (dummy endpoint, no real upstream)`);

    // 4. Spawn + handshake. The child env inherits ours minus the API key (the
    // credentials file must be the winning layer — the layer the rotation probe
    // exercises) and minus proxy vars (a system proxy would blackhole 127.0.0.1).
    const childEnv = dshProfile.buildScrubbedEnv() ?? { ...process.env };
    for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete childEnv[k];
    const args = ["--profile", PROFILE_NAME, "--patch", presetsPatchPath, "--patch", permissionsPatchPath];
    client = new HarnessClient({
      command: bin,
      args,
      cwd: workspace,
      env: childEnv,
      requestTimeoutMs: CONTRACT_TIMEOUT_MS,
      shutdownTimeoutMs: 5_000,
    });
    client.start();

    const ctx = {
      tree,
      home,
      workspace,
      profileDir,
      settingsPath,
      credentialsPath,
      presetsPatchPath,
      permissionsPatchPath,
      // Contract ②'s declared set: the tree's own lock when it carries one
      // (scratch trees do), else the frozen matrix lock.
      lockPath: existsSync(join(tree, "package-lock.json"))
        ? join(tree, "package-lock.json")
        : join(REPO_ROOT, "dsh-matrix", "package-lock.json"),
      models,
      provider,
      model,
      agentPreset: AGENT_PRESET,
      dummyLlm,
      client,
      handshake: { ok: false, error: "not attempted" },
      bootExit: null, // child died (or boot hung) during the executor handshake
      childExit: null, // child died later: { at: <contract title>, error }
    };

    // Crash watcher: one subscription whose only job is noticing the child died
    // and attributing the exit to whatever was running at the time (design D3).
    watcher = client.subscribe();
    pump = (async () => {
      for (;;) {
        try {
          await watcher.next();
        } catch (e) {
          const error = String(e?.message || e);
          ctx.childExit = { at: currentContract, error };
          if (currentContract === "(handshake)") ctx.bootExit = { at: currentContract, error };
          return;
        }
      }
    })();

    ctx.handshake = await handshake(client, { cwd: workspace, provider, model, agentPreset: AGENT_PRESET });
    if (!ctx.handshake.ok && /timed out/.test(ctx.handshake.error)) {
      // A hung boot is crash-class evidence for ③/⑤ even though nothing exited.
      ctx.bootExit ??= { at: "(handshake)", error: ctx.handshake.error };
    }

    // 5. Run the table. Session contracts gate themselves (requireHandshake);
    // the static ones (②③⑤) run to their own verdicts even on a dead child —
    // a crash-loop candidate still gets honest per-contract reporting.
    const rows = [];
    let failures = 0;
    for (const contract of CONTRACTS) {
      currentContract = contract.title;
      const tag = contract.tags?.length ? ` [${contract.tags.join(",")}]` : "";
      const t0 = Date.now();
      let status;
      let detail;
      let unjudgeable = false;
      try {
        detail = await withTimeout(contract.run(ctx), CONTRACT_TIMEOUT_MS, contract.title);
        status = "PASS";
      } catch (e) {
        status = "FAIL";
        failures += 1;
        detail = firstLine(e);
        unjudgeable = /unavailable without a completed handshake/.test(detail);
        if (ctx.childExit?.at === contract.title) {
          detail += ` — child exit evidence: ${firstLine(ctx.childExit.error)}`;
        }
      }
      rows.push({ contract, status, detail, unjudgeable });
      console.log(`  ${contract.title}${tag} ${status} — ${detail} (${Date.now() - t0}ms)`);
    }

    // 6. Summary + aggregate exit code.
    console.log("");
    const verdict =
      failures === 0 ? `${rows.length}/${rows.length} PASS` : `${rows.length - failures}/${rows.length} PASS, ${failures} FAIL`;
    console.log(`dsh-contracts: ${verdict} — candidate ${tree}`);
    if (!ctx.handshake.ok) {
      console.log(
        `  handshake did not complete (${firstLine(ctx.handshake.error)}): the session contracts are marked unjudgeable, not independently red`,
      );
    }
    for (const { contract, status, unjudgeable: unj } of rows) {
      if (status === "FAIL" && contract.tags?.includes("internal-API") && !unj) {
        console.log(
          `  ${contract.title} carries the internal-API tag: upstream changed an internal surface — evaluate an alternative or pin, this is not automatically a "cannot follow" verdict`,
        );
      }
    }
    return failures === 0 ? 0 : 1;
  } finally {
    currentContract = "(shutdown)";
    try {
      await watcher?.close();
    } catch {
      /* already failed */
    }
    pump?.catch(() => {});
    try {
      await client?.close();
    } catch {
      /* the close ladder is best-effort */
    }
    await dummyLlm.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
}

process.on("SIGINT", () => {
  console.log("\n[dsh-contracts] interrupted");
  // The finally ladder in main() owns cleanup; give it a beat then hard-exit.
  setTimeout(() => process.exit(130), 300);
});

try {
  process.exitCode = await main();
} catch (e) {
  console.error(`[dsh-contracts] ${firstLine(e)}`);
  process.exitCode = 2;
}
