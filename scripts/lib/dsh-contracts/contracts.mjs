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
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
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
  const entries = [];
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (!key || !entry.version) continue;
    const idx = key.lastIndexOf("node_modules/");
    if (idx === -1) continue;
    if (entry.os && !entry.os.includes(process.platform)) continue;
    if (entry.cpu && !entry.cpu.includes(process.arch)) continue;
    const name = key.slice(idx + "node_modules/".length);
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
  writeFileSync(marker, `${JSON.stringify({ key, createdAt: new Date().toISOString(), source: "dsh-matrix" }, null, 2)}\n`);
  return { tree, cached: false, key };
}

// ── Small shared helpers ─────────────────────────────────────────────────────

// "1.0.16" vs "1.0.17" on [major, minor, patch]; a prerelease of the threshold
// (1.0.17-rc.1) parses to the same patch number and compares equal — the
// dangerous side — which is the correct direction for the hmr gate.
function cmpVersion(a, b) {
  const pa = String(a).split(".").map((x) => Number.parseInt(x, 10) || 0);
  const pb = String(b).split(".").map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1;
  }
  return 0;
}

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

// ── Contract ③ hmr registerConfig ────────────────────────────────────────────

async function contractHmrRegisterConfig(ctx) {
  const HMR_SPEC = "@deepseek-ai/cordis-plugin-hmr/package.json";
  let version;
  const url = resolveBatchInTree(ctx.tree, [HMR_SPEC]).get(HMR_SPEC);
  try {
    if (!url) throw new Error("ERR_MODULE_NOT_FOUND");
    const pkgPath = assertResolvedInsideTree(ctx.tree, HMR_SPEC, url);
    version = JSON.parse(readFileSync(pkgPath, "utf8")).version;
  } catch (e) {
    throw new Error(`cannot resolve/read cordis-plugin-hmr in the candidate tree: ${firstLine(e)}`);
  }
  if (cmpVersion(version, "1.0.17") >= 0) {
    throw new Error(
      `cordis-plugin-hmr@${version} ≥ 1.0.17 — registerConfig was removed upstream while dsh-app-boot's watchUserPatches still calls it, so every child crash-loops at boot (2026-09-23 incident class); keep the 1.0.16 override`,
    );
  }
  const crash = ctx.bootExit ?? ctx.childExit;
  if (crash && /watchUserPatches|registerConfig/i.test(crash.error)) {
    throw new Error(`the pin holds (${version}) but the child still crashed at boot with the registerConfig signature: ${firstLine(crash.error)}`);
  }
  return `cordis-plugin-hmr@${version} < 1.0.17; no boot crash (watchUserPatches contract intact)`;
}

// ── Contract ④ settings/credentials hot-reload ───────────────────────────────

const HOT_ROUTE = "volces-hot";
const HOT_MODEL = "contracts-hot-model";
const HOT_SESSION = "contracts-hot-reload";

async function contractSettingsHotReload(ctx) {
  requireHandshake(ctx);

  // (a) settings hot-reload: a provider route written into settings.yaml
  // MID-SESSION must register its adapter without a child restart. Observed
  // through re-initialize onto the new route: initialize rejects with
  // "no adapter registered for provider" until the settings service has
  // reloaded the file, then succeeds.
  const doc = yaml.load(readFileSync(ctx.settingsPath, "utf8")) ?? {};
  doc["llm-pi-ai"] = doc["llm-pi-ai"] ?? {};
  doc["llm-pi-ai"].providers = doc["llm-pi-ai"].providers ?? {};
  doc["llm-pi-ai"].providers[HOT_ROUTE] = {
    apiKeyEnv: "LLM_API_KEY",
    displayName: "Contracts Hot Route",
    api: "openai-completions",
    baseURL: ctx.dummyLlm.url,
    models: [{ id: HOT_MODEL, name: "Contracts Hot Model", contextWindow: 8192, maxTokens: 1024, input: ["text"] }],
  };
  atomicWriteTextSync(ctx.settingsPath, yaml.dump(doc));
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
    throw new Error(`the hot-written llm-pi-ai route "${HOT_ROUTE}" never registered within 10s — settings.yaml is not live-reloading`);
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
  await ctx.client.prompt(HOT_SESSION, [
    { type: "text", text: "dsh-contracts credential rotation probe (one request to the dummy endpoint)" },
  ]);
  const seen = await pollUntil(
    () => ctx.dummyLlm.requests.find((r) => r.t >= rotatedAt && r.auth === `Bearer ${rotated}`) ?? null,
    { timeoutMs: 10_000, intervalMs: 400 },
  );
  if (!seen) {
    const auths = [...new Set(ctx.dummyLlm.requests.filter((r) => r.t >= rotatedAt).map((r) => r.auth || "(none)"))];
    throw new Error(
      `the rotated credential never reached the LLM request within 10s (Authorization seen: ${auths.join(", ") || "none"}) — .credentials.yaml is not re-resolving per request`,
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

// ── The table ────────────────────────────────────────────────────────────────

export const CONTRACTS = [
  { id: "boot-handshake-roster", title: "① boot/handshake/roster", run: contractBootHandshakeRoster },
  { id: "closure-resolvable", title: "② closure-resolvable", run: contractClosureResolvable },
  { id: "hmr-register-config", title: "③ hmr registerConfig (<1.0.17)", run: contractHmrRegisterConfig },
  { id: "settings-credentials-hot-reload", title: "④ settings/credentials hot-reload", run: contractSettingsHotReload },
  { id: "patch-semantics-scaffold", title: "⑤ patch semantics + scaffold", run: contractPatchSemanticsScaffold },
  { id: "platform-sdk-rpc", title: "⑥ platform SDK RPC surface", tags: ["internal-API"], run: contractPlatformSdkRpc },
];
