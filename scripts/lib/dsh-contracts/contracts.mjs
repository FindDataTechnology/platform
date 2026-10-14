// scripts/lib/dsh-contracts/contracts.mjs — the dsh contracts table + scratch
// tree cache (add-dsh-contracts, design D1/D2/D5).
//
// CONTRACTS is a flat table of { id, title, tags?, run(ctx) } functions: each
// one asserts ONE upstream dsh behavior the platform depends on, against the
// candidate install the executor resolved. The executor (scripts/dsh-contracts.mjs)
// owns the child process, the handshake and the crash attribution; a run()
// body fails by throwing (its message IS the report's failure reason) and
// passes by returning a short detail string. No test framework, no Playwright
// — the suite must run anywhere node + the repo's runtime deps exist,
// including inside the built image (design D1).
//
// Contracts ①④⑥ ride the live session (ctx.client); ②③⑤ are static file
// assertions plus boot-crash evidence the executor records in ctx — so a
// candidate whose handshake dies still gets honest per-contract verdicts.

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { atomicWriteTextSync } from "../../../lib/persistence.js";
import { diffMatrixTree } from "../../../lib/dsh-matrix-verify.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const MATRIX_DIR = join(REPO_ROOT, "dsh-matrix");
// D5: the scratch npm ci (~500 packages) is cached under node_modules/.cache,
// keyed by a hash of everything that defines the tree. `--fresh` rebuilds.
const CACHE_ROOT = join(REPO_ROOT, "node_modules", ".cache", "dsh-contracts-tree");
const MATRIX_FILES = ["package.json", "package-lock.json", ".npmrc"];

// The four scaffold files a profile boots from (same list the Dockerfile
// copies into /opt/dsh-home/profiles/platform — dsh-profile.js SCAFFOLD_FILES).
const SCAFFOLD_FILES = ["package.json", "pnpm-workspace.yaml", "cordis.yml", "cordis.patch.yml"];

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// First line of an error message — keeps one-line report rows readable while
// the executor keeps the full text for the crash tail.
export function firstLine(err) {
  return String(err?.message || err).split("\n")[0];
}

export function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// Poll fn() every intervalMs until it returns truthy or the deadline passes.
// Returns the truthy value, or null on timeout (the caller names the miss).
export async function pollUntil(fn, { timeoutMs, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await fn();
    if (r) return r;
    if (Date.now() >= deadline) return null;
    await sleep(intervalMs);
  }
}

// ── Scratch tree materialization (D5) ────────────────────────────────────────

// The dsh version inside a tree (report header); null when the tree has no
// @deepseek-ai/dsh — the executor refuses such trees before this is called.
export function treeDshVersion(tree) {
  try {
    return JSON.parse(readFileSync(join(tree, "node_modules", "@deepseek-ai", "dsh", "package.json"), "utf8")).version;
  } catch {
    return null;
  }
}

// Resolve a batch of specs with the ESM resolver anchored at `anchorDir`
// (inside the candidate tree). import.meta.resolve on current Node ignores its
// parent argument (it resolves from the CALLING module), so the probe is a
// child node whose cwd — and therefore its [eval] module referrer — is the
// anchor dir. Real ESM semantics (exports maps), no module code executes. One
// spawn per batch, memoized per anchor+specs.
//
// Returns Map<spec, string|null>; a null value means ERR_MODULE_NOT_FOUND or a
// sibling resolution error (the caller names the package — that error is the
// contract's finding). Containment is NOT checked here — see
// assertResolvedInsideTree.
const PROBE_SCRIPT = `
import { readFileSync } from "node:fs";
const specs = JSON.parse(process.env.DSH_CONTRACTS_SPECS);
const out = {};
for (const spec of specs) {
  try {
    out[spec] = import.meta.resolve(spec);
  } catch (e) {
    out[spec] = { error: e.code || String(e.message).split("\\n")[0] };
  }
}
process.stdout.write(JSON.stringify(out));
`;

const probeCache = new Map();

export function resolveBatchInTree(anchorDir, specs) {
  const key = `${anchorDir}\0${specs.join("\0")}`;
  if (probeCache.has(key)) return probeCache.get(key);
  // process.execPath can be stale (a brew node since upgraded away) — fall
  // back to PATH lookup when the recorded binary no longer exists.
  const nodeBin = existsSync(process.execPath) ? process.execPath : "node";
  const res = spawnSync(nodeBin, ["--input-type=module", "-e", PROBE_SCRIPT], {
    cwd: anchorDir,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, DSH_CONTRACTS_SPECS: JSON.stringify(specs), NODE_OPTIONS: "" },
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`resolution probe for ${anchorDir} failed (status ${res.status}): ${String(res.stderr).split("\n")[0]}`);
  }
  const parsed = JSON.parse(res.stdout);
  const map = new Map(specs.map((s) => [s, typeof parsed[s] === "string" ? parsed[s] : null]));
  probeCache.set(key, map);
  return map;
}

// A resolved spec must stay inside the candidate tree — an ancestor install
// (the repo's own node_modules for a cached scratch tree) resolving the name
// would mask a missing package, which is exactly the peer-gap the contract
// exists to catch. The resolved URL is realpathed by Node (/tmp → /private/tmp
// on macOS), so the tree root must be realpathed for the comparison.
// Returns the resolved path, throws on violation.
export function assertResolvedInsideTree(tree, spec, resolvedUrl) {
  const p = resolve(fileURLToPath(resolvedUrl));
  let root;
  try {
    root = realpathSync(resolve(tree));
  } catch {
    root = resolve(tree);
  }
  if (p !== root && !p.startsWith(root + sep)) {
    throw new Error(`${spec} resolves outside the candidate tree (${p}) — an ancestor install is shadowing it`);
  }
  return p;
}

// The declared package set of a lockfile (lockfileVersion 3): every packages
// entry except the root, platform-gated the same way dsh-matrix-verify gates
// (os/cpu-locked binary packages install per-platform, not per-lock). Each
// entry carries its lock key and the ANCHOR it must resolve from: nested
// entries ("node_modules/A/node_modules/B") are resolvable only from the
// nesting package A's directory — that is where A's own imports run.
// anchorRel "" means the tree root.
export function declaredEntries(lockPath) {
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  // The prune list next to the matrix lock (same matcher the boot gate uses):
  // pruned names are exempt from the resolvability assertion — the tree
  // deliberately does not carry them (ADR-0023 D2). Anchor-aware: a lock
  // entry NESTED under a pruned package (e.g. fflate under libreoffice-kit)
  // leaves with its anchor, so it is exempt too.
  const pruneIndex = (() => {
    let patterns = [];
    try {
      const { prune = [] } = JSON.parse(readFileSync(join(MATRIX_DIR, "prune.json"), "utf8"));
      patterns = prune.flatMap((e) => e?.match ?? []);
    } catch { /* no list — nothing is pruned */ }
    if (patterns.length === 0) return null;
    const matches = (name) => patterns.some((p) => (p.endsWith("*") ? name.startsWith(p.slice(0, -1)) : name === p));
    const prunedKeys = Object.keys(lock.packages ?? {}).filter((key) => {
      const idx = key.lastIndexOf("node_modules/");
      return idx !== -1 && matches(key.slice(idx + "node_modules/".length));
    });
    return (key, name) => matches(name) || prunedKeys.some((p) => key.startsWith(`${p}/node_modules/`));
  })();
  const entries = [];
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (!key || !entry.version) continue;
    const idx = key.lastIndexOf("node_modules/");
    if (idx === -1) continue;
    if (entry.os && !entry.os.includes(process.platform)) continue;
    if (entry.cpu && !entry.cpu.includes(process.arch)) continue;
    const name = key.slice(idx + "node_modules/".length);
    if (pruneIndex?.(key, name)) continue;
    const anchorRel = idx === 0 ? "" : key.slice(0, idx - 1); // "node_modules/A"
    entries.push({ name, key, version: entry.version, anchorRel });
  }
  return entries;
}

// Ensure a scratch npm-ci tree of the frozen matrix exists in the cache.
// A cached tree is re-verified against the lock with the boot hard gate's own
// differ (cheap walk) so a poisoned/partial cache self-heals into a rebuild.
export function ensureScratchTree({ fresh = false } = {}) {
  const hash = createHash("sha256");
  for (const f of MATRIX_FILES) hash.update(readFileSync(join(MATRIX_DIR, f)));
  hash.update("\0");
  const key = hash.digest("hex").slice(0, 16);
  const tree = join(CACHE_ROOT, key);
  const marker = join(tree, ".dsh-contracts-tree.json");

  if (!fresh && existsSync(marker) && existsSync(join(tree, "node_modules", "@deepseek-ai", "dsh"))) {
    // Idempotent prune FIRST: a cached tree may predate a prune-list change,
    // and the (prune-aware) diff below must not read deliberate absences as
    // cache poisoning.
    const pr = spawnSync(process.execPath, [join(MATRIX_DIR, "prune.mjs"), "--tree", tree], { stdio: "inherit" });
    if (pr.status !== 0) throw new Error(`prune for the cached scratch tree failed (status ${pr.status})`);
    const diff = diffMatrixTree(join(MATRIX_DIR, "package-lock.json"), tree);
    if (diff.ok) return { tree, cached: true, key };
    console.log(`[dsh-contracts] cached scratch tree ${key} deviates from the lock — rebuilding:\n${diff.report}`);
  }

  rmSync(tree, { recursive: true, force: true });
  mkdirSync(tree, { recursive: true });
  for (const f of MATRIX_FILES) copyFileSync(join(MATRIX_DIR, f), join(tree, f));
  console.log(`[dsh-contracts] scratch tree ${key}: npm ci from dsh-matrix (a few minutes on a cold cache)…`);
  const res = spawnSync("npm", ["ci", "--prefix", tree], { stdio: "inherit" });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`npm ci for the scratch tree failed (status ${res.status})`);
  // The scratch tree mirrors what ships: pruned to the same shape as /opt/dsh
  // (ADR-0023 D2), so every default contract run validates the pruned tree.
  const pr = spawnSync(process.execPath, [join(MATRIX_DIR, "prune.mjs"), "--tree", tree], { stdio: "inherit" });
  if (pr.status !== 0) throw new Error(`prune for the scratch tree failed (status ${pr.status})`);
  writeFileSync(marker, `${JSON.stringify({ key, createdAt: new Date().toISOString(), source: "dsh-matrix" }, null, 2)}\n`);
  return { tree, cached: false, key };
}

// ── Small shared helpers ─────────────────────────────────────────────────────

// Session-riding contracts are unjudgeable without the handshake — the design
// calls this "握手失败即全组不可判": report the handshake error as THEIR reason
// instead of a cascade of transport noise.
function requireHandshake(ctx) {
  if (!ctx.handshake?.ok) throw new Error(`unavailable without a completed handshake: ${firstLine(ctx.handshake?.error)}`);
  if (ctx.childExit) throw new Error(`child already exited (${ctx.childExit.at}): ${firstLine(ctx.childExit.error)}`);
}

// ── Contract ① boot / handshake / roster ─────────────────────────────────────

async function contractBootHandshakeRoster(ctx) {
  requireHandshake(ctx);
  const info = ctx.handshake.result?.serverInfo;
  if (info?.name !== "deepseek-harness-sdk-runtime") {
    throw new Error(`unexpected server identity ${JSON.stringify(info)} — the wire contract changed`);
  }
  if (!Array.isArray(ctx.models) || ctx.models.length === 0) {
    throw new Error("the settings-declared model roster is empty — nothing projected to the child");
  }
  // A non-empty catalog is what registers the route adapter, and the handshake
  // itself passed with provider=<settings route> (initialize rejects with
  // "no adapter registered" when the llm-pi-ai section did not load) — so a
  // completed handshake + non-empty declared catalog IS the roster projection.
  const presets = await ctx.client.request("presets/list", {});
  if (!Array.isArray(presets)) throw new Error(`presets/list returned ${typeof presets}, expected an array`);
  return `serverInfo ${info.name}@${info.version}; ${ctx.models.length} declared model(s) (adapter for "${ctx.provider}" registered); presets/list callable → ${presets.length} row(s)`;
}

// ── Contract ② closure resolvable ────────────────────────────────────────────

async function contractClosureResolvable(ctx) {
  const entries = declaredEntries(ctx.lockPath);
  if (entries.length === 0) throw new Error(`no declared packages found in ${ctx.lockPath}`);

  // Group entries by anchor (tree root or a nesting package's dir) — one
  // resolution probe per anchor.
  const byAnchor = new Map();
  for (const e of entries) {
    if (!byAnchor.has(e.anchorRel)) byAnchor.set(e.anchorRel, []);
    byAnchor.get(e.anchorRel).push(e);
  }

  const failures = [];
  let byEntry = 0;
  let byPackageJson = 0;
  let presentOnly = 0;
  for (const [anchorRel, group] of byAnchor) {
    const anchor = anchorRel ? join(ctx.tree, anchorRel) : ctx.tree;
    if (!existsSync(anchor)) {
      // The lock declares a nested location (its nesting package) that does
      // not exist in this candidate at all — every entry under it is missing,
      // named as such instead of crashing the probe on a nonexistent cwd.
      for (const e of group) failures.push(`${e.name}: anchor ${anchorRel} missing from the candidate tree`);
      continue;
    }
    const resolved = resolveBatchInTree(anchor, group.map((e) => e.name));
    // Second form for entry-point-less packages: package.json as a subpath.
    const unresolved = group.filter((e) => !resolved.get(e.name));
    const fallback = unresolved.length
      ? resolveBatchInTree(anchor, unresolved.map((e) => `${e.name}/package.json`))
      : new Map();
    for (const e of group) {
      const url = resolved.get(e.name);
      if (url) {
        try {
          assertResolvedInsideTree(ctx.tree, e.name, url);
          byEntry += 1;
        } catch (err) {
          failures.push(`${e.key}: ${firstLine(err)}`);
        }
        continue;
      }
      const fallbackUrl = fallback.get(`${e.name}/package.json`);
      if (fallbackUrl) {
        try {
          assertResolvedInsideTree(ctx.tree, e.name, fallbackUrl);
          byPackageJson += 1;
        } catch (err) {
          failures.push(`${e.key}: ${firstLine(err)}`);
        }
        continue;
      }
      // Neither form resolves: an installed binary-only package (sharp's
      // @img/* — exports maps that deliberately expose no "." and no
      // ./package.json) is installed integrity, not import face. Presence at
      // the lock-declared location is the honest verdict for those; anything
      // else is the ERR_MODULE_NOT_FOUND the boot would hit mid-session.
      if (existsSync(join(ctx.tree, e.key, "package.json"))) {
        presentOnly += 1;
        continue;
      }
      failures.push(`${e.name}: ERR_MODULE_NOT_FOUND`);
    }
  }
  if (failures.length) {
    throw new Error(
      `${failures.length}/${entries.length} lock-declared packages do not resolve inside the tree — first: ${failures.slice(0, 5).join("; ")}`,
    );
  }
  return (
    `${entries.length}/${entries.length} lock-declared entries resolve inside the tree ` +
    `(${byEntry} by entry, ${byPackageJson} by package.json, ${presentOnly} binary-only present; ` +
    `${byAnchor.size} anchor group(s); lock: ${basename(ctx.lockPath)})`
  );
}

// ── Contract ③ hmr family generation ────────────────────────────────────────

// Since the unified-generation jump (ADR-0023), hmr ships as the in-family
// @deepseek-ai/dsh-hmr at the pinned lockstep version; the historical
// cordis-plugin-hmr <1.0.17 registerConfig pin retired with that package (the
// 0.2.0 family hard-depends every plugin, so an off-generation hmr can no
// longer float in through peer resolution — the contract now pins the family
// row and the boot stability it used to guard).
async function contractHmrRegisterConfig(ctx) {
  const expected = JSON.parse(readFileSync(join(REPO_ROOT, "dsh-matrix", "package.json"), "utf8"))
    .dependencies["@deepseek-ai/dsh"];
  const HMR_SPEC = "@deepseek-ai/dsh-hmr/package.json";
  let version;
  const url = resolveBatchInTree(ctx.tree, [HMR_SPEC]).get(HMR_SPEC);
  try {
    if (!url) throw new Error("ERR_MODULE_NOT_FOUND");
    const pkgPath = assertResolvedInsideTree(ctx.tree, HMR_SPEC, url);
    version = JSON.parse(readFileSync(pkgPath, "utf8")).version;
  } catch (e) {
    throw new Error(`cannot resolve/read @deepseek-ai/dsh-hmr in the candidate tree: ${firstLine(e)}`);
  }
  if (version !== expected) {
    throw new Error(
      `@deepseek-ai/dsh-hmr@${version} ≠ intent-pinned generation ${expected} — the hmr family row must resolve at the lockstep version the matrix manifest pins`,
    );
  }
  const crash = ctx.bootExit ?? ctx.childExit;
  if (crash && /watchUserPatches|registerConfig|dsh-hmr/i.test(crash.error)) {
    throw new Error(`the family row holds (${version}) but the child still crashed at boot with an hmr signature: ${firstLine(crash.error)}`);
  }
  return `@deepseek-ai/dsh-hmr@${version} = intent generation ${expected}; no boot crash (hmr family contract intact)`;
}

// ── Contract ④ settings/credentials hot-reload ───────────────────────────────

const HOT_ROUTE = "volces-hot";
const HOT_MODEL = "contracts-hot-model";
const HOT_SESSION = "contracts-hot-reload";

// 0.2.0 (D7.1): settings live as the llm-pi-ai row in the profile's OWN
// patch file (ctx.settingsPath points there) — the one dsh-hmr watches, so a
// mid-session row edit hot-applies. Upsert a provider into that row.
function upsertHotRouteProvider(ctx) {
  const rows = yaml.load(readFileSync(ctx.settingsPath, "utf8")) ?? [];
  if (!Array.isArray(rows)) throw new Error(`${ctx.settingsPath} is not an entry list`);
  let row = rows.find((r) => r?.id === "llm-pi-ai" && !r.insert);
  if (!row) {
    row = { id: "llm-pi-ai", name: "@deepseek-ai/dsh-llm-pi-ai", config: {} };
    rows.push(row);
  }
  row.config.providers = row.config.providers ?? {};
  row.config.providers[HOT_ROUTE] = {
    apiKeyEnv: "LLM_API_KEY",
    displayName: "Contracts Hot Route",
    api: "openai-completions",
    baseURL: ctx.dummyLlm.url,
    models: [{ id: HOT_MODEL, name: "Contracts Hot Model", contextWindow: 8192, maxTokens: 1024, input: ["text"] }],
  };
  atomicWriteTextSync(ctx.settingsPath, yaml.dump(rows));
}

async function contractSettingsHotReload(ctx) {
  requireHandshake(ctx);

  // (a) settings hot-reload: a provider route written into the profile
  // patch's llm-pi-ai row MID-SESSION must register its adapter without a
  // child restart. Observed through re-initialize onto the new route:
  // initialize rejects with "no adapter registered for provider" until the
  // watched patch has reconciled, then succeeds.
  upsertHotRouteProvider(ctx);
  const t0 = Date.now();
  const landed = await pollUntil(
    async () => {
      try {
        await ctx.client.request("initialize", {
          cwd: ctx.workspace,
          provider: HOT_ROUTE,
          model: HOT_MODEL,
          agentPreset: ctx.agentPreset,
        });
        return true;
      } catch (e) {
        if (!/no adapter registered for provider/.test(String(e?.message))) throw e;
        return false;
      }
    },
    { timeoutMs: 10_000, intervalMs: 500 },
  );
  if (!landed) {
    throw new Error(`the hot-written llm-pi-ai route "${HOT_ROUTE}" never registered within 10s — the profile patch is not live-reloading`);
  }
  const hotMs = Date.now() - t0;
  // Restore the session route for the contracts that follow.
  await ctx.client.request("initialize", {
    cwd: ctx.workspace,
    provider: ctx.provider,
    model: ctx.model,
    agentPreset: ctx.agentPreset,
  });

  // (b) credential rotation: rewrite .credentials.yaml mid-session and prove
  // the NEW key is what the child sends. The dummy endpoint records the
  // Authorization header of the one (free, local) completion request the
  // probe turn makes — no real upstream is ever contacted.
  const rotated = `sk-contracts-rotated-${Date.now()}`;
  const cred = yaml.load(readFileSync(ctx.credentialsPath, "utf8")) ?? {};
  cred.version = 1;
  cred.refs = cred.refs ?? {};
  cred.refs.LLM_API_KEY = rotated;
  atomicWriteTextSync(ctx.credentialsPath, yaml.dump(cred));
  try {
    chmodSync(ctx.credentialsPath, 0o600);
  } catch {
    /* perms best-effort */
  }
  const rotatedAt = Date.now();
  // The rotation probe must survive the credentials watcher's reload window:
  // once streams complete instantly (the dummy's SSE is well-formed), the
  // FIRST post-rotation prompt can still race the file watcher and go out with
  // the old key — re-prompt within the window until the rotated key appears
  // (the old retry-ladder timing masked this; the contract now owns it).
  let seen = null;
  for (let attempt = 1; attempt <= 5 && !seen; attempt++) {
    await ctx.client.prompt(HOT_SESSION, [
      { type: "text", text: `dsh-contracts credential rotation probe #${attempt} (one request to the dummy endpoint)` },
    ]);
    seen = await pollUntil(
      () => ctx.dummyLlm.requests.find((r) => r.t >= rotatedAt && r.auth === `Bearer ${rotated}`) ?? null,
      { timeoutMs: 4_000, intervalMs: 400 },
    );
  }
  if (!seen) {
    const auths = [...new Set(ctx.dummyLlm.requests.filter((r) => r.t >= rotatedAt).map((r) => r.auth || "(none)"))];
    throw new Error(
      `the rotated credential never reached the LLM request within the reload window (Authorization seen: ${auths.join(", ") || "none"}) — .credentials.yaml is not re-resolving per request`,
    );
  }
  return `hot provider route registered in ~${hotMs}ms without a restart; rotated credential visible on the wire (request #${ctx.dummyLlm.requests.indexOf(seen) + 1})`;
}

// ── Contract ⑤ patch semantics + scaffold ────────────────────────────────────

async function contractPatchSemanticsScaffold(ctx) {
  // Structure (handshake-independent): the four scaffold files the profile
  // boots from, and both overlays in their disable+insert shape.
  const missing = SCAFFOLD_FILES.filter((f) => !existsSync(join(ctx.profileDir, f)));
  if (missing.length) throw new Error(`profile scaffold incomplete — missing ${missing.join(", ")}`);
  const presets = yaml.load(readFileSync(ctx.presetsPatchPath, "utf8"));
  if (!presets?.some((r) => r?.id === "sdk-jsonrpc-server" && r?.disabled === true)) {
    throw new Error("presets.patch.yml has no {id: sdk-jsonrpc-server, disabled: true} row — the stock server is not disabled");
  }
  if (!presets.some((r) => (r?.insert ?? []).some((e) => e?.id === "platform-sdk-server"))) {
    throw new Error("presets.patch.yml does not insert the platform-sdk-server row");
  }
  const perms = yaml.load(readFileSync(ctx.permissionsPatchPath, "utf8"));
  if (!perms?.some((r) => r?.id === "platform-sdk-server" && r?.disabled === true)) {
    throw new Error("permissions.patch.yml has no {id: platform-sdk-server, disabled: true} row");
  }
  if (!perms.some((r) => (r?.insert ?? []).some((e) => e?.id === "platform-permission-server"))) {
    throw new Error("permissions.patch.yml does not insert the platform-permission-server row");
  }

  // Semantics: a completed boot IS the scaffold+overlays being loaded (dsh
  // fails loudly on a missing scaffold or a duplicate loader entry id). A boot
  // crash fails here with its tail; scaffold-missing signatures called out.
  const crash = ctx.bootExit ?? ctx.childExit;
  if (crash) {
    const scaffoldish = /duplicate loader entry|ENOENT|ERR_MODULE_NOT_FOUND|not found/i.test(crash.error);
    throw new Error(
      `boot did not complete cleanly — ${firstLine(crash.error)}${scaffoldish ? " (the tail matches loader/scaffold-missing signatures)" : ""}`,
    );
  }
  return "scaffold 4/4 loaded; disable+insert overlays applied (stock sdk-jsonrpc-server off, platform rows on — behavioral proof rides ⑥)";
}

// ── Contract ⑥ platform SDK RPC surface (internal-API) ───────────────────────

const PERM_SESSION = "contracts-permissions";

async function contractPlatformSdkRpc(ctx) {
  requireHandshake(ctx);

  // presets/list — the web picker's roster.
  const presets = await ctx.client.request("presets/list", {});
  if (!Array.isArray(presets) || presets.length === 0) {
    throw new Error(`presets/list returned ${JSON.stringify(presets)?.slice(0, 120)} — expected a non-empty roster array`);
  }
  for (const p of presets) {
    if (typeof p?.id !== "string" || typeof p?.name !== "string" || typeof p?.trust !== "string") {
      throw new Error(`presets/list row breaks the platform shape {id,name,description,trust}: ${JSON.stringify(p)}`);
    }
  }

  // permissions/list — the mode selector's roster plus the live current.
  const perms = await ctx.client.request("permissions/list", {});
  if (!perms || !Array.isArray(perms.options)) {
    throw new Error(`permissions/list returned ${JSON.stringify(perms)?.slice(0, 120)} — expected {options, current}`);
  }
  if (perms.options.length < 3) {
    throw new Error(
      `permissions/list offers ${perms.options.length} option(s) — the platform selector expects the full preset table (read-only / workspace-write / danger-full-access)`,
    );
  }
  for (const o of perms.options) {
    if (typeof o?.name !== "string" || typeof o?.label !== "string") {
      throw new Error(`permissions option breaks the {name,label} shape: ${JSON.stringify(o)}`);
    }
  }
  if (perms.current != null && typeof perms.current !== "string") {
    throw new Error(`permissions/list current is ${typeof perms.current}, expected string|null`);
  }

  // permissions/set — PermissionPresetService.set on the LIVE session, no
  // child restart. This is the one internal API the platform depends on; if
  // upstream renames or removes the underlying interface, this is where it
  // becomes visible (the internal-API tag on this row says "evaluate an
  // alternative or pin", not "cannot follow").
  const target = perms.options.find((o) => o.name !== perms.current)?.name ?? perms.options[0].name;
  const setRes = await ctx.client.request("permissions/set", { sessionId: PERM_SESSION, name: target });
  if (setRes?.current !== target) {
    throw new Error(`permissions/set returned ${JSON.stringify(setRes)} — expected {current: "${target}"}`);
  }
  const after = await ctx.client.request("permissions/list", { sessionId: PERM_SESSION });
  if (after?.current !== target) {
    throw new Error(
      `the live session still reports "${after?.current}" after permissions/set("${target}") — the preset did not apply without a restart`,
    );
  }

  // Unknown names must REJECT (the selector renders the error surface).
  let unknownRejected = false;
  try {
    await ctx.client.request("permissions/set", { sessionId: PERM_SESSION, name: "contracts-no-such-permission" });
  } catch {
    unknownRejected = true;
  }
  if (!unknownRejected) {
    throw new Error('permissions/set accepted unknown preset "contracts-no-such-permission" — the error contract is gone');
  }

  return `presets/list → ${presets.length} row(s); permissions/list → ${perms.options.length} option(s) (current "${perms.current ?? "—"}"); permissions/set applied "${target}" to a live session without restart`;
}

// ── Contracts ⑦⑧⑨ (live-runtime-control) ────────────────────────────────────
// The three live-control RPCs the platform bridge template adds over the SDK
// surface. They are dsh-agent PUBLIC exports consumed through our plugin — not
// internal-API — but the rc cadence still needs them pinned like the rest.

// The last session.status value seen for one session id.
function lastStatus(ctx, sessionId) {
  let status = null;
  for (const n of ctx.notifications ?? []) {
    if (n?.method === "session.status" && n?.params?.sessionId === sessionId) {
      status = n.params.status;
    }
  }
  return status;
}

// Idempotent hot-route write (contract ④'s shape — that contract may already
// have written it; rewriting the same doc is a no-op reload).
function ensureHotRoute(ctx) {
  const rows = yaml.load(readFileSync(ctx.settingsPath, "utf8")) ?? [];
  const row = (Array.isArray(rows) ? rows : []).find((r) => r?.id === "llm-pi-ai" && !r.insert);
  if (row?.config?.providers?.[HOT_ROUTE]?.models?.some((m) => m?.id === HOT_MODEL)) return;
  upsertHotRouteProvider(ctx);
}

async function contractLiveModelSet(ctx) {
  requireHandshake(ctx);
  const caps = await ctx.client.request("platform/capabilities");
  if (!Array.isArray(caps?.methods) || !caps.methods.includes("model/set")) {
    throw new Error(`platform/capabilities does not list model/set (got ${JSON.stringify(caps)}) — template without live control`);
  }
  ensureHotRoute(ctx);
  const S = "contracts-live-model";
  // Baseline: one request on the default model (also proves the session runs).
  await ctx.client.prompt(S, [{ type: "text", text: "live-model baseline probe" }]);
  const baseline = await pollUntil(
    () => ctx.dummyLlm.requests.find((r) => r.model === ctx.model) ?? null,
    { timeoutMs: 15_000, intervalMs: 400 },
  );
  if (!baseline) throw new Error("baseline prompt never reached the dummy endpoint");
  // Live switch: fast, and the adapter may still be registering (contract ④'s
  // reload window) — a "no adapter" answer is retried within the budget.
  let res = null;
  const switched = await pollUntil(
    async () => {
      try {
        res = await ctx.client.request("model/set", { sessionId: S, provider: HOT_ROUTE, model: HOT_MODEL });
        return true;
      } catch (e) {
        if (!/no adapter registered for provider/.test(String(e?.message))) throw e;
        return false;
      }
    },
    { timeoutMs: 15_000, intervalMs: 500 },
  );
  const t0 = ctx.dummyLlm.requests.length;
  if (!switched || res?.ok !== true) {
    throw new Error(`model/set failed: ${JSON.stringify(res)}`);
  }
  if (ctx.childExit) throw new Error(`child exited after model/set (${ctx.childExit.at}) — the live switch must not restart`);
  // The NEXT request on the session must run on the new model.
  await ctx.client.prompt(S, [{ type: "text", text: "live-model switched probe" }]);
  const onNext = await pollUntil(
    () => (ctx.dummyLlm.requests.slice(t0).some((r) => r.model === HOT_MODEL) ? true : null),
    { timeoutMs: 20_000, intervalMs: 400 },
  );
  if (!onNext) {
    const models = ctx.dummyLlm.requests.slice(t0).map((r) => r.model);
    throw new Error(
      `the request after model/set ran on ${JSON.stringify(models)} — the live selection did not take effect (model/set said ${JSON.stringify(res)})`,
    );
  }
  // Unknown provider must reject (the host's error surface).
  let badRejected = false;
  try {
    await ctx.client.request("model/set", { sessionId: S, provider: "contracts-no-such-route", model: "x" });
  } catch {
    badRejected = true;
  }
  if (!badRejected) throw new Error('model/set accepted an unregistered provider "contracts-no-such-route"');
  // Leave the shared session on the default model.
  await ctx.client.request("model/set", { sessionId: S, provider: ctx.provider, model: ctx.model });
  return `model/set flipped the live route to ${HOT_MODEL} without a restart; the next request ran on it; unknown providers reject`;
}

async function contractSessionCancel(ctx) {
  requireHandshake(ctx);
  const caps = await ctx.client.request("platform/capabilities");
  if (!Array.isArray(caps?.methods) || !caps.methods.includes("session/cancel")) {
    throw new Error(`platform/capabilities does not list session/cancel (got ${JSON.stringify(caps)})`);
  }
  const S = "contracts-cancel";
  await ctx.client.prompt(S, [{ type: "text", text: "cancel probe [HOLD]" }]);
  const parked = await pollUntil(
    () => (ctx.dummyLlm.heldCount() >= 1 ? true : null),
    { timeoutMs: 15_000, intervalMs: 300 },
  );
  if (!parked) throw new Error("the held prompt never reached the dummy endpoint");
  const before = ctx.dummyLlm.requests.length;
  const res = await ctx.client.request("session/cancel", { sessionId: S });
  if (res?.ok !== true) throw new Error(`session/cancel returned ${JSON.stringify(res)}`);
  // The aborted session must converge to idle (the RPC awaits it, bounded).
  const idle = await pollUntil(
    () => (lastStatus(ctx, S) === "idle" ? true : null),
    { timeoutMs: 15_000, intervalMs: 300 },
  );
  if (!idle) throw new Error(`session ${S} never reported idle after cancel (last: ${lastStatus(ctx, S)})`);
  // And it must accept a NEW prompt immediately — a cancelled session that
  // wedges is worse than no cancel at all.
  await ctx.client.prompt(S, [{ type: "text", text: "after cancel" }]);
  const dispatched = await pollUntil(
    () => (ctx.dummyLlm.requests.length > before ? true : null),
    { timeoutMs: 15_000, intervalMs: 300 },
  );
  if (!dispatched) throw new Error("the post-cancel prompt never dispatched — the session wedged after cancel");
  await pollUntil(() => (lastStatus(ctx, S) === "idle" ? true : null), { timeoutMs: 15_000, intervalMs: 300 });
  ctx.dummyLlm.release();
  // Cancel on an idle session is a successful no-op.
  const noop = await ctx.client.request("session/cancel", { sessionId: S });
  if (noop?.ok !== true) throw new Error(`idle-session cancel returned ${JSON.stringify(noop)}`);
  return "session/cancel aborted the in-flight turn; the session reached idle, accepted the next prompt, and idle-cancel is a no-op";
}

async function contractMultiSessionConcurrency(ctx) {
  requireHandshake(ctx);
  const A = "contracts-multi-a";
  const B = "contracts-multi-b";
  const before = ctx.dummyLlm.requests.length;
  // A's turn parks at the dummy (in flight). The platform-facing contract:
  // ANOTHER session's prompt is not rejected or starved at DISPATCH — its
  // request reaches the adapter while the first session's turn is open. (The
  // stricter "both turns close interleaved" does NOT hold on rc.2: turn close
  // starves while another session's request is parked — recorded as a known
  // upstream limitation in wire-dsh-live-runtime-control's design; the
  // platform's host runs one turn at a time and consumes cancel ⑧ for the
  // switch path, so close-interleaving is not a dependency.)
  await ctx.client.prompt(A, [{ type: "text", text: "multi A [HOLD]" }]);
  await pollUntil(() => (ctx.dummyLlm.heldCount() >= 1 ? true : null), { timeoutMs: 15_000, intervalMs: 300 });
  await ctx.client.prompt(B, [{ type: "text", text: "multi B" }]);
  const bDispatched = await pollUntil(
    () => (ctx.dummyLlm.requests.length > before + 1 ? true : null),
    { timeoutMs: 20_000, intervalMs: 300 },
  );
  const sawBRunning = await pollUntil(
    () => (lastStatus(ctx, B) === "running" ? true : null),
    { timeoutMs: 5_000, intervalMs: 200 },
  );
  const statuses = (ctx.notifications ?? [])
    .filter((n) => n?.method === "session.status" && (n?.params?.sessionId === A || n?.params?.sessionId === B))
    .map((n) => `${n.params.sessionId === A ? "A" : "B"}:${n.params.status}`);
  if (!bDispatched) throw new Error(`B's prompt never dispatched while A's turn was in flight (statuses=[${statuses.join(" ")}])`);
  if (!sawBRunning) throw new Error(`B's driver never started while A's turn was in flight (statuses=[${statuses.join(" ")}])`);
  // Cleanup (not an assertion): release the parked request, then cancel any
  // still-open driver — rc.2's close does not freely interleave with another
  // session's in-flight request (observed non-deterministically wedging even
  // after release), so convergence is a known limitation the spec records,
  // not a contract. ⑧ owns the cancel-converges guarantee.
  ctx.dummyLlm.release();
  await new Promise((r) => setTimeout(r, 1_500));
  for (const sid of [A, B]) {
    if (lastStatus(ctx, sid) !== "idle") {
      try { await ctx.client.request("session/cancel", { sessionId: sid }); } catch { /* cleanup best-effort */ }
    }
  }
  return "B dispatched and drove its own turn while A's request was parked (close-under-concurrency: rc.2 known limit, cleanup via cancel)";
}

// ── Contracts ⑩-⑭ (extend-dsh-contracts-020-capabilities) ────────────────────
// The 0.2.0 multi-agent capability family (docs/wanxing-multi-harness-runtime-
// explore.md): per-session preset composition, per-agent tool scoping, the
// subagent service, the ACP profile, and MCP sidecar sharing. ⑩⑪⑫⑭ ride the
// in-process probe plugin the runner materializes (design D1); ⑬ spawns the
// candidate's `--profile acp` and speaks ACP over stdio with a hand-rolled
// minimal client (no new deps).

// The probe plugin announces its ephemeral HTTP port via this file in the
// throwaway home; runner-side client with per-op errors.
export async function probeClient(ctx) {
  const portFile = join(ctx.home, "contracts-probe.json");
  const port = await pollUntil(
    () => {
      try {
        return JSON.parse(readFileSync(portFile, "utf8")).port ?? null;
      } catch {
        return null;
      }
    },
    { timeoutMs: 15_000, intervalMs: 400 },
  );
  if (!port) throw new Error("the probe plugin never announced its port (contracts-probe.json missing) — it did not load");
  const base = `http://127.0.0.1:${port}`;
  const call = async (op, body = {}) => {
    const res = await fetch(`${base}/${op}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(`probe ${op}: ${json?.error ?? res.status}`);
      if (json?.code) err.code = json.code;
      throw err;
    }
    return json;
  };
  return { call };
}

// Count live processes running the trivial MCP server (contract ⑭'s subject:
// process count must stay flat as agents multiply; and reach zero after the
// child exits — no sidecar orphans). Reads /proc directly on Linux (the image
// container ships no procps — shelling to `ps` failed the whole smoke lane
// there); falls back to `ps` on darwin dev machines where /proc is absent.
export function countTrivialSidecars() {
  if (existsSync("/proc")) {
    try {
      let count = 0;
      for (const ent of readdirSync("/proc")) {
        if (!/^\d+$/.test(ent)) continue;
        let cmdline = "";
        try {
          cmdline = readFileSync(join("/proc", ent, "cmdline"), "utf8");
        } catch {
          continue; // raced exit or unreadable — not ours to count
        }
        if (cmdline.includes("trivial-mcp-server.mjs")) count++;
      }
      return count;
    } catch {
      return -1;
    }
  }
  const res = spawnSync("ps", ["-axo", "command="], { encoding: "utf8", timeout: 10_000 });
  if (res.error || res.status !== 0) return -1;
  return res.stdout
    .split("\n")
    .filter((l) => l.includes("trivial-mcp-server.mjs") && !l.includes("grep")).length;
}

// The alternate persona the runner composes as a second declared preset — its
// marker string is what contract ⑩ asserts on the wire (black-box, via the
// dummy LLM's recorded system prompts).
export const ALT_PRESET_ID = "contracts-alt";
export const ALT_PERSONA_MARKER = "CONTRACTS-ALT-PERSONA";
export const ALT_PRESET = {
  id: ALT_PRESET_ID,
  name: "Contracts Alt",
  description: "The 0.2.0 per-session preset selection probe persona",
  order: 55,
  persona: `You are ${ALT_PERSONA_MARKER}, an alternate probe composition. Answer briefly.`,
};

const MCP_TOOL = "mcp__contracts__ping";

// Correlate one probe turn with its CONVERSATION request on the dummy. A turn
// fires up to two LLM requests carrying the same marker text: the session-title
// generation (system starts "Create a concise title…") and the conversation
// itself — whose marker sits mid-history, because the request's final message
// can be an injected system-reminder (skills descriptions). Scan the whole
// history, exclude the title request, take the last match.
function conversationRequest(requests, mark) {
  return (
    requests.findLast(
      (r) =>
        (r.allText || "").includes(mark) &&
        typeof r.model === "string" &&
        !/^Create a concise title/.test(String(r.system || "")),
    ) ?? null
  );
}

// ACP wire constants (sdk v1; PROTOCOL_VERSION=1).
const ACP_ROUTE = "contracts-acp-route";
const ACP_MODEL_A = "contracts-acp-a";
const ACP_MODEL_B = "contracts-acp-b";

// ── Contract ⑩ per-session preset selection + composition isolation ──────────

async function contractPresetSessionSelection(ctx) {
  requireHandshake(ctx);
  const probe = await probeClient(ctx);
  const MARK_STD = `contracts-preset-std-${Date.now()}`;
  const MARK_ALT = `contracts-preset-alt-${Date.now()}`;
  const base = { provider: ctx.provider, model: ctx.model };

  const std = await probe.call("agent", {
    sessionId: "contracts-preset-std",
    presetId: "standard",
    ...base,
    promptText: `say ok (${MARK_STD})`,
  });
  const alt = await probe.call("agent", {
    sessionId: "contracts-preset-alt",
    presetId: ALT_PRESET_ID,
    ...base,
    promptText: `say ok (${MARK_ALT})`,
  });
  if (std.preset !== "standard" || alt.preset !== ALT_PRESET_ID) {
    throw new Error(`composed presets report back wrong: std=${std.preset} alt=${alt.preset}`);
  }
  if (std.turn !== "idle" || alt.turn !== "idle") {
    throw new Error(`probe turns did not settle (std=${std.turn}, alt=${alt.turn})`);
  }

  // Black-box composition facts: each session's LLM request carries ITS OWN
  // preset's system prompt — the alt persona marker appears only on the alt
  // session's requests, never on the standard one's.
  const reqStd = await pollUntil(
    () => conversationRequest(ctx.dummyLlm.requests, MARK_STD),
    { timeoutMs: 15_000, intervalMs: 300 },
  );
  const reqAlt = await pollUntil(
    () => conversationRequest(ctx.dummyLlm.requests, MARK_ALT),
    { timeoutMs: 15_000, intervalMs: 300 },
  );
  if (!reqAlt || !String(reqAlt.system || "").includes(ALT_PERSONA_MARKER)) {
    throw new Error(
      `the alt preset's persona never reached the alt session's system prompt (system=${JSON.stringify(String(reqAlt?.system || "").slice(0, 120))}) — per-session composition did not take`,
    );
  }
  if (String(reqStd?.system || "").includes(ALT_PERSONA_MARKER)) {
    throw new Error("the alt persona leaked into the STANDARD session's system prompt — compositions cross-pollinate");
  }
  if (!String(reqStd?.system || "").trim()) {
    throw new Error("the standard session's system prompt is empty — its composition did not mount");
  }

  // Unknown preset: creation must fail BEFORE publication and roll back whole.
  const bad = await probe.call("badPreset", {
    sessionId: "contracts-preset-bad",
    presetId: "contracts-no-such-preset",
    ...base,
  });
  if (!/\b(not found|unknown|no preset|resolve|failed)\b/i.test(String(bad.error))) {
    throw new Error(`unknown preset creation did not fail loudly (error="${bad.error}")`);
  }
  if (bad.residue) {
    throw new Error("unknown preset creation left a live agent behind — no pre-publication rollback");
  }
  return (
    `two sessions mounted two presets in one process (std+alt persona both on the wire, no cross-pollution); ` +
    `unknown preset fails pre-publication (${String(bad.error).slice(0, 60)}) and rolls back`
  );
}

// ── Contract ⑪ per-agent tool-restriction scope ───────────────────────────────

async function contractPerAgentToolScope(ctx) {
  requireHandshake(ctx);
  const probe = await probeClient(ctx);
  // Reuse ⑩'s two live agents (std + alt) — both consume the same MCP server.
  const A = "contracts-preset-alt";
  const B = "contracts-preset-std";
  for (const sid of [A, B]) {
    const seen = await pollUntil(
      async () => {
        const t = await probe.call("tools", { sessionId: sid });
        return t.names.includes(MCP_TOOL) ? t : null;
      },
      { timeoutMs: 20_000, intervalMs: 500 },
    );
    if (!seen) throw new Error(`agent ${sid} never saw ${MCP_TOOL} — the trivial MCP server did not register`);
  }
  const restricted = await probe.call("restrict", { sessionId: A, deny: [MCP_TOOL] });
  if (restricted.names.includes(MCP_TOOL)) {
    throw new Error(`restrict({deny:[${MCP_TOOL}]}) did not remove the tool from agent A's surface`);
  }
  const afterB = await probe.call("tools", { sessionId: B });
  if (!afterB.names.includes(MCP_TOOL)) {
    throw new Error(`restricting agent A also removed ${MCP_TOOL} from agent B — tool scoping is not per-agent`);
  }
  return `restrict on agent A removed ${MCP_TOOL} from A only; sibling B kept it (${afterB.names.length} visible tools)`;
}

// ── Contract ⑫ subagent one-shot + slot admission ─────────────────────────────

async function contractSubagentOneShotSlots(ctx) {
  requireHandshake(ctx);
  const probe = await probeClient(ctx);
  const parent = "contracts-preset-std";
  ensureHotRoute(ctx); // the per-child override routes to contract ④'s hot route

  // (a) one-shot with per-child agentOptions: the child's own request must run
  // on the OVERRIDDEN model (black-box via the marker on the dummy).
  const MARK_CHILD = `contracts-subagent-child-${Date.now()}`;
  const one = await probe.call("subagentOneShot", {
    parentSessionId: parent,
    promptText: `child probe (${MARK_CHILD})`,
    agentOptions: { provider: HOT_ROUTE, model: HOT_MODEL },
  });
  if (/error/i.test(String(one.stopReason))) {
    throw new Error(`one-shot child failed (stopReason=${one.stopReason})`);
  }
  const childReq = await pollUntil(
    () => conversationRequest(ctx.dummyLlm.requests, MARK_CHILD),
    { timeoutMs: 15_000, intervalMs: 300 },
  );
  if (!childReq || childReq.model !== HOT_MODEL) {
    throw new Error(
      `per-child agentOptions did not land: the child's request ran on model=${JSON.stringify(childReq?.model)} — expected "${HOT_MODEL}"`,
    );
  }

  // (b) slot admission with maxActiveSubagents=1: the first continuable child
  // holds the pool; a SECOND must be refused with ACTIVATION_LIMIT_REACHED —
  // never queued, never silent.
  await probe.call("subagentContinuable", { parentSessionId: parent, promptText: "slot holder probe" });
  let overLimit = null;
  let overLimitCode = null;
  try {
    await probe.call("subagentContinuable", { parentSessionId: parent, promptText: "should be refused" });
  } catch (e) {
    overLimit = String(e?.message || e);
    overLimitCode = typeof e?.code === "string" ? e.code : null;
  }
  if (!overLimit) {
    throw new Error("the over-limit continuable start was ACCEPTED — the slot pool queued or ignored it instead of refusing");
  }
  if (overLimitCode !== "ACTIVATION_LIMIT_REACHED" && !/ACTIVATION_LIMIT_REACHED/.test(overLimit)) {
    throw new Error(`the over-limit start refused without the stable ACTIVATION_LIMIT_REACHED code (code=${overLimitCode}): ${overLimit}`);
  }

  // (c) one-shot runs stay OUTSIDE the continuable pool (the README's split):
  // with the one slot held, a plain one-shot must still complete.
  const plain = await probe.call("subagentOneShot", {
    parentSessionId: parent,
    promptText: "outside-the-pool probe",
  });
  if (/error/i.test(String(plain.stopReason))) {
    throw new Error(`a one-shot run failed while a continuable slot was held (stopReason=${plain.stopReason}) — one-shot is not outside the pool`);
  }
  return (
    `one-shot child ran to ${one.stopReason} on the overridden ${HOT_MODEL}; second continuable refused ACTIVATION_LIMIT_REACHED; ` +
    `a one-shot still completes with the single slot held`
  );
}

// ── Contract ⑬ ACP session surface (+ metering-shape appendix) ────────────────

// A minimal ndjson JSON-RPC client for the ACP child's stdio (design D6: no
// external ACP SDK dependency in scripts/).
function ndjsonRpc(proc, onNotification) {
  let buf = "";
  let nextId = 1;
  const pending = new Map();
  const notifications = [];
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk) => {
    buf += chunk;
    for (;;) {
      const idx = buf.indexOf("\n");
      if (idx === -1) break;
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (p) {
          if (msg.error) {
            const err = new Error(`${p.method}: ${msg.error?.message || JSON.stringify(msg.error)}`);
            err.code = msg.error?.code ?? null;
            err.data = msg.error?.data ?? null;
            p.reject(err);
          } else {
            p.resolve(msg.result);
          }
        }
      } else if (msg.method) {
        notifications.push(msg);
        onNotification?.(msg);
      }
    }
  });
  const exited = new Promise((resolve) => proc.on("exit", (code, signal) => resolve({ code, signal })));
  return {
    notifications,
    request(method, params) {
      const id = nextId++;
      proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })}\n`);
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject, method }));
    },
    notify(method, params) {
      proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    },
    exited,
    close() {
      try {
        proc.stdin.end();
      } catch {
        /* already gone */
      }
      return exited;
    },
  };
}

// Spawn the candidate's ACP profile against a fresh throwaway home whose
// home-level patch wires the llm route at the dummy endpoint and points the
// acp row's default model at MODEL_A.
function spawnAcpChild(ctx, home) {
  const patch = [
    { id: "acp", config: { provider: ACP_ROUTE, model: ACP_MODEL_A } },
    {
      insert: [
        {
          id: "llm-pi-ai",
          name: "@deepseek-ai/dsh-llm-pi-ai",
          config: {
            providers: {
              [ACP_ROUTE]: {
                apiKeyEnv: "LLM_API_KEY",
                displayName: "Contracts ACP",
                api: "openai-completions",
                baseURL: ctx.dummyLlm.url,
                models: [
                  { id: ACP_MODEL_A, name: "Contracts ACP A", contextWindow: 8192, maxTokens: 1024, input: ["text"] },
                  { id: ACP_MODEL_B, name: "Contracts ACP B", contextWindow: 8192, maxTokens: 1024, input: ["text"] },
                ],
              },
            },
          },
        },
      ],
    },
  ];
  writeFileSync(join(home, "cordis.patch.yml"), yaml.dump(patch));
  const env = { ...process.env, DSH_HOME: home, LLM_API_KEY: `sk-contracts-acp-${Date.now()}` };
  for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete env[k];
  const proc = spawn(ctx.bin, ["--profile", "acp"], { env, stdio: ["pipe", "pipe", "pipe"] });
  let stderrTail = "";
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (c) => {
    stderrTail = (stderrTail + c).slice(-2000);
  });
  const rpc = ndjsonRpc(proc);
  return { proc, rpc, stderrTail: () => stderrTail };
}

async function contractAcpSessionSurface(ctx) {
  if (!ctx.bin) throw new Error("unavailable without the candidate dsh binary (ctx.bin)");
  const home = mkdtempSync(join(tmpdir(), "dsh-contracts-acp-"));
  const ws = mkdtempSync(join(tmpdir(), "dsh-contracts-acp-ws-"));
  let acp = null;
  try {
    acp = spawnAcpChild(ctx, home);
    const init = await withTimeout(acp.rpc.request("initialize", { protocolVersion: 1, clientCapabilities: {} }), 20_000, "acp initialize");
    if (!init?.protocolVersion) throw new Error(`acp initialize returned ${JSON.stringify(init)?.slice(0, 120)}`);

    // create → set model → prompt runs on the SELECTED model. (mcpServers is
    // an OBJECT map in ACP, not an array.)
    const news = await withTimeout(acp.rpc.request("session/new", { cwd: ws, mcpServers: {} }), 20_000, "acp session/new");
    const sessionId = news?.sessionId;
    if (!sessionId) throw new Error(`acp session/new returned no sessionId (${JSON.stringify(news)?.slice(0, 120)})`);
    await withTimeout(
      acp.rpc.request("session/set_config_option", {
        sessionId,
        configId: "model",
        value: JSON.stringify([ACP_ROUTE, ACP_MODEL_B]),
      }),
      15_000,
      "acp session/set_config_option",
    );
    const MARK_ACP = `contracts-acp-${Date.now()}`;
    const prompt1 = await withTimeout(
      acp.rpc.request("session/prompt", { sessionId, prompt: [{ type: "text", text: `acp probe (${MARK_ACP})` }] }),
      30_000,
      "acp session/prompt",
    );
    if (!/end_turn|stop/.test(String(prompt1?.stopReason))) {
      throw new Error(`acp prompt settled with stopReason=${JSON.stringify(prompt1?.stopReason)}`);
    }
    const acpReq = await pollUntil(
      () => conversationRequest(ctx.dummyLlm.requests, MARK_ACP),
      { timeoutMs: 15_000, intervalMs: 300 },
    );
    if (!acpReq || acpReq.model !== ACP_MODEL_B) {
      throw new Error(`the selected model did not apply: the ACP turn ran on model=${JSON.stringify(acpReq?.model)} — expected "${ACP_MODEL_B}"`);
    }

    // cancel: a held prompt aborts via the notification and the session takes
    // a NEW prompt immediately after.
    const HOLD = `contracts-acp-hold-${Date.now()} [HOLD]`;
    const heldPrompt = acp.rpc.request("session/prompt", { sessionId, prompt: [{ type: "text", text: HOLD }] });
    await pollUntil(() => (ctx.dummyLlm.heldCount() >= 1 ? true : null), { timeoutMs: 15_000, intervalMs: 300 });
    acp.rpc.notify("session/cancel", { sessionId });
    const cancelled = await withTimeout(heldPrompt, 15_000, "acp cancelled prompt settle");
    if (!/cancel/i.test(String(cancelled?.stopReason))) {
      throw new Error(`a cancelled ACP prompt settled with stopReason=${JSON.stringify(cancelled?.stopReason)} — expected cancelled`);
    }
    ctx.dummyLlm.release();
    const after = await withTimeout(
      acp.rpc.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "acp after cancel" }] }),
      30_000,
      "acp prompt after cancel",
    );
    if (!/end_turn|stop/.test(String(after?.stopReason))) {
      throw new Error(`the post-cancel ACP prompt settled with stopReason=${JSON.stringify(after?.stopReason)} — the session wedged`);
    }

    // Metering-shape appendix (a RECORD, not an assertion): what usage/token
    // evidence the ACP notifications carry.
    const meteringEvidence = [];
    for (const n of acp.rpc.notifications) {
      const u = n?.params?.update;
      if (!u) continue;
      const kind = String(u.sessionUpdate ?? "?");
      const raw = JSON.stringify(u);
      if (/contextUsage|tokenUsage|tokens|usage/i.test(raw) && !meteringEvidence.some((e) => e.kind === kind)) {
        meteringEvidence.push({ kind, evidence: raw.slice(0, 200) });
      }
    }
    ctx.acpMeteringShape = meteringEvidence.length
      ? meteringEvidence.map((e) => e.kind).join("+")
      : "none-observed";

    // Persistence across a process restart: list → resume → prompt → close.
    await acp.rpc.close();
    const die = await withTimeout(acp.exited ?? acp.rpc.exited, 15_000, "acp child exit");
    void die;
    acp = spawnAcpChild(ctx, home);
    await withTimeout(acp.rpc.request("initialize", { protocolVersion: 1, clientCapabilities: {} }), 20_000, "acp initialize (restart)");
    const list = await withTimeout(acp.rpc.request("session/list", {}), 15_000, "acp session/list");
    const listed = (list?.sessions ?? []).some((s) => s?.sessionId === sessionId);
    if (!listed) throw new Error(`session/list after restart lost the session (${JSON.stringify(list)?.slice(0, 160)}) — ACP persistence is gone`);
    await withTimeout(acp.rpc.request("session/resume", { sessionId, cwd: ws, mcpServers: {} }), 20_000, "acp session/resume");
    const MARK_RESUME = `contracts-acp-resume-${Date.now()}`;
    const resumed = await withTimeout(
      acp.rpc.request("session/prompt", { sessionId, prompt: [{ type: "text", text: `acp resume probe (${MARK_RESUME})` }] }),
      30_000,
      "acp resumed prompt",
    );
    if (!/end_turn|stop/.test(String(resumed?.stopReason))) {
      throw new Error(`the resumed session's prompt settled with stopReason=${JSON.stringify(resumed?.stopReason)}`);
    }
    await withTimeout(acp.rpc.request("session/close", { sessionId }), 15_000, "acp session/close");
    return (
      `initialize/new/set_config_option→${ACP_MODEL_B}(applied on the wire)/cancel→cancelled+re-prompt/list+resume+close across a restart; ` +
      `metering on the wire: ${ctx.acpMeteringShape}`
    );
  } finally {
    if (acp) {
      try {
        await withTimeout(acp.rpc.close(), 5_000, "acp final close");
      } catch {
        acp.proc.kill("SIGKILL");
      }
    }
    rmSync(home, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
}

// ── Contract ⑭ MCP sidecar process-level sharing ─────────────────────────────

async function contractMcpSidecarSharing(ctx) {
  requireHandshake(ctx);
  const probe = await probeClient(ctx);
  // Three FRESH consumers (⑩'s agents exist, but ⑪ deliberately denied the
  // tool from one of them — scope isolation working as intended means reused
  // agents would make this contract lie about visibility).
  const sids = ["contracts-sidecar-a", "contracts-sidecar-b", "contracts-sidecar-c"];
  for (const sid of sids) {
    await probe.call("agent", { sessionId: sid, presetId: "standard", provider: ctx.provider, model: ctx.model });
  }
  for (const sid of sids) {
    const seen = await pollUntil(
      async () => {
        const t = await probe.call("tools", { sessionId: sid });
        return t.names.includes(MCP_TOOL) ? t : null;
      },
      { timeoutMs: 20_000, intervalMs: 500 },
    );
    if (!seen) throw new Error(`agent ${sid} never saw ${MCP_TOOL} — the shared server did not reach it`);
  }
  const count = countTrivialSidecars();
  if (count !== 1) {
    throw new Error(
      count < 0
        ? "sidecar count could not be read (ps failed)"
        : `${count} trivial-MCP server processes live for 3 agents on one server — sidecars are NOT process-shared (memory math breaks)`,
    );
  }
  // The no-orphan half runs after the child exits (the runner flips this row
  // if any server process outlives the dsh child).
  return "3 agents on one server → exactly 1 sidecar process (post-exit orphan check rides the runner's shutdown)";
}

// ── Contract ⑮ (restore-assistant-stream-020) ────────────────────────────────
// The live delta lane: the 0.2.0 session format removed assistant/chunk from
// session.event, so the ONLY token-by-token source is the bridge-forwarded
// platform/stream notification (frames from the runtime's
// agent/assistant-stream channel). This contract pins the lane's existence,
// its frame vocabulary, its per-session keying, and the format fact that
// session.event stays chunk-free — a candidate that changes any of these
// must fail here instead of silently breaking every live transcript.

async function contractAssistantStreamForward(ctx) {
  requireHandshake(ctx);
  const caps = await ctx.client.request("platform/capabilities");
  if (caps?.streamForward !== true) {
    throw new Error(`platform/capabilities does not advertise streamForward (got ${JSON.stringify(caps)}) — the live delta lane is not forwarded`);
  }
  const S = "contracts-stream-fwd";
  const notifAt = ctx.notifications.length;
  await ctx.client.prompt(S, [{ type: "text", text: "stream forward probe" }]);
  const idle = await pollUntil(() => (lastStatus(ctx, S) === "idle" ? true : null), { timeoutMs: 20_000, intervalMs: 300 });
  if (!idle) throw new Error("the stream-forward probe turn never went idle");
  const frames = ctx.notifications
    .slice(notifAt)
    .filter((n) => n?.method === "platform/stream" && n?.params?.sessionId === S)
    .map((n) => n.params.frame);
  const kinds = frames.map((f) => (f?.type === "chunk" ? `chunk:${f.chunk?.type}` : f?.type));
  if (frames.length === 0) {
    throw new Error("no platform/stream frames arrived for the prompted session — the delta lane is dead");
  }
  if (!frames.some((f) => f?.type === "start")) {
    throw new Error(`no start frame (kinds: ${kinds.join(",")})`);
  }
  if (!frames.some((f) => f?.type === "chunk" && f.chunk?.type === "text-delta")) {
    throw new Error(`no text-delta chunk frame (kinds: ${kinds.join(",")})`);
  }
  if (!frames.some((f) => f?.type === "end")) {
    throw new Error(`no end frame (kinds: ${kinds.join(",")})`);
  }
  // The format fact the host's source binding rests on: session.event must
  // NOT carry chunk-type deltas. A candidate that re-adds them (or restores
  // the assistant/chunk name) changes the lane layout — re-evaluate, do not
  // silently run both sources.
  const chunkEvents = ctx.notifications
    .slice(notifAt)
    .filter((n) => n?.method === "session.event" && ["assistant/chunk", "assistant/attempt"].includes(n?.params?.event?.type));
  if (chunkEvents.length > 0) {
    throw new Error(`session.event carried ${chunkEvents.length} chunk/attempt events — the format fact changed, the host source binding needs re-evaluation`);
  }
  return `platform/stream forwarded ${frames.length} frames (${kinds.join(",")}) keyed to the prompting session; session.event stayed chunk-free`;
}

// ── Contract ⑯ (add-dsh-pod-adapter): pod co-hosting shape ───────────────────
//
// Two member agents share ONE process (the pod shape's whole premise); each
// member's session composes the member's OWN persona and model through the
// HOST lane a pod child drives: `preset/set` + `model/set` parked before the
// session's first prompt, applied at its lazy creation. Member A keeps the
// initialize-time defaults; member B parks the alt persona and a second model.
// The refusal shape (live-session preset/set) and the loud-failure shape
// (unresolvable parked id) pin the same seams the runner's pod child relies on.
async function contractPodCoHost(ctx) {
  requireHandshake(ctx);
  const caps = await ctx.client.request("platform/capabilities");
  if (!Array.isArray(caps?.methods) || !caps.methods.includes("preset/set")) {
    throw new Error(`platform/capabilities does not list preset/set (got ${JSON.stringify(caps)}) — the bridge lacks per-session persona, pod serving cannot route members`);
  }
  ensureHotRoute(ctx);
  const A = "contracts-pod-member-a";
  const B = "contracts-pod-member-b";
  const MARK_A = `contracts-pod-a-${Date.now()}`;
  const MARK_B = `contracts-pod-b-${Date.now()}`;

  // Member A turns FIRST (its session composes on the initialize-time
  // defaults), then member B parks persona+model and turns — the pod child's
  // real order. model/set with a sessionId ALSO flips the process defaults
  // (the bridge's switch-the-active-model side effect), so sessions created
  // AFTER a park without their own would inherit it — a pod child never
  // creates those (every member session parks both dimensions before its
  // first prompt); the invariant that must hold is that a member's park
  // never RETARGETS a live sibling session, pinned by A's second turn below.
  await ctx.client.prompt(A, [{ type: "text", text: `pod member A probe (${MARK_A})` }]);
  const parkedPreset = await ctx.client.request("preset/set", { sessionId: B, presetId: ALT_PRESET_ID });
  if (parkedPreset?.ok !== true) {
    throw new Error(`preset/set for a not-yet-created session failed: ${JSON.stringify(parkedPreset)}`);
  }
  let parkedModel = null;
  const modelParked = await pollUntil(
    async () => {
      try {
        parkedModel = await ctx.client.request("model/set", { sessionId: B, provider: HOT_ROUTE, model: HOT_MODEL });
        return parkedModel?.ok === true;
      } catch (e) {
        if (!/no adapter registered for provider/.test(String(e?.message))) throw e;
        return false;
      }
    },
    { timeoutMs: 15_000, intervalMs: 500 },
  );
  if (!modelParked) throw new Error(`parked model/set failed: ${JSON.stringify(parkedModel)}`);

  await ctx.client.prompt(B, [{ type: "text", text: `pod member B probe (${MARK_B})` }]);
  const reqA = await pollUntil(() => conversationRequest(ctx.dummyLlm.requests, MARK_A), { timeoutMs: 20_000, intervalMs: 400 });
  const reqB = await pollUntil(() => conversationRequest(ctx.dummyLlm.requests, MARK_B), { timeoutMs: 20_000, intervalMs: 400 });

  if (!String(reqB?.system || "").includes(ALT_PERSONA_MARKER)) {
    throw new Error(
      `member B's parked persona never composed its session (system=${JSON.stringify(String(reqB?.system || "").slice(0, 120))}) — the park did not apply at creation`,
    );
  }
  if (reqB?.model !== HOT_MODEL) {
    throw new Error(`member B's parked model did not apply: its turn ran on model=${JSON.stringify(reqB?.model)} — expected "${HOT_MODEL}"`);
  }
  if (String(reqA?.system || "").includes(ALT_PERSONA_MARKER)) {
    throw new Error("member B's persona leaked into member A's system prompt — pod compositions cross-pollinate");
  }
  if (reqA?.model !== ctx.model) {
    throw new Error(`member A's own turn left its initialize-time model: ran on ${JSON.stringify(reqA?.model)} — expected "${ctx.model}"`);
  }
  if ((reqB?.allText || "").includes(MARK_A)) {
    throw new Error("member A's history reached member B's request — conversations cross members inside the pod");
  }

  // The live-sibling invariant: after B's park (and its default flip), A's
  // NEXT turn still runs on A's own composition — a member's selection can
  // never retarget a session that already exists.
  const MARK_A2 = `contracts-pod-a2-${Date.now()}`;
  await ctx.client.prompt(A, [{ type: "text", text: `pod member A second probe (${MARK_A2})` }]);
  const reqA2 = await pollUntil(() => conversationRequest(ctx.dummyLlm.requests, MARK_A2), { timeoutMs: 20_000, intervalMs: 400 });
  if (reqA2?.model !== ctx.model) {
    throw new Error(
      `member A's SECOND turn ran on ${JSON.stringify(reqA2?.model)} — expected "${ctx.model}": a member's parked selection retargeted a live sibling session`,
    );
  }
  if (String(reqA2?.system || "").includes(ALT_PERSONA_MARKER)) {
    throw new Error("member B's parked persona reached member A's second turn — live compositions cross-pollinate");
  }

  // The refusal: a LIVE session's preset is creation-time composition. Both a
  // silent swap and a silent ignore break the pod host's routing assumptions.
  let liveRefusal = null;
  try {
    await ctx.client.request("preset/set", { sessionId: B, presetId: "standard" });
  } catch (e) {
    liveRefusal = String(e?.message || e);
  }
  if (!/creation-time composition/.test(liveRefusal || "")) {
    throw new Error(`preset/set on a live session must refuse naming the rule (got ${JSON.stringify(liveRefusal)})`);
  }

  // The loud failure: an unresolvable parked id fails the session's creation
  // before any agent publishes — surfaced through the prompt itself.
  const C = "contracts-pod-member-bad";
  await ctx.client.request("preset/set", { sessionId: C, presetId: "contracts-no-such-preset" });
  let badCreation = null;
  try {
    await ctx.client.prompt(C, [{ type: "text", text: "should never run" }]);
  } catch (e) {
    badCreation = String(e?.message || e);
  }
  if (!badCreation || !/(not found|unknown|no preset|resolve|failed)/i.test(badCreation)) {
    throw new Error(`an unresolvable parked preset must fail the session's creation loudly (got ${JSON.stringify(badCreation)})`);
  }

  return (
    `two members co-hosted one process: A on defaults (model=${ctx.model}), B on its parked persona+model (${HOT_MODEL}); ` +
    `histories isolated; live-session preset/set refused by rule; unknown parked id fails creation pre-publication`
  );
}

// ── The table ────────────────────────────────────────────────────────────────

export const CONTRACTS = [
  { id: "boot-handshake-roster", title: "① boot/handshake/roster", run: contractBootHandshakeRoster },
  { id: "closure-resolvable", title: "② closure-resolvable", run: contractClosureResolvable },
  { id: "hmr-register-config", title: "③ hmr family generation", run: contractHmrRegisterConfig },
  { id: "settings-credentials-hot-reload", title: "④ settings/credentials hot-reload", run: contractSettingsHotReload },
  { id: "patch-semantics-scaffold", title: "⑤ patch semantics + scaffold", run: contractPatchSemanticsScaffold },
  { id: "platform-sdk-rpc", title: "⑥ platform SDK RPC surface", tags: ["internal-API"], run: contractPlatformSdkRpc },
  { id: "live-model-set", title: "⑦ live model/set (step-safe switch)", run: contractLiveModelSet },
  { id: "session-cancel", title: "⑧ session/cancel (abort + converge)", run: contractSessionCancel },
  { id: "multi-session-concurrency", title: "⑨ multi-session concurrency", run: contractMultiSessionConcurrency },
  { id: "preset-session-selection", title: "⑩ per-session preset selection", run: contractPresetSessionSelection },
  { id: "per-agent-tool-scope", title: "⑪ per-agent tool-restriction scope", run: contractPerAgentToolScope },
  { id: "subagent-oneshot-slots", title: "⑫ subagent one-shot + slot admission", run: contractSubagentOneShotSlots },
  { id: "acp-session-surface", title: "⑬ ACP session surface", run: contractAcpSessionSurface },
  { id: "mcp-sidecar-sharing", title: "⑭ MCP sidecar process sharing", run: contractMcpSidecarSharing },
  { id: "assistant-stream-forward", title: "⑮ assistant-stream forward (live delta lane)", run: contractAssistantStreamForward },
  { id: "pod-cohost-shape", title: "⑯ pod co-host shape (parked persona+model per member)", run: contractPodCoHost },
  { id: "acp-adapter-mapping", title: "⑰ ACP adapter mapping face", run: contractAcpAdapterMapping },
];

// ── Contract ⑰ (add-harness-adapter): ACP adapter mapping face ───────────────
//
// The ACP adapter is PLATFORM code (agent-runner/harness/acp.js), so this
// contract runs it directly against a local fake ACP agent process — no dsh
// tree, no credentials, no network. It pins the mapping the second harness
// depends on: initialize handshake, lazy session/new with an ABSOLUTE cwd,
// prompt → stopReason, streamed agent_message_chunk deltas, usage_update
// parsing, session/cancel convergence — and the two failure families shared
// with the dsh path (a runtime that cannot start; a turn with no assistant
// text → -32005). Drift here means the runner's second harness silently
// breaks; the real claude-code-acp binary is exercised by production
// validation, not here.
async function contractAcpAdapterMapping() {
  const { AcpHarnessAdapter } = await import("../../../agent-runner/harness/acp.js");
  const fakeAgent = join(REPO_ROOT, "scripts", "lib", "dsh-contracts", "fake-acp-agent.mjs");
  const workDir = mkdtempSync(join(tmpdir(), "contracts-acp-"));
  const make = (mode) => new AcpHarnessAdapter({
    key: `contracts-acp-${mode}`,
    spawnSpec: {
      command: process.execPath,
      args: [fakeAgent, `--mode=${mode}`],
      cwd: workDir,
      env: { ...process.env, FAKE_ACP_REPLY: "contracts acp ok" },
      provider: "fake-provider",
      model: "fake-model",
    },
    log: { log() {}, warn() {}, error() {} },
  });

  // Normal path: handshake → session → prompt → text + deltas + usage.
  const adapter = make("normal");
  try {
    await adapter.start();
    if (adapter.ready !== true) throw new Error("start() did not leave the adapter ready");
    const deltas = [];
    const out = await adapter.turn("contracts-acp-s1", "hello", { onDelta: (t) => deltas.push(t) });
    if (!String(out?.text || "").includes("contracts acp ok")) {
      throw new Error(`the ACP turn did not return the agent's text (got ${JSON.stringify(out?.text)})`);
    }
    if (deltas.length < 2 || deltas.join("") !== out.text) {
      throw new Error(`deltas did not stream and concatenate to the final text (${deltas.length} pieces)`);
    }
    if (!out.usage || out.usage.sessionUpdate !== "usage_update") {
      throw new Error(`usage_update did not ride through to the caller (got ${JSON.stringify(out.usage)})`);
    }
    if (!out.text.includes("[fake-model]")) {
      throw new Error("the spawn-time model never reached the agent — session/set_config_option mapping broke");
    }
    // A relative cwd must be refused by the adapter locally (the wire requires
    // absolute paths; a silent relative send would fail deep in the agent).
    const rel = new AcpHarnessAdapter({
      key: "contracts-acp-rel",
      spawnSpec: { command: process.execPath, args: [fakeAgent], cwd: "relative", env: process.env },
      log: { log() {}, warn() {}, error() {} },
    });
    let relErr = null;
    try {
      await rel.start();
    } catch (e) {
      relErr = String(e?.message || e);
    }
    if (!/absolute cwd/.test(relErr || "")) {
      throw new Error(`a relative cwd was not refused (got ${JSON.stringify(relErr)})`);
    }
    await rel.stop().catch(() => {});
    // Cancel: the parked turn converges through session/cancel.
    const parked = adapter.turn("contracts-acp-s1", "hold");
    await new Promise((r) => setTimeout(r, 5));
    await adapter.request("session/cancel", { sessionId: "contracts-acp-s1" });
    const cancelled = await parked;
    if (cancelled.cancelled !== true) {
      throw new Error("session/cancel did not converge the parked turn (no cancelled outcome)");
    }
  } finally {
    await adapter.stop().catch(() => {});
  }

  // Failure family: a turn with no assistant text settles as -32005 (the same
  // code the dsh path uses — metering/billing semantics are harness-independent).
  const empty = make("empty");
  try {
    await empty.start();
    let emptyCode = null;
    try {
      await empty.turn("contracts-acp-empty", "hello");
    } catch (e) {
      emptyCode = e?.code ?? null;
    }
    if (emptyCode !== -32005) {
      throw new Error(`an empty ACP turn did not settle -32005 (got ${JSON.stringify(emptyCode)})`);
    }
  } finally {
    await empty.stop().catch(() => {});
  }

  // Failure family: a binary that cannot come up fails the start, never hangs.
  const dead = make("nope");
  let deadErr = null;
  try {
    await dead.start();
  } catch (e) {
    deadErr = String(e?.message || e);
  }
  if (!deadErr) throw new Error("a dead ACP handshake did not fail the start()");
  await dead.stop().catch(() => {});
  rmSync(workDir, { recursive: true, force: true });

  return (
    "ACP adapter mapping pinned: initialize→session/new(absolute cwd)→prompt(stopReason); deltas stream and concatenate; " +
    "usage_update rides through; model selection applies; session/cancel converges; empty turn → -32005; dead handshake fails the start"
  );
}
