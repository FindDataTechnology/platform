// dsh-profile.js — generates the dsh profile's settings.yaml from host env.
//
// The dsh-llm-pi-ai plugin mounts dormant and registers LLM routes the moment a
// `llm-pi-ai:` section appears in $DSH_HOME/settings.yaml (the settings service
// live-reloads it). This module is the single source that writes that section:
// it reads the host's LLM env — LLM_API_KEY/LLM_BASE_URL (the Volces gateway) —
// and declares an OpenAI-compatible (`openai-completions`) route dsh can serve.
//
// Per design D4 (host-side config sources unchanged), the env var names are the
// project's own LLM_* (not the task spec's aspirational VOLCES_*); the generator
// is the seam that adapts them to dsh's `llm-pi-ai:` shape. Per D3, server.js
// writes the profile and lets dsh load plugins — no JS tool/MCP wiring.
//
// LiteLLM was removed: dsh-llm manages LLM natively via settings.yaml +
// .credentials.yaml hot-reload, so there's no LiteLLM child process and no
// runtime model discovery from a proxy. Model discovery/refresh is handled by
// dsh-llm's ctx.llm.discoverModels() (when wired) — the generator's declared
// list remains the bootstrap set dsh loads at startup.
//
// Writes atomically (temp+rename) and returns the declared model list so server.js
// can source its model selector without a dsh listModels RPC (dsh has none stock;
// the generator's declared list IS the dsh list — dsh loads exactly this file).
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync, statSync, lstatSync, copyFileSync, symlinkSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { atomicWriteTextSync, normalizeBaseUrl } from "./lib/persistence.js";
import { repoRoot } from "./paths.js";

const DSH_HOME = process.env.DSH_HOME || join(homedir(), ".dsh");
const SETTINGS_PATH = join(DSH_HOME, "settings.yaml");
const CREDENTIALS_PATH = join(DSH_HOME, ".credentials.yaml");
const MCP_CONFIG_PATH = resolve(process.env.MCP_CONFIG_PATH || "mcp.json");

// Model gateway catalog (2026-09-30 refresh): every id
// on GET /v1/models (33) was probed with a real 1-token chat completion — that
// endpoint lists *recognized* ids, not *serving* ones, and the gateway's
// account groups authorize only a subset. Kept here: the ids that served.
// Excluded, with probe evidence: all mimo ids (upstream "Service temporarily
// unavailable", ×2 retries); glm-5.3/5.2/5.1 + kimi-k2.6 + date-suffixed
// deepseek ("not supported by any configured account in this group"); nex
// free tier (revoked, now paid); nemotron-3.5-content-safety (classifier —
// 200 with empty content).
// ID SHAPES DRIFT BOTH WAYS — trust probes, not history: the deepseek lane
// served as the OpenRouter-style `deepseek/deepseek-v4.1-flash` 2026-09-24..30
// morning, then the account group flipped to the bare `deepseek-v4.1-flash`
// (prefixed → not supported, bare → serving, re-verified ×2 each direction
// within one day). deepseek-v4-pro flapped the same day too. Removing/re-adding
// on every flip is what the discovery change (add-llm-model-discovery) fixes.
// Order is policy: deepseek → glm → free pool (`:free` last), deepseek first
// because dshModels[0] is the fallback default when no DEFAULT_MODEL binding
// applies. gemma-4-26b and laguna-xs were rate-limited (not down) at probe
// time; they keep their seats.
const VOLCES_MODELS = [
  { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", contextWindow: 128000, maxTokens: 32768 },
  { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", contextWindow: 128000, maxTokens: 32768 },
  { id: "glm-5.3-flash", name: "GLM 5.3 Flash", contextWindow: 128000, maxTokens: 32768 },
  { id: "cohere/north-mini-code:free", name: "Cohere North Mini Code (free)", contextWindow: 128000, maxTokens: 8192 },
  { id: "dots-studio/dots-3-note-preview:free", name: "Dots 3 Note Preview (free)", contextWindow: 128000, maxTokens: 8192 },
  { id: "liquid/lfm-2.5-2.6b:free", name: "Liquid LFM 2.5 2.6B (free)", contextWindow: 128000, maxTokens: 8192 },
  { id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", name: "Nemotron 3 Nano Omni 30B (free)", contextWindow: 128000, maxTokens: 8192 },
  { id: "nvidia/nemotron-3-super-120b-a12b:free", name: "Nemotron 3 Super 120B (free)", contextWindow: 128000, maxTokens: 8192 },
  { id: "nvidia/nemotron-3-ultra-550b-a55b:free", name: "Nemotron 3 Ultra 550B (free)", contextWindow: 128000, maxTokens: 8192 },
  { id: "nvidia/nemotron-3.5-lightning:free", name: "Nemotron 3.5 Lightning (free)", contextWindow: 128000, maxTokens: 8192 },
  { id: "poolside/laguna-s-2.1:free", name: "Poolside Laguna S 2.1 (free)", contextWindow: 128000, maxTokens: 8192 },
  { id: "google/gemma-4-26b-a4b-it:free", name: "Gemma 4 26B A4B (free)", contextWindow: 128000, maxTokens: 8192 },
  { id: "poolside/laguna-xs-2.1:free", name: "Poolside Laguna XS 2.1 (free)", contextWindow: 128000, maxTokens: 8192 },
];

// Thinking levels a model may be asked for. dsh-llm resolves an explicit effort
// against the model's declared map and throws UNSUPPORTED_REASONING_EFFORT on a
// miss, so only declare what the gateway actually accepts. Wire value = the
// level string itself (the OpenAI `reasoning_effort` field).
// ponytail: deepseek-v4 only until another family is verified — a wrong `false`
// just hides a control, a wrong map is a dispatch error.
const IDENTITY_EFFORTS = { low: "low", medium: "medium", high: "high" };

function declaredEfforts(modelId) {
  // `deepseek-v4*` and `deepseek/deepseek-v4*` are the reasoning families
  // (reasoning field verified live on both id shapes).
  return modelId.startsWith("deepseek-v4") || modelId.startsWith("deepseek/deepseek-v4")
    ? IDENTITY_EFFORTS
    : false;
}

// The env route's current roster ids — the baseline a "volces" model sync
// dry-run diffs against (llm-providers.syncProvider, add-llm-model-discovery).
export function volcesModelIds() {
  return VOLCES_MODELS.map((m) => m.id);
}

// The selectable level names for a `reasoningEfforts` declaration (`false` =
// non-reasoning model → no control).
export function effortLevels(reasoningEfforts) {
  return reasoningEfforts && typeof reasoningEfforts === "object" ? Object.keys(reasoningEfforts) : [];
}

// Persisted per-provider thinking level (`llm.effort.<provider>` in the prefs
// table). Read here rather than passed in so every writeLlmProfile() caller —
// including the runtime model refresh — reproduces the choice.
async function persistedEffort(providerId) {
  try {
    const db = await import("./db.js");
    if (!db.isDbReady()) return null;
    return db.getPreference(`llm.effort.${providerId}`) || null;
  } catch {
    return null;
  }
}

// Normalize an LLM baseURL to include the API-version path (OpenAI convention).
// dsh's bundled pi-ai builds the request URL as `${baseURL}/chat/completions`; a
// bare host:port hits `/chat/completions`, which the gateway accepts but returns
// a stream whose finish chunk never registers, tripping pi-ai's
// "Stream ended without finish_reason". `/v1/chat/completions` returns a proper
// stream with finish_reason. So: no path → assume `/v1`; a URL already carrying
// a path (e.g. /api/coding/v3, /v1) is left untouched.
// ponytail: assumes /v1 for pathless origins; a gateway on /v2 must set the
// full path in LLM_BASE_URL.


// Effective volces roster + base URL (add-editable-llm-route, design D2):
// override > env > baked VOLCES_MODELS. The override store is read through
// the same lazy import used for user providers below (cycle-safe — the two
// modules only ever import each other lazily). Returns raw roster entries in
// the normalized {id,name,contextWindow,maxTokens} shape.
export async function effectiveVolcesRoute() {
  let override = null;
  try {
    const userLlm = await import("./llm-providers.js");
    override = userLlm.getVolcesOverride();
  } catch {
    // Store unavailable → seed projection (env + baked roster).
  }
  const models = override?.models?.length ? override.models : VOLCES_MODELS;
  const baseURL = normalizeBaseUrl(
    override?.baseUrl ||
      process.env.LLM_BASE_URL ||
      "https://ark.cn-beijing.volces.com/api/coding/v3"
  );
  return { models, baseURL, hasOverride: Boolean(override) };
}

// Resilience contract baseline (add-llm-retry-resilience, ADR-0016): every
// generated route retries transient model-request failures with bounded
// backoff. The fallback bucket (PI_AI_ERROR) must be in the set because the
// adapter classifies by failure-text patterns — a gateway whose rejection
// wording defeats the patterns (sub2api's "Concurrency limit exceeded for
// user" carries neither "429" nor "rate limit") lands there, and an
// unrecognized error that produced no durable content is still transient.
// Bound: 5 attempts, 1s→15s exponential, 20% jitter. Shared with
// llm-providers.js (single source, no copies).
export const RETRY_POLICY = Object.freeze({
  mode: "normal",
  maxRetries: 5,
  retryableCodes: [
    "EMPTY_RESPONSE",
    "RATE_LIMIT",
    "SERVER",
    "TIMEOUT",
    "TRANSPORT",
    "PI_AI_ERROR",
  ],
  backoff: { initialDelayMs: 1000, maxDelayMs: 15000, jitterRatio: 0.2 },
});

// Build the llm-pi-ai providers dict + a flat {id,name,provider} model list from
// host env. No Volces key → empty providers (dormant); chat stays non-functional
// while static + REST still serve (graceful degrade, Task 3.6).
//
// User-added providers (llm-providers.js, managed via the Models page) are
// merged in after the env route. Their keys are referenced by env name and
// seeded into .credentials.yaml by ensureCredentialsStore(), so they hot-reload
// exactly like the Volces route.
export async function buildLlmProfile({
  llmApiKey = process.env.LLM_API_KEY?.trim(),
  llmBaseUrl = process.env.LLM_BASE_URL || "https://ark.cn-beijing.volces.com/api/coding/v3",
  efforts = null,
} = {}) {
  const providers = {};
  const models = [];

  if (llmApiKey) {
    const route = "volces";
    const effective = await effectiveVolcesRoute();
    // An operator base-URL override outranks everything; without one the
    // caller's parameter (the env seed) keeps its meaning (D2 precedence).
    const override = effective.hasOverride;
    const volcesModels = effective.models;
    providers[route] = {
      retryPolicy: { ...RETRY_POLICY, backoff: { ...RETRY_POLICY.backoff } },
      apiKeyEnv: "LLM_API_KEY",
      displayName: "Volces",
      api: "openai-completions",
      baseURL: override ? effective.baseURL : normalizeBaseUrl(llmBaseUrl),
      models: volcesModels.map((m) => ({ ...m, input: ["text"], reasoningEfforts: declaredEfforts(m.id) })),
    };
    for (const m of volcesModels) {
      const levels = effortLevels(declaredEfforts(m.id));
      models.push({ id: m.id, name: m.name, provider: route, ...(levels.length ? { reasoningEfforts: levels } : {}) });
    }
  }

  // Merge user-managed providers (Models page). Imported lazily to avoid a
  // cycle (llm-providers imports only paths.js).
  try {
    const userLlm = await import("./llm-providers.js");
    const { providers: userProviders, models: userModels } = userLlm.buildUserProviderEntries();
    Object.assign(providers, userProviders);
    models.push(...userModels);
  } catch (e) {
    console.warn(`[dsh-profile] user providers unavailable: ${e?.message || e}`);
  }

  // Project the persisted thinking level onto each route (dsh reads effort
  // per-provider, not per-model — design D1).
  //
  // `compat` states what pi-ai cannot infer: it reads wire compatibility from
  // the provider id and baseURL, and a private gateway's URL tells it nothing,
  // so it falls back to assuming real OpenAI. Every route here IS a private
  // OpenAI-compatible gateway. Route-level switches skip models whose protocol
  // does not take them (model-level ones would fail resolution), so this is
  // safe to apply to every route regardless of `api`.
  for (const [id, p] of Object.entries(providers)) {
    const level = efforts ? efforts[id] : await persistedEffort(id);
    if (level) p.reasoning = level;
    // pi-ai sends `role: "developer"` to reasoning models; gateways that
    // predate it answer 400 "invalid value: `developer`". `false` keeps `system`.
    p.compat = { supportsDeveloperRole: false, ...p.compat };
  }

  return { providers, models };
}

// ── Target-home parameterization (add-dsh-matrix-lock design D6) ─────────────
// The writers below target the deployment's singleton DSH_HOME by default
// (module-level constants). agent-runner/compose.js imports the SAME writers
// and passes { dshHome, profileName } explicitly, so every one of these file
// formats lives in exactly one place — the "formats mirrored in compose.js"
// drift risk is gone (a format change here IS the change, everywhere).
export function targetPaths(dirs) {
  if (!dirs) {
    return { settings: SETTINGS_PATH, credentials: CREDENTIALS_PATH, presetsPatch: PRESETS_PATCH_PATH };
  }
  const profileDir = join(dirs.dshHome, "profiles", dirs.profileName ?? PROFILE_NAME);
  return {
    settings: join(dirs.dshHome, "settings.yaml"),
    credentials: join(dirs.dshHome, ".credentials.yaml"),
    presetsPatch: join(profileDir, "presets.patch.yml"),
  };
}

// Write the llm-pi-ai section to $DSH_HOME/settings.yaml, preserving any other
// sections already in the document (data-loss safe). Atomic: temp+rename.
// Returns { providers, models } so server.js can source its model selector.
export async function writeLlmProfile(opts = {}) {
  const { dirs, ...buildOpts } = opts;
  const settingsPath = targetPaths(dirs).settings;
  const { providers, models } = await buildLlmProfile(buildOpts);
  let doc = {};
  try {
    const existing = readFileSync(settingsPath, "utf8");
    const loaded = yaml.load(existing);
    // Only keep an object document; a scalar/array means the file isn't a settings
    // map, so don't merge into it — recreate as a fresh object.
    if (loaded && typeof loaded === "object" && !Array.isArray(loaded)) doc = loaded;
  } catch (err) {
    // ENOENT is expected on first run; anything else is warned but not fatal.
    if (err.code !== "ENOENT") console.warn("[dsh-profile] settings.yaml unreadable, recreating:", err.message);
  }
  doc["llm-pi-ai"] = { providers };
  atomicWriteTextSync(settingsPath, yaml.dump(doc));

  if (Object.keys(providers).length === 0) {
    console.warn("[dsh] no LLM keys configured; chat non-functional (static + REST still served)");
  } else {
    console.log(
      `[dsh-profile] wrote ${Object.keys(providers).join(", ")} route(s), ${models.length} model(s) → ${settingsPath}`,
    );
  }
  return { providers, models };
}

// ── Provider credentials via dsh-credentials-local (design D3) ───────────────
// dsh-credentials-local resolves a key per-request with this layering (read-only
// layers win): inherited process env > .credentials.yaml > .env files. To make
// .credentials.yaml the live-rotatable source, the dsh child is spawned with a
// scrubbed env that omits the upstream keys (see buildScrubbedEnv + dsh-bridge
// `env` option), so the file is the winning layer. A rotated key written here
// then reaches the next LLM request without a dsh restart — dsh-credentials-local
// Chokidar-watches this file and re-resolves per request.
//
// Document is the version-1 layout dsh-credentials-local requires:
//   version: 1
//   refs:
//     LLM_API_KEY: <value>
//     LLM_PROVIDER_KEY_<ID>: <value>   (user-added providers, Models page)
// Seeded from process.env on first run (file absent); 0600 perms. Atomic write.
// User-provider keys are added here too so their apiKeyEnv refs resolve; a key
// rotation via the Models page re-runs this and hot-reloads (Chokidar watch).
const CREDENTIAL_REFS = ["LLM_API_KEY"];

export async function ensureCredentialsStore(opts = {}) {
  const credentialsPath = targetPaths(opts.dirs).credentials;
  let doc;
  try {
    const existing = readFileSync(credentialsPath, "utf8");
    const loaded = yaml.load(existing);
    doc = loaded && typeof loaded === "object" && !Array.isArray(loaded) ? loaded : {};
  } catch (err) {
    if (err.code !== "ENOENT" && err.code !== undefined) {
      // A malformed credentials doc is warned but not fatal — recreate it.
      console.warn(`[dsh-profile] .credentials.yaml unreadable, recreating: ${err.message}`);
    }
    doc = {};
  }
  doc.version = 1;
  doc.refs = doc.refs && typeof doc.refs === "object" ? doc.refs : {};
  let changed = false;
  for (const ref of CREDENTIAL_REFS) {
    const val = process.env[ref]?.trim();
    if (val && doc.refs[ref] !== val) { doc.refs[ref] = val; changed = true; }
  }
  // User-managed provider keys (Models page). These come from llm-providers.json,
  // not process.env; stale refs (a deleted provider) are pruned so a removed key
  // doesn't linger in the credentials file.
  try {
    const userLlm = await import("./llm-providers.js");
    const userRefs = userLlm.credentialRefsForUserProviders();
    const userRefNames = new Set(Object.keys(userRefs));
    for (const [name, val] of Object.entries(userRefs)) {
      if (doc.refs[name] !== val) { doc.refs[name] = val; changed = true; }
    }
    for (const name of Object.keys(doc.refs)) {
      if (name.startsWith("LLM_PROVIDER_KEY_") && !userRefNames.has(name)) {
        delete doc.refs[name];
        changed = true;
      }
    }
  } catch (e) {
    console.warn(`[dsh-profile] user credential refs unavailable: ${e?.message || e}`);
  }
  // Always (re)write on first run (file absent) so perms are set; otherwise
  // only write when a ref changed, to avoid needlessly tripping the watcher.
  const absent = !existsSync(credentialsPath);
  if (!changed && !absent) return { path: credentialsPath, changed: false };
  atomicWriteTextSync(credentialsPath, yaml.dump(doc));
  try { chmodSync(credentialsPath, 0o600); } catch { /* perms best-effort on some FS */ }
  console.log(`[dsh-profile] wrote credentials store (${Object.keys(doc.refs).join(", ") || "empty"}) → ${credentialsPath}`);
  return { path: credentialsPath, changed: true };
}

// Build a dsh child env that inherits the parent env MINUS the upstream API
// keys, so dsh-credentials-local's .credentials.yaml is the winning resolution
// layer (the inherited-env layer would otherwise shadow it). The parent keeps
// its own process.env for server-side consumers (documents RAG).
// Returns null when no upstream keys are configured (no scrubbing needed —
// caller passes null and HarnessClient inherits process.env as before).
export function buildScrubbedEnv() {
  const hasAny = CREDENTIAL_REFS.some((r) => process.env[r]?.trim());
  if (!hasAny) return null;
  const env = { ...process.env };
  for (const ref of CREDENTIAL_REFS) delete env[ref];
  return env;
}

// ── MCP server patch (dsh-mcp-client) ─────────────────────────────────────────
// dsh-mcp-client is a cordis LOADER entry (not a settings.yaml section): one
// plugin instance per MCP server, declared in a `--patch` overlay so the user's
// cordis.patch.yml stays untouched. Tool naming is mcp__<serverName>__<rawName>,
// the same convention the host's WS protocol already speaks, so the migration
// is invisible to anything that references tool names. failOnStartupError:false
// on every entry preserves "failed MCP server doesn't block startup" (Task 4.5);
// the plugin's default reconnect (500ms→30s backoff, 10 attempts) covers an OC
// runtime that boots in parallel with server.js (no host-side retry needed).
const PROFILE_NAME = process.env.DSH_PROFILE || "platform";
const MCP_PATCH_PATH = join(DSH_HOME, "profiles", PROFILE_NAME, "mcp.patch.yml");

// ── DSH home bootstrap ───────────────────────────────────────────────────────
// A hosted cell gets a FRESH DSH_HOME per user, so nothing about the profile
// can be assumed to exist the way it does in a long-lived ~/.dsh: dsh refuses
// to boot with `profile "platform" does not exist`, and even with the scaffold
// present it cannot resolve its bundles without the installed module tree.
// Materialize the scaffold from dsh-profile-template/ (the same four files the
// Dockerfile copies) and link the deployment's read-only module tree in, so
// every cell resolves identical code without a per-user install.
const TEMPLATE_DIR = join(dirname(fileURLToPath(import.meta.url)), "dsh-profile-template");
const SCAFFOLD_FILES = ["package.json", "pnpm-workspace.yaml", "cordis.yml", "cordis.patch.yml"];
// Two module levels matter: `profiles/node_modules` carries the bundles dsh
// composes (dsh-base, …), and `profiles/<name>/node_modules` carries the
// profile's own pinned deps (dsh-sdk-jsonrpc-server, dsh-agent-presets) that
// the preset bridge imports by bare specifier.
const MODULE_LINK_DIRS = [join("profiles", "node_modules"), join("profiles", PROFILE_NAME, "node_modules")];
// The deployment's installed dsh tree. Distinct from DSH_HOME only when DSH_HOME
// is a per-user cell home; in dev/desktop they are the same directory.
const SHARED_DSH_HOME = process.env.DSH_SHARED_HOME || join(homedir(), ".dsh");

export function ensureDshHome() {
  const profileDir = join(DSH_HOME, "profiles", PROFILE_NAME);
  mkdirSync(profileDir, { recursive: true });
  for (const file of SCAFFOLD_FILES) {
    const target = join(profileDir, file);
    if (!existsSync(target)) copyFileSync(join(TEMPLATE_DIR, file), target);
  }
  for (const dir of MODULE_LINK_DIRS) {
    const link = join(DSH_HOME, dir);
    const shared = join(SHARED_DSH_HOME, dir);
    if (existsSync(link) || resolve(shared) === resolve(link) || !existsSync(shared)) continue;
    try {
      symlinkSync(shared, link, "dir");
    } catch (err) {
      console.warn(`[dsh-profile] could not link shared dsh modules at ${dir}: ${err.message}`);
    }
  }
  linkProfilePinnedModules();
}

// The dsh loader resolves the profile's bare-specifier plugins ONLY from the
// profile's own node_modules (profiles/<name>/node_modules) — never from the
// app's top-level tree. Deployments provision that dir out-of-band (shared
// homes, Dockerfile installs, hand-made symlinks on dev machines); a packaged
// desktop install ships none of that, so the child died on the first bare
// import (win-install-smoke v1.3.2–v1.3.4: @deepseek-ai/dsh-sdk-jsonrpc-
// server unresolvable). Link the app's OWN copy in — the same package.json
// dependency that puts it in the installer also serves as the resolution
// source. junction on Windows (no admin rights needed); no-op when the
// deployment already provides one.
// The dsh loader imports profile bridge plugins with PLAIN module resolution
// anchored at the profile dir, so their bare-specifier imports resolve up the
// profile's own node_modules chain — never the app's tree, and never the dsh
// nested runtime. Deployments provision that dir out-of-band (shared homes,
// Dockerfile installs, hand-made symlinks on dev machines); a packaged desktop
// install ships none of it, so the child died on the first bare import
// (win-install-smoke v1.3.2–v1.3.4). Link EXACTLY the packages the bridges
// import, all pinned in the app's top-level tree at the server generation
// (rc.5) the bridges are built against. Deliberately NOT a scope blanket:
// the child runtime's own plugin names (dsh-llm-*, cordis-plugin-*, …) must
// keep resolving from the dsh nested tree — a top-level shadow there mixes
// the rc.2 runtime generation with the rc.5 server generation and explodes
// on first import (missing rc.2-only exports). No-op where a link exists.
const PROFILE_BRIDGE_PACKAGES = [
  "@deepseek-ai/schemastery",
  "@deepseek-ai/dsh-session",
  "@deepseek-ai/dsh-tools",
  "@deepseek-ai/dsh-sdk-jsonrpc-server",
];
const PROFILE_MODULE_DIR = join("profiles", PROFILE_NAME, "node_modules");
const APP_NODE_MODULES = join(dirname(fileURLToPath(import.meta.url)), "node_modules");
// The tree the dsh binary actually runs from — DSH_BIN's own node_modules
// (the image pins it to /opt/dsh; the desktop has no DSH_BIN and the app tree
// IS the runtime). Bridge-package links must come from THIS tree: linking the
// app tree's copies into a cell whose runtime is the matrix install gives the
// bridge a second instance of dsh-tools at a different realpath, and the two
// TOOL_RUNTIME_SCHEDULER Symbols stop matching (every tool call dies on
// undefined.prepare — 2026-10-09 sha-e956091). Same realpath as the flat
// profiles/node_modules fallback keeps the identity single.
const RUNTIME_NODE_MODULES = (() => {
  const bin = process.env.DSH_BIN || "";
  const marker = `${sep}node_modules${sep}`;
  const idx = bin.lastIndexOf(marker);
  if (idx !== -1) {
    const candidate = bin.slice(0, idx + marker.length - 1);
    if (existsSync(join(candidate, "@deepseek-ai", "dsh-tools", "package.json"))) return candidate;
  }
  return APP_NODE_MODULES;
})();

function linkProfilePinnedModules() {
  const moduleDir = join(DSH_HOME, PROFILE_MODULE_DIR);
  // The deployment may hand the profile its WHOLE tree as one symlink — the
  // image layout ($DSH_HOME/profiles/<name>/node_modules → /opt/dsh/node_modules,
  // the frozen matrix install). Every entry seen through it then belongs to
  // the deployment, and "clearing" one rms THROUGH the symlink: the real
  // package leaves the frozen tree, the app's copy takes its place, and the
  // generations mix (rc.2 runtime + rc.5 server). Observed on image-publish
  // 37847464206: the boot smoke passed, the platform's own boot mutated
  // /opt/dsh, and the contracts step then reported four packages "resolving
  // outside the candidate tree" with the child dead at handshake.
  //
  // So when the module dir is itself a symlink, it is ENTIRELY the
  // deployment's: never write an entry into it, not even a missing one. An
  // earlier revision linked the absent packages there and that was worse than
  // the mutation it replaced: the links pointed at the APP tree's copies
  // (dsh-tools rc.1 / dsh-session rc.5) while the runtime boots from the
  // matrix tree (rc.2), so the child loaded TWO instances of dsh-tools — two
  // TOOL_RUNTIME_SCHEDULER Symbols — and every tool call died with
  // "Cannot read properties of undefined (reading 'prepare')" (2026-10-09
  // prod roll sha-e956091, reproduced in-browser; chat turns without tools
  // worked, which is what made it look like a skill problem). Absence is the
  // deployment's business too: the matrix closure is complete, and dsh's own
  // boot healer fills the flat profiles/node_modules fallback. A real module
  // dir is ours to manage: stale leftovers there (the desktop v1.3.6 "exists
  // and is not a symlink" child death) are cleared and re-pointed at the app
  // copy.
  let moduleDirIsLink = false;
  try {
    moduleDirIsLink = lstatSync(moduleDir).isSymbolicLink();
  } catch {
    /* absent — the link loop below creates it */
  }
  if (moduleDirIsLink) {
    // Deployment-provisioned: touch nothing of the deployment's — except our
    // OWN earlier poison. A revision before this one linked the absent
    // packages here, pointing at the app tree; those links split the module
    // identity (see the note above) and must go. Only links whose target sits
    // under the APP tree (and NOT under the runtime tree — the desktop has no
    // DSH_BIN, so there they are the same place) are ours to remove; real
    // dirs (the deployment's own install) and links elsewhere are left alone.
    // The runtime then resolves through the flat profiles/node_modules
    // fallback that dsh's boot healer maintains from the matrix install.
    const appRoot = realpathSync(APP_NODE_MODULES);
    const runtimeRoot = realpathSync(RUNTIME_NODE_MODULES);
    if (appRoot === runtimeRoot) return; // desktop layout: nothing of ours can be poison here
    for (const pkg of PROFILE_BRIDGE_PACKAGES) {
      const link = join(moduleDir, pkg);
      let st = null;
      try {
        st = lstatSync(link);
      } catch {
        continue;
      }
      if (!st.isSymbolicLink()) continue;
      let target = "";
      try {
        target = realpathSync(link);
      } catch {
        continue; // dangling — not ours to judge
      }
      if (target === appRoot || target.startsWith(appRoot + sep)) {
        try {
          rmSync(link);
          console.log(`[dsh-profile] removed app-tree ${pkg} link from the deployment module dir (module-identity poison)`);
        } catch (err) {
          console.warn(`[dsh-profile] could not remove poisoned ${pkg} link at ${link}: ${err.message}`);
        }
      }
    }
    return;
  }
  for (const pkg of PROFILE_BRIDGE_PACKAGES) {
    const link = join(moduleDir, pkg);
    const source = join(RUNTIME_NODE_MODULES, pkg);
    if (!existsSync(source)) continue;
    let existing = null;
    try {
      existing = lstatSync(link);
    } catch {
      existing = null;
    }
    if (existing) {
      if (existing.isSymbolicLink()) {
        let same = false;
        try {
          same = realpathSync(link) === realpathSync(source);
        } catch {
          same = false; // dangling link — relink below
        }
        if (same) continue;
      }
      try {
        rmSync(link, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[dsh-profile] could not clear stale ${pkg} at ${link}: ${err.message}`);
        continue;
      }
    }
    try {
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(source, link, process.platform === "win32" ? "junction" : "dir");
      console.log(`[dsh-profile] linked ${pkg} into the profile node_modules (packaged resolution)`);
    } catch (err) {
      console.warn(`[dsh-profile] could not link ${pkg}: ${err.message}`);
    }
  }
}

// Map one host MCP config ({command,args,env,cwd} stdio | {url,headers} http) to
// a dsh-mcp-client cordis loader entry. Unknown shape → null (skipped, warned).
function toMcpClientEntry(name, config) {
  if (!config || typeof config !== "object") return null;
  const entry = {
    id: `mcp-${name}`,
    name: "@deepseek-ai/dsh-mcp-client",
    config: { serverName: name, failOnStartupError: false },
  };
  if (config.command) {
    entry.config.transport = "stdio";
    entry.config.command = config.command;
    if (config.args) entry.config.args = config.args;
    // envRefs: names of environment variables to forward EXPLICITLY. dsh's
    // subprocess layer scrubs credential-shaped names (KEY/PASSWORD/SECRET/
    // TOKEN) from MCP children, so e.g. SEARCH_RELAY_TOKEN never survives the
    // ambient-env hop — dsh-subprocess's sanctioned path for a deliberate
    // credential is exactly this per-entry env, merged after its scrub. Only
    // NAMES live in the manifest/DB (git-safe); values resolve here from
    // process.env at every patch write, so a rotated token lands on the next
    // restart/HMR swap. An unset ref is warned and omitted — the server
    // degrades to its own "not configured" behavior.
    if (Array.isArray(config.envRefs)) {
      const resolved = {};
      for (const ref of config.envRefs) {
        const v = process.env[ref];
        if (v == null || v === "") {
          console.warn(`[dsh-profile] MCP "${name}" envRef ${ref} is not set; the server may run degraded`);
          continue;
        }
        resolved[ref] = v;
      }
      if (Object.keys(resolved).length) entry.config.env = { ...(config.env || {}), ...resolved };
    } else if (config.env) {
      entry.config.env = config.env;
    }
    // Relative command/args are authored against the repo root (where
    // mcp.json lives). The dsh child's cwd is the WORKSPACE and moves on
    // set_workspace, so pin the spawn cwd unless the config sets one — an
    // unpinned relative path breaks the moment the user switches folders.
    // repoRoot, not process.cwd(): hosted cells run from a per-user runtime
    // cwd, which would strand every relative arg (2026-10-01 cutover live
    // finding: websearch-mcp MODULE_NOT_FOUND killed the dsh plugin tree).
    entry.config.cwd = config.cwd || repoRoot(".");
  } else if (config.url) {
    entry.config.transport = "streamable-http";
    entry.config.url = config.url;
    if (config.headers) entry.config.headers = config.headers;
  } else {
    return null;
  }
  return entry;
}

// Gather MCP server configs from every host source, merge (DB wins on name
// collision; a DB-disabled row drops its entry), and write a cordis patch file
// of dsh-mcp-client entries. Returns the patch path, or null when there are no
// servers (caller skips `--patch`). Atomic: temp+rename.
//
// Sources (design D4 — host-side config sources unchanged):
//   mcp.json            — operator config (base layer)
//   SQLite MCP table    — user edits via REST; overrides on collision (Task 4.1)
//
// userGroups (nullable array) role-filters DB rows stamped with
// requiredGroups: a gated row stays in the effective profile only while the
// profile user holds a matching group, so an identity-provider revocation
// lands on the next patch write with no record mutation. null (no
// authenticated identity — auth off) filters nothing.
//
// ownerEmail is the identity the effective profile is generated FOR. It
// resolves the credentials of ref-carrying servers (config.credentialRef,
// dispatched by name through credential-refs.js — registry, connector, …):
// the Authorization header is read from that user's stored credential at each
// write — never from the installed record — so a refreshed token takes effect
// without reinstalling. No live credential for a ref ⇒ that ref's servers are
// omitted with a warning (same shape as the requiredGroups filter), and their
// records survive.
//
// agentPreset (add-pack-agent-scoping) selects the resource scope: a pack
// persona preset applies the subtractive focus layer after the personal
// overlay (see deriveScope); null / a shipped preset composes full.
// noOverlay (add-focus-overlay) suppresses the preset's stored preference
// diff — the probe's derived-vs-derived±overlay report needs the pre-overlay
// composition; every runtime path keeps the default (compose with overlay).
export async function writeMcpPatch({ mcpOverlay, userGroups = null, ownerEmail = null, agentPreset = null, noOverlay = false } = {}) {
  // 1. mcp.json (operator config, base layer).
  let mcpJsonServers = {};
  try {
    mcpJsonServers = JSON.parse(readFileSync(MCP_CONFIG_PATH, "utf8")).mcpServers || {};
  } catch { /* no MCP config or parse error — MCP disabled via file */ }

  // Merge: mcp.json base → DB (enabled overrides, disabled drops).
  const servers = { ...mcpJsonServers };
  try {
    const db = await import("./db.js");
    if (db.isDbReady()) {
      const extensionStore = await import("./extension-store.js");
      for (const row of extensionStore.listMcpServers()) {
        if (row.enabled === false) { delete servers[row.name]; continue; }
        if (row.requiredGroups?.length && userGroups !== null &&
            !userGroups.some((g) => row.requiredGroups.includes(g))) {
          delete servers[row.name];
          continue;
        }
        servers[row.name] = row.config;
      }
    }
  } catch (e) {
    console.warn(`[dsh-profile] DB MCP read failed; mcp.json/OC only: ${e?.message || e}`);
  }

  // Resolve credential refs before anything else looks at the config: a
  // server whose ref cannot be resolved must never reach toMcpClientEntry with
  // a placeholder header. Dispatch is by ref name through the credential-refs
  // table, so each ref's servers inject or omit independently (registry and
  // connector coexist; a third ref registers without touching this loop).
  try {
    const refs = await import("./credential-refs.js");
    const resolved = refs.resolveCredentials(servers, ownerEmail);
    for (const { ref, names } of resolved.omitted) {
      console.warn(
        `[dsh-profile] omitting ${names.length} ${ref} MCP server(s) (${names.join(", ")}): no live credential for ${ownerEmail || "the machine owner"}`,
      );
    }
    if (resolved.error) {
      console.warn(`[dsh-profile] credential-ref resolution failed (${resolved.error}); every ref-carrying server omitted`);
    }
    // resolveCredentials returns a fresh object; move its result back into the
    // single `servers` map the later stages (overlay, focus) keep reading.
    for (const key of Object.keys(servers)) delete servers[key];
    Object.assign(servers, resolved.servers);
  } catch (e) {
    // The ref table itself is unavailable (import failure, DB error) — omit
    // every ref-carrying server rather than pass one through unauthenticated.
    console.warn(`[dsh-profile] credential-ref resolution failed; omitting those servers: ${e?.message || e}`);
    for (const [name, config] of Object.entries(servers)) {
      if (config?.credentialRef) delete servers[name];
    }
  }

  // Apply the active identity's availability overlay after the global merge.
  // This changes only the runtime patch; extension_configs remains untouched.
  if (mcpOverlay && typeof mcpOverlay === "object") {
    for (const [name, enabled] of Object.entries(mcpOverlay)) {
      if (servers[name] && typeof enabled === "boolean" && !enabled) delete servers[name];
    }
  }

  // Focus layer (add-pack-agent-scoping; custom presets add a third family —
  // add-custom-presets D3): a focused role (pack persona or custom preset)
  // keeps only the deployment baseline — every mcp.json server plus
  // PACK_BASELINE_MCP names resolved against the installed set — together
  // with the role's own MCP references. Subtractive and LAST, after the
  // personal overlay, so focusing can only narrow what the user already
  // enabled: a personal (or DB) disable always wins over a manifest or
  // preset reference. References naturally intersect with the installed set
  // here — an unresolvable ref matches nothing and drops out (a custom
  // preset's reference list resolving against the installed set IS the
  // composition-time truth).
  const scope = await deriveScope(agentPreset, { noOverlay });
  if (scope.packId || scope.source === "custom") {
    // The available-server map AFTER availability/group/credential filtering
    // but BEFORE the focus keep-set drops names — additions may only restore
    // from here, which makes "an addition can never resurrect a disabled,
    // group-gated, or credential-less server" structural instead of a check
    // (add-focus-overlay design D2).
    const available = { ...servers };
    const keep = new Set(Object.keys(mcpJsonServers));
    for (const name of baselineMcpNames()) {
      if (servers[name]) keep.add(name);
      else console.warn(`[dsh-profile] PACK_BASELINE_MCP entry "${name}" is not installed; skipping`);
    }
    for (const name of scope.mcpKeep ?? []) keep.add(name);
    const dropped = [];
    for (const name of Object.keys(servers)) {
      if (!keep.has(name)) {
        delete servers[name];
        dropped.push(name);
      }
    }
    // Overlay layer (add-focus-overlay D2) — applied LAST, after focus, so
    // removals may drop any member of the derived set (baseline included:
    // user-level narrowing that edits no definition) and additions extend it
    // from the enabled universe captured above. Dangling entries (the pack
    // upgraded past them, a server uninstalled) resolve to nothing and are
    // named once at warn level — inert by design, no error state to repair.
    let overlayLog = "";
    if (scope.overlay) {
      const danglingAdd = [];
      const danglingRemove = [];
      for (const name of scope.overlay.addMcp ?? []) {
        if (servers[name]) continue; // already derived in (baseline or pack ref)
        if (available[name]) servers[name] = available[name];
        else danglingAdd.push(name);
      }
      for (const name of scope.overlay.removeMcp ?? []) {
        if (servers[name]) delete servers[name];
        else danglingRemove.push(name);
      }
      overlayLog =
        ` +overlay[add:${(scope.overlay.addMcp ?? []).join(",") || "-"};` +
        `remove:${(scope.overlay.removeMcp ?? []).join(",") || "-"}]`;
      if (danglingAdd.length || danglingRemove.length) {
        console.warn(
          `[dsh-profile] overlay dangling entries ignored: add [${danglingAdd.join(", ")}], remove [${danglingRemove.join(", ")}]`,
        );
      }
    }
    const effective = [...new Set([...keep, ...(scope.overlay?.addMcp ?? [])])]
      .filter((n) => servers[n]);
    console.log(
      scope.source === "custom"
        ? `[dsh-profile] focused on custom preset "${scope.customPresetName}" (${scope.customPresetId})` +
            `: keeping [${effective.join(", ") || "(none)"}]` +
            (dropped.length ? `, dropped [${dropped.join(", ")}]` : "") +
            overlayLog
        : `[dsh-profile] focused on pack "${scope.packName}" (${scope.packId})` +
            (scope.persona ? ` persona "${scope.persona}"` : "") +
            `: keeping [${effective.join(", ") || "(none)"}]` +
            (dropped.length ? `, dropped [${dropped.join(", ")}]` : "") +
            overlayLog,
    );
  }

  const entries = [];
  for (const [name, config] of Object.entries(servers)) {
    const e = toMcpClientEntry(name, config);
    if (e) entries.push(e);
    else console.warn(`[dsh-profile] skipping MCP server "${name}": unknown config shape`);
  }

  if (entries.length === 0) {
    console.log("[dsh-profile] no MCP servers configured; skipping --patch");
    return null;
  }
  mkdirSync(dirname(MCP_PATCH_PATH), { recursive: true });
  // Wrap entries in an `insert` list — a bare `{id, config}` is treated by
  // cordis-plugin-include as an override-by-id on an EXISTING entry, and since
  // these mcp-client entries don't exist in the base bundle they'd be warned +
  // skipped ("patch: entry "mcp-x" not found"). `insert` tells cordis to add
  // them as new loader entries. (The skills patch differs: skill-filesystem
  // DOES exist in the base bundle, so its override-by-id shape is correct.)
  atomicWriteTextSync(MCP_PATCH_PATH, yaml.dump([{ insert: entries }]));
  console.log(
    `[dsh-profile] wrote ${entries.length} MCP server(s): ${entries.map((e) => e.config.serverName).join(", ")} → ${MCP_PATCH_PATH}`,
  );
  return MCP_PATCH_PATH;
}

// ── Skills discovery patch (dsh-skill-filesystem) ──────────────────────────────
// The dsh-skill-filesystem plugin ships in the dsh-base bundle with no config, so
// it scans only its built-in roots (project .dsh/.agents, user ~/.dsh/~/.agents).
// To expose the project's skills/ dir, override the entry's config with
// customSkillDirs. This is
// an override-by-id patch (skill-filesystem exists in the base bundle, so cordis
// applies it — unlike the mcp entries, which are inserts). The dir is static, so
// written once at startup; no live-reload (skills/ doesn't change at runtime).
//
// add-pack-agent-scoping: customSkillDirs is a flat root list with no nested
// recursion, so the root list IS the scope. Full mode lists the deployment
// skills/ root, the user materialization root, and every pack root; focused
// mode (a pack persona preset) lists the skills/ baseline plus the focused
// pack's root only. The writer derives the list from the preset (deriveScope),
// the same invariant writeMcpPatch applies.
const SKILLS_PATCH_PATH = join(DSH_HOME, "profiles", PROFILE_NAME, "skills.patch.yml");

export async function writeSkillsPatch({ agentPreset = null, extraDirs = [], noOverlay = false } = {}) {
  // ponytail: single static entry; customSkillDirs is the only field that matters
  // (providerName/includeDefaultRoots/watch take schema defaults when config is
  // overridden, so the built-in discovery roots are preserved). extraDirs appends
  // deployment-specific roots after the derived set.
  const scope = await deriveScope(agentPreset, { noOverlay });
  // repoRoot: cells sit in a per-user cwd; the baseline skills/ dir ships in the image.
  const dirs = [repoRoot("skills")];
  if (scope.source === "custom") {
    // Custom preset (add-custom-presets D3): the compose root IS the scope —
    // the row's whole reference list is the declaration (empty = baseline
    // only, skillsDir null). Rebuilt here, idempotently from the DB rows
    // (the availability truth), before it is listed; the overlay applies on
    // top with the same add/remove rules as pack roles.
    let skillsDir = null;
    try {
      const sm = await import("./skill-materialize.js");
      const db = await import("./db.js");
      const enabledRows = db.isDbReady()
        ? db.listCustomSkills().filter((s) => s.enabled !== false)
        : [];
      skillsDir = sm.buildCustomPresetSkillsRoot(
        scope.customPresetId,
        scope.skillsDecl,
        enabledRows,
        scope.overlay,
      );
    } catch (e) {
      console.warn(`[dsh-profile] custom preset compose root unavailable; skills patch is baseline-only: ${e?.message || e}`);
      skillsDir = null;
    }
    if (skillsDir) dirs.push(skillsDir);
  } else if (scope.packId) {
    // Focused: baseline + the persona's own skills scope. skillsDir is the
    // pack root for an undeclared persona (pre-change path, byte-identical);
    // a DECLARED persona scopes via its compose root (D3) — rebuilt here,
    // idempotently from the DB rows, before it is listed (deriveScope only
    // reports it once it exists). A present-but-empty declaration (or a
    // persona-only pack) focuses to the baseline alone (skillsDir null).
    // An OVERLAY forces the compose root too (add-focus-overlay D2): even an
    // undeclared persona needs per-role composition once its set is adjusted,
    // with the whole-pack set as the base the diff applies over.
    let skillsDir = scope.skillsDir;
    if (Array.isArray(scope.skillsDecl) || scope.overlay) {
      try {
        const sm = await import("./skill-materialize.js");
        const db = await import("./db.js");
        const enabledRows = db.isDbReady()
          ? db.listCustomSkills().filter((s) => s.enabled !== false)
          : [];
        const ownedRows = enabledRows.filter((s) => s.originPackId === scope.packId);
        skillsDir = sm.buildPersonaSkillsRoot(
          scope.packId,
          scope.persona ?? String(agentPreset),
          Array.isArray(scope.skillsDecl) ? scope.skillsDecl : null,
          ownedRows,
          scope.overlay,
          // Additions draw from the whole materialized universe (any pack or
          // the user root), not just this pack — a skill owned by another
          // installed pack composes in through a cross-root link.
          enabledRows,
        );
      } catch (e) {
        console.warn(`[dsh-profile] persona compose root unavailable; skills patch is baseline-only: ${e?.message || e}`);
        skillsDir = null;
      }
    }
    if (skillsDir) dirs.push(skillsDir);
  } else {
    // Full: the user root plus every pack root (pack roots are nested under
    // custom-skills/packs/, invisible from the user root — no recursion).
    try {
      const sm = await import("./skill-materialize.js");
      dirs.push(sm.MATERIALIZE_DIR);
      dirs.push(...sm.listPackSkillsRoots());
    } catch (e) {
      // Materialization unavailable ⇒ baseline only, the pre-scoping degrade.
      console.warn(`[dsh-profile] skill materialization unavailable; skills patch is baseline-only: ${e?.message || e}`);
    }
  }
  dirs.push(...(Array.isArray(extraDirs) ? extraDirs : [extraDirs]).filter(Boolean));
  const entry = {
    id: "skill-filesystem",
    name: "@deepseek-ai/dsh-skill-filesystem",
    config: { customSkillDirs: dirs },
  };
  atomicWriteTextSync(SKILLS_PATCH_PATH, yaml.dump([entry]));
  const focusLabel = scope.source === "custom"
    ? `focused: ${scope.customPresetId}`
    : scope.packId
      ? `focused: ${scope.packId}`
      : "full";
  console.log(
    `[dsh-profile] wrote skills patch (${focusLabel}${scope.overlay ? " +overlay" : ""}; customSkillDirs: ${dirs.join(", ")}) → ${SKILLS_PATCH_PATH}`,
  );
  return SKILLS_PATCH_PATH;
}

// ── Pack agent resource scope (add-pack-agent-scoping) ───────────────────────
// Selecting a pack persona focuses the runtime: only the deployment baseline
// plus that pack's resource set loads (spec: pack-agent-scoping). The scope is
// a DERIVED invariant — f(selected preset), evaluated inside both patch
// writers on every write — so boot, MCP CRUD, preset switches and crash
// respawns all compose consistently with no scope preference that can drift.
// Shipped presets and every non-pack preset keep the full surface.

// PACK_BASELINE_MCP: comma/space-separated server names that stay loaded in
// EVERY mode on top of the mcp.json operator layer (operator-owned; fd-prod
// lists e.g. websearch). Resolved against installed servers at write time —
// an unresolvable name warns and skips, the envRefs convention.
function baselineMcpNames() {
  return (process.env.PACK_BASELINE_MCP || "").split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}

// Stage 1 — preset id → persona: the merged-catalog entry's installed pack
// plus the manifest's agent entry, or (third family, add-custom-presets D3)
// the entry's user_presets row. Going through the MERGED catalog (not the
// installed-pack list) keeps derivation honest about shadowing: an id the
// cloud or agents.json overrides is no longer a pack persona OR a custom
// preset — its generated preset composes the overriding entry's persona — so
// it resolves to no persona and runs full. Requires the generated preset to
// exist for the id (hasCatalogAgentPreset); a departed entry's preset is
// pruned, and its stale selection self-heals. Returns null for every
// full-mode case; otherwise { source: "pack", packId, packName, manifest,
// agent } or { source: "custom", row }. Exported for the follow-up changes
// (overlay, custom presets) that feed the same derivation.
export async function resolvePersona(presetId) {
  if (!presetId || SHIPPED_PRESET_IDS.includes(presetId)) return null;
  let entry = null;
  try {
    const catalog = await import("./catalog.js");
    // Match the catalog id in EITHER form: callers hold the catalog id (the
    // picker, the overlay panel) or its roster/dash form (ctx.currentPreset,
    // which is what a switch persisted into the runtime).
    entry = catalog.getChatAgentEntries().find(
      (e) => (e.packId || e.customPreset) && (e.id === presetId || rosterPresetId(e.id) === presetId),
    ) || null;
  } catch (e) {
    console.warn(`[dsh-profile] scope derivation: catalog unavailable (${e?.message || e}); composing full`);
    return null;
  }
  if (!entry || !hasCatalogAgentPreset(entry.id)) return null;
  // Third family — the custom preset's row IS the resource truth (its
  // reference list resolves against the locally-available universe at
  // composition time; nothing to repair when packs come and go).
  if (entry.customPreset) {
    let row = null;
    try {
      const db = await import("./db.js");
      if (db.isDbReady()) row = db.getUserPreset(entry.id);
    } catch { /* DB off ⇒ full */ }
    if (!row) {
      console.warn(`[dsh-profile] preset '${entry.id}' names a custom preset that no longer exists; composing full`);
      return null;
    }
    return { source: "custom", catalogId: entry.id, row };
  }
  // → the installed pack's manifest (the resource set's source of truth). A
  // pack that left composes full — derivation self-heals a stale selection.
  let installed = null;
  try {
    const db = await import("./db.js");
    if (db.isDbReady()) installed = db.getInstalledPack(entry.packId);
  } catch { /* DB off ⇒ full */ }
  if (!installed?.manifest) {
    console.warn(`[dsh-profile] preset '${entry.id}' names pack '${entry.packId}' which is not installed; composing full`);
    return null;
  }
  const agent = (installed.manifest.agents ?? []).find((a) => a?.id === entry.id) ?? null;
  return { source: "pack", catalogId: entry.id, packId: entry.packId, packName: installed.name ?? entry.packId, manifest: installed.manifest, agent };
}

// Stage 2 — persona → effective resource set. Returns { source: null } for
// full mode, { source: "pack", packId, packName, persona, mcpKeep, skillsDir,
// skillsDecl, overlay } for a pack persona, or { source: "custom",
// customPresetId, customPresetName, mcpKeep, skillsDir, skillsDecl, overlay }
// for a custom preset. Declaration semantics (D2/D4): a pack persona's absent
// dimension keeps the whole-pack set for it, a present one narrows
// (present-but-empty ⇒ none for that dimension); a custom preset's reference
// list is always the declaration (empty ⇒ baseline only). Pure derivation
// (DB/catalog reads only, no writes — the compose roots are BUILT by
// writeSkillsPatch, which is why skillsDir reports the root only once it
// exists), so a stale patch self-heals on the next write.
//
// add-focus-overlay: the preset's stored preference diff rides along as an
// additional derivation input (`overlay`, null when none is stored) — the
// effective scope stays f(selected preset, preset's overlay), still derived
// at every composition with no independent scope state. `noOverlay` suppresses
// the input for callers that need the pre-overlay derivation (the probe's
// derived-vs-derived±overlay report); it never affects full mode.
export async function deriveScope(agentPreset, { noOverlay = false } = {}) {
  const full = { source: null, packId: null, packName: null, persona: null, mcpKeep: null, skillsDir: null, skillsDecl: undefined, overlay: null };
  const persona = await resolvePersona(agentPreset);
  if (!persona) return full;
  let overlay = null;
  if (!noOverlay) {
    try {
      const db = await import("./db.js");
      // The diff is stored under the CATALOG id (the form the panel PUTs);
      // `agentPreset` may arrive as the roster/dash form.
      if (db.isDbReady()) overlay = db.getFocusOverlay(persona.catalogId ?? agentPreset);
    } catch { /* no overlay input ⇒ derived-only focus */ }
  }
  if (persona.source === "custom") {
    const row = persona.row;
    let skillsDir = null;
    try {
      const sm = await import("./skill-materialize.js");
      const dir = sm.customPresetSkillsRoot(row.id);
      if (existsSync(dir)) skillsDir = dir;
    } catch { /* no compose root yet ⇒ baseline-only focus */ }
    return {
      source: "custom",
      packId: null,
      packName: null,
      persona: null,
      customPresetId: row.id,
      customPresetName: row.name,
      mcpKeep: [...new Set(row.mcpServers ?? [])],
      skillsDir,
      skillsDecl: [...new Set(row.skills ?? [])],
      overlay,
    };
  }
  // D5 — the install report is the collision truth: a skill skipped at install
  // never materialized into the pack root, so the root itself already excludes
  // it; MCP refs intersect with the installed set at patch-write time.
  const packRefs = (persona.manifest.mcpServers ?? [])
    .map((m) => (typeof m?.registryName === "string" ? m.registryName : null))
    .filter(Boolean);
  const declaredMcp = persona.agent?.resources?.mcpServers;
  const mcpKeep = Array.isArray(declaredMcp)
    ? packRefs.filter((name) => declaredMcp.includes(name))
    : packRefs;
  const skillsDecl = persona.agent?.resources?.skills;
  let skillsDir = null;
  try {
    const sm = await import("./skill-materialize.js");
    if (Array.isArray(skillsDecl)) {
      // Declared skills dimension: the persona compose root is the scope
      // (built by writeSkillsPatch; empty declaration ⇒ null = baseline only).
      if (skillsDecl.length > 0) {
        const dir = sm.personaSkillsRoot(persona.packId, persona.agent?.id ?? String(agentPreset));
        if (existsSync(dir)) skillsDir = dir;
      }
    } else {
      const dir = sm.packSkillsRoot(persona.packId);
      if (existsSync(dir)) skillsDir = dir;
    }
  } catch { /* no pack root ⇒ baseline-only focus */ }
  return {
    source: "pack",
    packId: persona.packId,
    packName: persona.packName,
    persona: persona.agent?.id ?? null,
    mcpKeep,
    skillsDir,
    skillsDecl: Array.isArray(skillsDecl) ? skillsDecl : undefined,
    overlay,
  };
}

// ── Agent preset roster patch (dsh-agent-presets + preset bridge) ──────────────
// The dsh runtime composes agent presets (agent modes) through the
// @deepseek-ai/dsh-agent-presets roster service: it scans the SHIPPED preset
// root (config/agent-presets in the installed @deepseek-ai/dsh package) plus
// the user root (~/.dsh/.agent-presets, appended by the plugin's default
// includeUserRoot) and mounts the selected composition on each new session.
// The stock sdk-jsonrpc-server has zero preset awareness, so this generator
// also ships a small bridge plugin (dsh-profile-template/
// platform-preset-bridge.js, copied into the profile dir) that subclasses the
// SDK server: initialize carries the selected preset, session creation mounts
// it pre-publication, and a `presets/list` RPC serves the roster to the web
// picker. Everything rides one --patch overlay (presets.patch.yml):
//   - the stock `sdk-jsonrpc-server` row is disabled (a non-insert patch
//     cannot change a row's plugin name, and re-inserting the same id fails
//     the boot with "duplicate loader entry id" — so: disable + insert fresh);
//   - the `agent-presets` roster row is inserted (default `standard`, shipped
//     root at trust `system`);
//   - the bridge is inserted under a fresh `platform-sdk-server` row.
// Unresolvable shipped root → the whole overlay is skipped with a warning:
// chat still works on the bare host composition and the picker stays empty
// (graceful degradation, never a boot failure).
const PRESETS_PATCH_PATH = join(DSH_HOME, "profiles", PROFILE_NAME, "presets.patch.yml");
const BRIDGE_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "dsh-profile-template", "platform-preset-bridge.js");
const PRESET_BRIDGE_FILE = "platform-preset-bridge.js";
export const DEFAULT_AGENT_PRESET = "standard";

// Locate the installed @deepseek-ai/dsh package and return its shipped preset
// root (config/agent-presets), or null. The repo runtime cannot see the dsh
// package directly (it is not a dependency), so two anchors are tried: a
// repo-local install (createRequire from this module — the packaged-app
// layout) and the flat module fallback the dsh boot maintains for every
// profile ($DSH_HOME/profiles/node_modules/@deepseek-ai/dsh — the global
// install layout).
export function resolveShippedPresetRoot() {
  const anchors = [];
  try {
    anchors.push(join(dirname(createRequire(import.meta.url).resolve("@deepseek-ai/dsh/package.json"))));
  } catch { /* not repo-local — expected with a global dsh install */ }
  anchors.push(join(DSH_HOME, "profiles", "node_modules", "@deepseek-ai", "dsh"));
  // The Docker image's shared dsh install (the prefix that puts the `dsh` CLI
  // on PATH — see Dockerfile's /opt/dsh install layer). A freshly baked
  // /opt/dsh-home has no dsh self-install under profiles/node_modules yet, so
  // without this anchor a server image pod resolves nothing and the whole
  // preset roster silently vanishes on every boot.
  anchors.push("/opt/dsh/node_modules/@deepseek-ai/dsh");
  for (const anchor of anchors) {
    const root = join(anchor, "config", "agent-presets");
    if (existsSync(root) && statSync(root).isDirectory()) return root;
  }
  return null;
}

// Write the bridge plugin file + presets.patch.yml into the profile dir.
// Returns the patch path for the bridge's --patch args, or null when the
// shipped preset root cannot be resolved AND no extra roots were given (the
// platform's no-args call — caller omits the flag).
//
// Target-home + roster composition (add-dsh-matrix-lock design D6): agent-
// runner/compose.js calls this with its own { dshHome } plus the role's
// user-root roster, so the presets overlay format exists only here.
//   - dirs        { dshHome, profileName } — default the deployment singleton
//   - default     roster default preset id (platform: "standard")
//   - extraRoots  additional { path, trust } roster roots (runner: user root)
//   - requireRoster  false = write the overlay (bridge row) even when NO root
//                 resolves at all — the runner's children need the platform
//                 SDK server regardless of persona composition
export async function writePresetsPatch({ dirs, default: defaultPreset = DEFAULT_AGENT_PRESET, extraRoots = [], requireRoster = true } = {}) {
  const presetsPatchPath = targetPaths(dirs).presetsPatch;
  mkdirSync(dirname(presetsPatchPath), { recursive: true });
  // The bridge source is copied into the profile dir because the loader
  // resolves a relative plugin name beside the profile's cordis.yml. Written
  // UNCONDITIONALLY, before the roster check: platform-permission-bridge.js
  // (written by writePermissionsPatch, loaded by its unconditional overlay)
  // imports this file — skipping it here on an unresolvable preset root left
  // a dangling import that crashed dsh at boot (fresh baked /opt/dsh-home,
  // where no dsh self-install anchor exists yet).
  const bridgeTarget = join(dirname(presetsPatchPath), PRESET_BRIDGE_FILE);
  atomicWriteTextSync(bridgeTarget, readFileSync(BRIDGE_SOURCE, "utf8"));
  const presetRoot = resolveShippedPresetRoot();
  const roots = [...(presetRoot ? [{ path: presetRoot, trust: "system" }] : []), ...extraRoots];
  if (roots.length === 0 && requireRoster) {
    console.warn(
      `[dsh-profile] @deepseek-ai/dsh config/agent-presets not resolvable; skipping the agent-preset roster (picker stays empty, chat unaffected)`,
    );
    return null;
  }
  const patch = [
    { id: "sdk-jsonrpc-server", disabled: true },
    {
      insert: [
        ...(roots.length
          ? [{ id: "agent-presets", name: "@deepseek-ai/dsh-agent-presets", config: { default: defaultPreset, roots } }]
          : []),
        { id: "platform-sdk-server", name: `./${PRESET_BRIDGE_FILE}` },
      ],
    },
  ];
  atomicWriteTextSync(presetsPatchPath, yaml.dump(patch));
  console.log(
    `[dsh-profile] wrote preset bridge + roster patch (default: ${defaultPreset}, shipped root: ${presetRoot ?? "(none)"}) → ${presetsPatchPath}`,
  );
  return presetsPatchPath;
}

// ── Catalog agent presets (vertical-pack personas) ───────────────────────────
// A catalog `agent-remote` entry in chat mode names a vertical agent (合同审查官,
// 行业分析师, …). Served as a remote chat fork it is a bare LLM: it gets one
// user message, no system prompt, no tools — no memory, no MCP servers, no
// skills, so the pack it fronts cannot actually do its job. Serving it LOCALLY
// instead keeps the whole local runtime (tools, skills, MCP servers, session
// history) and only swaps the persona: one generated agent preset per entry,
// composed from the SHIPPED `standard` composition (so it tracks the installed
// dsh version and keeps every tool row) with the persona row's text replaced.
//
// Files land in the preset roster's user root ($DSH_HOME/.agent-presets/<id>)
// so dsh-agent-presets lists them beside the shipped four (trust: user) and the
// existing preset switch path applies them — see server/agent-session.js.
// Written at boot and again whenever the merged catalog changes; the host
// restarts the child on a change so `presets/list` re-reads the roster.
const CATALOG_PRESET_ROOT = join(DSH_HOME, ".agent-presets");
// Marks a directory as generated (and therefore prunable/writable) by us: a
// hand-authored user preset that happens to share an id is left alone.
const CATALOG_PRESET_MARKER = ".platform-catalog-preset.json";
// The four compositions dsh ships. A catalog entry may not shadow one, and the
// boot-time preset guard treats these as always-known.
const SHIPPED_PRESET_IDS = ["standard", "code", "minimal", "cordis"];

function isSafePresetId(id) {
  return typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id);
}

// Roster-facing preset id (add-custom-presets): dsh-agent-presets' id regex
// (/^[a-z0-9][a-z0-9-]*$/ — a path-containment boundary, not a style rule) is
// the roster alphabet, so this is the ONE place a catalog id becomes a
// directory name: every character outside it folds to a dash (dots in every
// custom preset's `user.<slug>`, and case-mixed base64url pack ids carrying
// `_` — the runner's `srv-<packId>-<agentId>` form). Discovery SILENTLY skips
// a directory whose name fails that regex, so a missed character here reads
// as "preset not found (available: standard, code, minimal, cordis)" at turn
// time — the pack-agent outage of 2026-10-09. The catalog keeps the original
// id; resolvePersona maps back. Collisions (a.b vs a-b) are resolved
// first-wins at generation time (writeCatalogAgentPresets).
export function rosterPresetId(catalogId) {
  return typeof catalogId === "string" ? catalogId.toLowerCase().replace(/[^a-z0-9-]+/g, "-") : catalogId;
}

// The persona text for one catalog entry: the entry's own `persona` when the
// catalog author supplies one, else a composed brief from its display fields.
// Bracket the role and the honesty rules — a pack agent that invents data is
// worse than one that says the tool found nothing.
//
// Pack-sourced entries additionally carry the focus note (add-pack-agent-
// scoping, design D6): the role's tools and skills focus on its pack, so a
// request for capability outside the set gets an honest "not enabled for this
// role" answer that points at switching back — never an invented result. The
// note is static because every pack entry is focused by definition.
const PACK_FOCUS_NOTE =
  "当前角色以聚焦模式运行：可用工具与技能仅限所属功能集与部署基线，不包含平台全部能力。用户要求使用未对当前角色启用的工具或数据源时，如实说明该能力未对当前角色启用，并建议切换回标准模式（standard）以获取完整能力；绝不虚构工具调用、数据或结论。";

// The same honesty contract for a custom preset (add-custom-presets): the
// focused set is the preset's own declared resources plus the baseline, not
// the platform's full surface.
const CUSTOM_FOCUS_NOTE =
  "当前角色以聚焦模式运行：可用工具与技能仅限本自建预设声明的资源与部署基线，不包含平台全部能力。用户要求使用未对当前角色启用的工具或数据源时，如实说明该能力未对当前角色启用，并建议切换回标准模式（standard）以获取完整能力；绝不虚构工具调用、数据或结论。";

export function catalogEntryPersona(entry) {
  const explicit = typeof entry?.persona === "string" ? entry.persona.trim() : "";
  const lines = [];
  if (explicit) {
    lines.push(explicit);
  } else {
    const tags = Array.isArray(entry?.tags) && entry.tags.length ? `（${entry.tags.join("·")}）` : "";
    const what = (entry?.description || "").trim();
    lines.push(`你是「${entry?.name || entry?.id}」${tags}${what ? `——${what}` : ""}。`);
    lines.push(
      "用户带着这一领域的真实问题来找你。需要数据、文件或动作时，直接调用你手中的工具（技能、MCP 服务、检索、命令行）去获取，不要凭记忆编造数字、条款或结论；工具没覆盖到的地方，如实说明「未启用/无数据源」。",
    );
    lines.push("回答用中文（除非用户使用其他语言）：结论先行，结构清晰，给出可执行的下一步；引用数据时标注来源。");
  }
  if (entry?.packId) lines.push(PACK_FOCUS_NOTE);
  else if (entry?.customPreset) lines.push(CUSTOM_FOCUS_NOTE);
  lines.push("You are powered by the {{model}} model; your working directory is {{cwd}}.");
  return lines.join("\n");
}

// Swap the `persona` row's `config.text` in a shipped agent-plane composition
// for `persona`. Text-level (not a YAML round-trip): the composition carries
// `!!js` tags and comments that js-yaml would not reproduce. The row's block
// scalar is replaced by a double-quoted scalar — JSON string escaping is valid
// YAML double-quoted style, so embedded newlines stay on one line.
export function composeAgentPreset(template, persona) {
  const rowAt = template.indexOf("- id: persona\n");
  if (rowAt < 0) throw new Error("shipped composition has no `persona` row");
  const textAt = template.indexOf("    text:", rowAt);
  const nextRowAt = template.indexOf("\n- ", rowAt + 1);
  if (textAt < 0 || (nextRowAt !== -1 && textAt > nextRowAt)) {
    throw new Error("shipped composition's `persona` row has no config.text");
  }
  const bodyStart = template.indexOf("\n", textAt) + 1;
  let bodyEnd = bodyStart;
  for (;;) {
    const nl = template.indexOf("\n", bodyEnd);
    if (nl < 0) break;
    const line = template.slice(bodyEnd, nl);
    if (!/^\s{6,}\S/.test(line)) break;
    bodyEnd = nl + 1;
  }
  const quoted = JSON.stringify(persona.trim());
  return `${template.slice(0, textAt)}    text: ${quoted}\n${template.slice(bodyEnd)}`;
}

// The installed composition a generated preset is built from; null when the
// shipped preset root is unresolvable (bare deployment → no pack personas).
function shippedStandardComposition() {
  const root = resolveShippedPresetRoot();
  if (!root) return null;
  const file = join(root, "standard", "agent.cordis.yml");
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

// Preset ids the deployment can boot with: the shipped four plus every valid
// preset directory in the user root (generated pack presets included). Used to
// validate the persisted preset choice BEFORE the child spawns — an unknown id
// there would fail every new session's mount.
export function knownPresetIds() {
  const ids = new Set();
  const shipped = resolveShippedPresetRoot();
  for (const id of SHIPPED_PRESET_IDS) {
    if (shipped && existsSync(join(shipped, id, "agent.cordis.yml"))) ids.add(id);
  }
  try {
    for (const dirent of readdirSync(CATALOG_PRESET_ROOT, { withFileTypes: true })) {
      if (dirent.isDirectory() && existsSync(join(CATALOG_PRESET_ROOT, dirent.name, "agent.cordis.yml"))) {
        ids.add(dirent.name);
      }
    }
  } catch { /* no user preset root — shipped only */ }
  return ids;
}

// Does this catalog entry id have a generated local-preset composition? True ⇒
// the id is served by the LOCAL agent (tools + history + persona) rather than
// forked to its remote endpoint.
export function hasCatalogAgentPreset(id) {
  if (!isSafePresetId(id)) return false;
  return existsSync(join(CATALOG_PRESET_ROOT, rosterPresetId(id), "agent.cordis.yml"));
}

// Generate/refresh/prune one preset dir per chat-mode catalog agent. Returns
// { changed, ids }: `changed` drives the host's roster refresh (a child restart
// is what makes `presets/list` see a new preset). Idempotent — files are only
// rewritten when their content differs, so a catalog poll costs nothing.
// Directory names are the ROSTER form of the entry id (dots → dashes — the
// plugin's containment regex); the marker's entryId keeps the catalog form.
export function writeCatalogAgentPresets(entries = []) {
  const template = shippedStandardComposition();
  const wanted = new Map();
  for (const entry of entries) {
    if (entry?.type !== "agent-remote" || entry.mode !== "chat" || !entry.id) continue;
    // `local: false` is the operator saying "this entry IS a remote service" —
    // it keeps the OpenAI-compatible fork and gets no persona preset.
    if (entry.local === false) continue;
    if (!isSafePresetId(entry.id) || SHIPPED_PRESET_IDS.includes(entry.id)) {
      console.warn(`[dsh-profile] catalog agent '${entry.id}' cannot become a preset (unsafe or reserved id); it stays a remote chat`);
      continue;
    }
    const dirId = rosterPresetId(entry.id);
    if (wanted.has(dirId)) {
      console.warn(`[dsh-profile] catalog agents '${wanted.get(dirId).id}' and '${entry.id}' map to the same preset dir '${dirId}'; the latter stays a remote chat`);
      continue;
    }
    wanted.set(dirId, entry);
  }
  if (!template) {
    if (wanted.size) console.warn("[dsh-profile] shipped `standard` composition unavailable; skipping catalog agent presets");
    return { changed: false, ids: [] };
  }

  let changed = false;
  // Prune generated presets whose entry left the catalog (never touch dirs we
  // did not generate: no marker ⇒ someone's own preset).
  let existing = [];
  try {
    existing = readdirSync(CATALOG_PRESET_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(CATALOG_PRESET_ROOT, d.name, CATALOG_PRESET_MARKER)))
      .map((d) => d.name);
  } catch { /* no root yet */ }
  for (const id of existing) {
    if (wanted.has(id)) continue;
    rmSync(join(CATALOG_PRESET_ROOT, id), { recursive: true, force: true });
    console.log(`[dsh-profile] pruned catalog agent preset '${id}' (no longer in the catalog)`);
    changed = true;
  }

  const ids = [];
  wanted.forEach((entry, dirId) => {
    const dir = join(CATALOG_PRESET_ROOT, dirId);
    const name = entry.name || entry.id;
    const description = (entry.description || `Catalog agent ${name}`).trim();
    const meta = { entryId: entry.id, name, description, order: 50 + ids.length };
    const files = {
      "preset.yml": yaml.dump({ name, description, order: meta.order }),
      "agent.cordis.yml": composeAgentPreset(template, catalogEntryPersona(entry)),
      [CATALOG_PRESET_MARKER]: `${JSON.stringify({ ...meta, generator: "paas-catalog" }, null, 2)}\n`,
    };
    mkdirSync(dir, { recursive: true });
    for (const [file, content] of Object.entries(files)) {
      const target = join(dir, file);
      let current = null;
      try { current = readFileSync(target, "utf8"); } catch { /* absent */ }
      if (current === content) continue;
      atomicWriteTextSync(target, content);
      changed = true;
    }
    ids.push(dirId);
  });
  if (changed) {
    console.log(`[dsh-profile] wrote ${ids.length} catalog agent preset(s): ${ids.join(", ") || "(none)"} → ${CATALOG_PRESET_ROOT}`);
  }
  return { changed, ids };
}

// ── Permission preset bridge patch (add-permission-mode-selector) ─────────────
// The permission-mode selector rides the preset bridge: the composed
// dsh-permission-presets table (read-only / workspace-write / danger-full-access,
// default from DSH_PERMISSION_MODE) is exposed through a subclassed server.
// A cordis patch cannot rewrite an inserted row's plugin name (same constraint
// that made presets.patch.yml disable+insert), so this overlay disables the
// `platform-sdk-server` row and inserts `platform-permission-server` pointing
// at ./platform-permission-bridge.js — a subclass that adds permissions/list
// and permissions/set while inheriting the preset behavior. Ordering matters:
// the host passes presets.patch.yml BEFORE this file in --patch args.
const PERMISSIONS_PATCH_PATH = join(DSH_HOME, "profiles", PROFILE_NAME, "permissions.patch.yml");
const PERMISSION_BRIDGE_SOURCE = join(
  dirname(fileURLToPath(import.meta.url)),
  "dsh-profile-template",
  "platform-permission-bridge.js",
);
const PERMISSION_BRIDGE_FILE = "platform-permission-bridge.js";

// Write the permission bridge file + permissions.patch.yml into the profile
// dir. Returns the patch path for the --patch args. The overlay is written
// unconditionally (the permission-presets plugin composes from the dsh-base
// bundle in every real deployment; an absent service degrades to an empty
// roster inside the bridge — the picker stays hidden, chat unaffected).
export async function writePermissionsPatch() {
  mkdirSync(dirname(PERMISSIONS_PATCH_PATH), { recursive: true });
  const bridgeTarget = join(dirname(PERMISSIONS_PATCH_PATH), PERMISSION_BRIDGE_FILE);
  atomicWriteTextSync(bridgeTarget, readFileSync(PERMISSION_BRIDGE_SOURCE, "utf8"));
  const patch = [
    { id: "platform-sdk-server", disabled: true },
    {
      insert: [{ id: "platform-permission-server", name: `./${PERMISSION_BRIDGE_FILE}` }],
    },
  ];
  atomicWriteTextSync(PERMISSIONS_PATCH_PATH, yaml.dump(patch));
  console.log(`[dsh-profile] wrote permission bridge patch → ${PERMISSIONS_PATCH_PATH}`);
  return PERMISSIONS_PATCH_PATH;
}

// ── Tool-search bridge patch (add-tool-discovery-layer) ─────────────────────
// The read-only `tool_search` tool (search the effective roster, return exact
// callable names) rides its own overlay: platform-tool-search-bridge.js is
// copied into the profile dir and inserted under a fresh `tool-search-bridge`
// row. It injects only `tools` (the dsh tool registry) and reads the calling
// agent's schema projection per call, so no other row changes. Purely
// additive: if the overlay is absent the roster is unchanged and chat works
// exactly as before.
const TOOL_SEARCH_PATCH_PATH = join(DSH_HOME, "profiles", PROFILE_NAME, "tool-search.patch.yml");
const TOOL_SEARCH_BRIDGE_SOURCE = join(
  dirname(fileURLToPath(import.meta.url)),
  "dsh-profile-template",
  "platform-tool-search-bridge.js",
);
const TOOL_SEARCH_MATCHER_SOURCE = join(
  dirname(fileURLToPath(import.meta.url)),
  "server",
  "tool-discovery.js",
);

// Write the tool-search bridge + its matcher module + tool-search.patch.yml
// into the profile dir. Returns the patch path for the --patch args.
export function writeToolSearchPatch() {
  mkdirSync(dirname(TOOL_SEARCH_PATCH_PATH), { recursive: true });
  const profileDir = dirname(TOOL_SEARCH_PATCH_PATH);
  atomicWriteTextSync(
    join(profileDir, "platform-tool-search-bridge.js"),
    readFileSync(TOOL_SEARCH_BRIDGE_SOURCE, "utf8"),
  );
  // The bridge imports `./tool-discovery.js` (no dsh imports, plain JS) —
  // place it beside the bridge so the relative import resolves.
  atomicWriteTextSync(join(profileDir, "tool-discovery.js"), readFileSync(TOOL_SEARCH_MATCHER_SOURCE, "utf8"));
  const patch = [
    { insert: [{ id: "tool-search-bridge", name: "./platform-tool-search-bridge.js" }] },
  ];
  atomicWriteTextSync(TOOL_SEARCH_PATCH_PATH, yaml.dump(patch));
  console.log(`[dsh-profile] wrote tool-search bridge patch → ${TOOL_SEARCH_PATCH_PATH}`);
  return TOOL_SEARCH_PATCH_PATH;
}

// ── Chart-bind bridge patch (add-chart-data-binding) ────────────────────────
// The read-only `chart_bind` tool (declare the MCP call that fed a chart) rides
// its own overlay, exactly like tool_search: the plugin is copied into the
// profile dir, plus the matcher it reuses for roster suggestions AND the
// deployment's replay allowlist — the child must be able to refuse a
// declaration for a tool this cell may never replay, and the file is the same
// data the server reads. Purely additive: without the overlay the roster is
// unchanged and chat works as before.
const CHART_BIND_PATCH_PATH = join(DSH_HOME, "profiles", PROFILE_NAME, "chart-bind.patch.yml");
const CHART_BIND_BRIDGE_SOURCE = join(
  dirname(fileURLToPath(import.meta.url)),
  "dsh-profile-template",
  "platform-chart-bind-bridge.js",
);
const CHART_ALLOWLIST_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "chart-replay-allowlist.json");

export function writeChartBindPatch() {
  mkdirSync(dirname(CHART_BIND_PATCH_PATH), { recursive: true });
  const profileDir = dirname(CHART_BIND_PATCH_PATH);
  atomicWriteTextSync(
    join(profileDir, "platform-chart-bind-bridge.js"),
    readFileSync(CHART_BIND_BRIDGE_SOURCE, "utf8"),
  );
  // Same matcher module the tool-search bridge uses (idempotent rewrite).
  atomicWriteTextSync(join(profileDir, "tool-discovery.js"), readFileSync(TOOL_SEARCH_MATCHER_SOURCE, "utf8"));
  try {
    atomicWriteTextSync(join(profileDir, "chart-replay-allowlist.json"), readFileSync(CHART_ALLOWLIST_SOURCE, "utf8"));
  } catch (err) {
    // No allowlist file ships → the plugin's own default applies (deny
    // everything but the probed cache-read tool), same as the server's.
    console.warn(`[dsh-profile] no allowlist file to copy (${err.message}); the plugin falls back to its default`);
  }
  const patch = [{ insert: [{ id: "chart-bind-bridge", name: "./platform-chart-bind-bridge.js" }] }];
  atomicWriteTextSync(CHART_BIND_PATCH_PATH, yaml.dump(patch));
  console.log(`[dsh-profile] wrote chart-bind bridge patch → ${CHART_BIND_PATCH_PATH}`);
  return CHART_BIND_PATCH_PATH;
}

// ── User-questions bridge patch (add-user-questions) ────────────────────────
// The ask_user_question tool (standard preset) needs a host-side
// ctx.userQuestions provider — the seam's single slot is empty in the platform
// composition, so every call died NO_PROVIDER. This overlay swaps the server
// row one level further: disables `platform-permission-server` and inserts
// `platform-user-questions-server`, a subclass that registers the provider,
// forwards asks as `userQuestion/ask` notifications (the existing child→host
// lane, never entering the session log) and resolves them through a
// `userQuestions/answer` request (the existing host→child lane). Layer order:
// AFTER permissions.patch.yml — it swaps the row that overlay inserted.
// Unconditional like its predecessors: without it the tool errors at call
// time; with it, surfaces that never answer fall back to the child's
// 15-minute ask window.
const USER_QUESTIONS_PATCH_PATH = join(DSH_HOME, "profiles", PROFILE_NAME, "user-questions.patch.yml");
const USER_QUESTIONS_BRIDGE_SOURCE = join(
  dirname(fileURLToPath(import.meta.url)),
  "dsh-profile-template",
  "platform-user-questions-bridge.js",
);
const USER_QUESTIONS_BRIDGE_FILE = "platform-user-questions-bridge.js";

// Write the user-questions bridge file + user-questions.patch.yml into the
// profile dir. The bridge imports the permission bridge (its subclass parent),
// so that file is (re)written beside it — same idempotent-copy shape the
// tool-search/chart-bind pair uses for tool-discovery.js. Returns the patch
// path for the --patch args.
export function writeUserQuestionsPatch() {
  mkdirSync(dirname(USER_QUESTIONS_PATCH_PATH), { recursive: true });
  const profileDir = dirname(USER_QUESTIONS_PATCH_PATH);
  atomicWriteTextSync(
    join(profileDir, PERMISSION_BRIDGE_FILE),
    readFileSync(PERMISSION_BRIDGE_SOURCE, "utf8"),
  );
  atomicWriteTextSync(
    join(profileDir, USER_QUESTIONS_BRIDGE_FILE),
    readFileSync(USER_QUESTIONS_BRIDGE_SOURCE, "utf8"),
  );
  const patch = [
    { id: "platform-permission-server", disabled: true },
    {
      insert: [{ id: "platform-user-questions-server", name: `./${USER_QUESTIONS_BRIDGE_FILE}` }],
    },
  ];
  atomicWriteTextSync(USER_QUESTIONS_PATCH_PATH, yaml.dump(patch));
  console.log(`[dsh-profile] wrote user-questions bridge patch → ${USER_QUESTIONS_PATCH_PATH}`);
  return USER_QUESTIONS_PATCH_PATH;
}

// ── Notify bridge patch (add-agent-notifications D1/D3) ─────────────────────
// The `bot_notify` tool a deployed child calls rides its own overlay, exactly
// like the chart-bind face: platform-notify-bridge.js (plus the pure
// bot-notify.js module it imports) is copied into the profile dir, and a
// fresh-insert row disables the row it subclasses — a cordis patch cannot
// rewrite an inserted row's plugin name, so the chain always grows by
// disable + insert. Composed into agent-runner children only (compose.js
// calls this writer with the child's PRIVATE home); the platform's own web
// children never see the row.
//
// Swap chain in a runner child: presets.patch.yml inserts `platform-sdk-server`
// (the preset bridge) → notify.patch.yml disables it and inserts
// `platform-notify-server`, a subclass. Layer order matters and is fixed by
// compose.js's patchPaths (notify AFTER presets).
const NOTIFY_BRIDGE_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "dsh-profile-template", "platform-notify-bridge.js");
const NOTIFY_MODULE_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "dsh-profile-template", "bot-notify.js");
const PRESET_BRIDGE_SOURCE_FILE = "platform-preset-bridge.js"; // re-copied: the notify bridge imports it (its subclass parent)
export const NOTIFY_BRIDGE_FILE = "platform-notify-bridge.js";
export const NOTIFY_MODULE_FILE = "bot-notify.js";
export const NOTIFY_PATCH_FILE = "notify.patch.yml";

// Write the notify bridge files + notify.patch.yml into the profile dir.
// `dirs` is the same { dshHome, profileName } target every runner-facing
// writer takes (the platform's no-args form would aim at the deployment
// singleton, where this row must NOT land). Returns the patch path for the
// child's --patch args.
export function writeNotifyPatch({ dirs } = {}) {
  const profileDir = dirname(targetPaths(dirs).presetsPatch);
  mkdirSync(profileDir, { recursive: true });
  // The subclass parent, re-written idempotently (the user-questions overlay's
  // own discipline): the notify bridge's relative import must resolve even if
  // a caller ever writes this overlay ahead of the presets one.
  atomicWriteTextSync(join(profileDir, PRESET_BRIDGE_SOURCE_FILE), readFileSync(BRIDGE_SOURCE, "utf8"));
  atomicWriteTextSync(join(profileDir, NOTIFY_BRIDGE_FILE), readFileSync(NOTIFY_BRIDGE_SOURCE, "utf8"));
  atomicWriteTextSync(join(profileDir, NOTIFY_MODULE_FILE), readFileSync(NOTIFY_MODULE_SOURCE, "utf8"));
  const patchPath = join(profileDir, NOTIFY_PATCH_FILE);
  const patch = [
    { id: "platform-sdk-server", disabled: true },
    { insert: [{ id: "platform-notify-server", name: `./${NOTIFY_BRIDGE_FILE}` }] },
  ];
  atomicWriteTextSync(patchPath, yaml.dump(patch));
  console.log(`[dsh-profile] wrote notify bridge patch → ${patchPath}`);
  return patchPath;
}

// Self-check: load .env, build the section, print it + the model list. No file
// write (read-only) — proves the generator emits valid YAML + the expected ids.
// Usage: node dsh-profile.js
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  // Scoped self-check DB: set BEFORE dotenv and before anything imports
  // db.js, so the pack-scope section below never touches the developer's
  // real database even when .env points DB_PATH at it.
  const selfCheckDb = join(tmpdir(), `dsh-profile-selfcheck-${process.pid}.db`);
  process.env.DB_PATH = selfCheckDb;
  try { (await import("dotenv")).config(); } catch { /* .env optional for the self-check */ }
  const { providers, models } = await buildLlmProfile();
  console.log("--- llm-pi-ai settings section ---");
  console.log(yaml.dump({ "llm-pi-ai": { providers } }));
  console.log(`models: ${models.map((m) => m.id).join(", ") || "(none — no keys configured)"}`);
  if (Object.keys(providers).length === 0) console.log("OK (dormant — graceful-degrade path)");
  else if (models.some((m) => VOLCES_MODELS.some((v) => v.id === m.id))) console.log("OK volces route declared");
  else console.log("FAIL: no volces models despite LLM_API_KEY set");
  // Thinking-level round-trip: an explicit effort lands as provider-level
  // `reasoning`, and a deepseek model declares its selectable levels.
  if (providers.volces) {
    const { providers: p2 } = await buildLlmProfile({ efforts: { volces: "high" } });
    const yamlDoc = yaml.load(yaml.dump({ "llm-pi-ai": { providers: p2 } }))["llm-pi-ai"].providers;
    const ds = yamlDoc.volces.models.find((m) => m.id.startsWith("deepseek-v4"));
    console.assert(yamlDoc.volces.reasoning === "high", "reasoning level did not round-trip");
    console.assert(ds && Object.keys(ds.reasoningEfforts).includes("high"), "deepseek model missing reasoningEfforts");
    console.assert(
      yamlDoc.volces.models.find((m) => m.id.startsWith("glm"))?.reasoningEfforts === false,
      "non-reasoning model should declare false",
    );
    console.log("OK reasoning effort round-trips");
  }
  // MCP patch self-check: write the file and dump it so the entry shape is visible.
  const patchPath = await writeMcpPatch();
  if (patchPath) {
    console.log(`--- mcp patch (${patchPath}) ---`);
    console.log(readFileSync(patchPath, "utf8"));
  }
  // Skills patch self-check (full mode).
  const skillsPatch = await writeSkillsPatch();
  console.log(`--- skills patch (${skillsPatch}) ---`);
  console.log(readFileSync(skillsPatch, "utf8"));
  // Preset roster patch self-check: proves the shipped-root resolution + shows
  // the generated overlay (null = unresolvable, warn-and-skip path).
  const presetsPatch = await writePresetsPatch();
  if (presetsPatch) {
    console.log(`--- presets patch (${presetsPatch}) ---`);
    console.log(readFileSync(presetsPatch, "utf8"));
  } else {
    console.log("presets patch skipped (shipped preset root unresolvable)");
  }
  // Permission bridge patch self-check.
  const permissionsPatch = await writePermissionsPatch();
  console.log(`--- permissions patch (${permissionsPatch}) ---`);
  console.log(readFileSync(permissionsPatch, "utf8"));
  // Tool-search bridge patch self-check.
  const toolSearchPatch = writeToolSearchPatch();
  console.log(`--- tool-search patch (${toolSearchPatch}) ---`);
  console.log(readFileSync(toolSearchPatch, "utf8"));
  // Catalog agent preset self-check: compose one from the shipped `standard`
  // composition and prove the persona swap landed (this is what a vertical-pack
  // chat agent runs on — see writeCatalogAgentPresets).
  const sample = shippedStandardComposition();
  if (sample) {
    const composed = composeAgentPreset(sample, catalogEntryPersona({ id: "pack-demo", name: "合同审查官", description: "法律-合同包对话入口", tags: ["法律", "合同"] }));
    console.assert(composed.includes("合同审查官"), "composed preset lost its persona");
    console.assert(composed.includes("dsh-tool-fs") && composed.includes("dsh-tool-skill"), "composed preset lost tool rows");
    console.assert(composed.includes("!!js process.platform"), "composed preset lost the platform tags");
    console.log("OK catalog agent preset composes (persona swapped, tool rows intact)");
  } else {
    console.log("catalog agent preset skipped (shipped composition unresolvable)");
  }

  // ── Pack agent scope self-check (add-pack-agent-scoping) ──────────────────
  // Seeds a throwaway DB with an installed pack, then covers the three
  // derivation cases (pack preset, shipped preset, uninstalled pack) and
  // inspects both written patch files under each mode. Cleans up after itself
  // (temp DB + materialized pack root) so no self-check state survives.
  {
    const db = await import("./db.js");
    await db.initDb();
    const extensionStore = await import("./extension-store.js");
    const sm = await import("./skill-materialize.js");
    const PACK_ID = "scope-selfcheck-pack";
    const AGENT_ID = "scope-selfcheck-agent";
    const manifest = {
      name: "范围自检包",
      skills: [{ name: "scope-skill", description: "自检技能", content: "# c" }],
      mcpServers: [{ registryName: "scope-ref-server" }],
      agents: [{ id: AGENT_ID, name: "自检官", persona: "你是自检官。" }],
    };
    const seedPack = () =>
      db.upsertInstalledPack({
        packId: PACK_ID, name: manifest.name, version: 1, manifest,
        report: { skills: [], mcpServers: [], agents: [{ id: AGENT_ID, name: "自检官", status: "installed" }] },
      });
    // A non-baseline DB server the focused mode must drop.
    extensionStore.addMcpServer({ name: "scope-extra", config: { command: "node", args: ["-e", "process.exit(0)"] }, enabled: true });
    seedPack();
    sm.writeSkill({ name: "scope-skill", description: "自检技能", content: "# c", originPackId: PACK_ID, enabled: true });
    // deriveScope requires the generated preset to exist (a departed entry's
    // preset is pruned, and its stale selection must self-heal to full) —
    // create the marker dir the way writeCatalogAgentPresets would.
    const presetDir = join(DSH_HOME, ".agent-presets", AGENT_ID);
    mkdirSync(presetDir, { recursive: true });
    writeFileSync(join(presetDir, "agent.cordis.yml"), "- id: persona\n  name: '@deepseek-ai/dsh-persona'\n  config:\n    text: \"self-check\"\n");

    // 1) shipped preset ⇒ full; 2) pack preset ⇒ focused with the pack's set.
    const shippedScope = await deriveScope("standard");
    console.assert(shippedScope.packId === null, "shipped preset must derive full");
    const focusedScope = await deriveScope(AGENT_ID);
    console.assert(focusedScope.packId === PACK_ID, "pack preset must derive focused");
    console.assert(focusedScope.packId && JSON.stringify(focusedScope.mcpKeep) === JSON.stringify(["scope-ref-server"]), "pack MCP refs carry into mcpKeep");
    console.assert(focusedScope.skillsDir === sm.packSkillsRoot(PACK_ID), "pack skills root carries into the scope");
    console.log("OK deriveScope: shipped=full, pack preset=focused");

    // 3) uninstalled pack self-heals to full; re-seed for the patch writers.
    db.deleteInstalledPack(PACK_ID);
    const healedScope = await deriveScope(AGENT_ID);
    console.assert(healedScope.packId === null, "a preset whose pack was uninstalled must derive full");
    console.log("OK deriveScope: uninstalled pack self-heals to full");
    seedPack();

    // MCP patch under both modes (parse the written files back).
    const serverNames = (p) => {
      const doc = yaml.load(readFileSync(p, "utf8"));
      return doc.flatMap((row) => row.insert ?? []).map((e) => e.config.serverName).sort();
    };
    const fullMcp = await writeMcpPatch();
    const fullServers = fullMcp ? serverNames(fullMcp) : [];
    console.assert(fullServers.includes("scope-extra"), "full mode lists the DB server");
    const focusedMcp = await writeMcpPatch({ agentPreset: AGENT_ID });
    const focusedServers = focusedMcp ? serverNames(focusedMcp) : [];
    console.assert(!focusedServers.includes("scope-extra"), "focused mode drops the non-baseline DB server");
    console.assert(!focusedServers.includes("scope-ref-server"), "an uninstalled pack ref intersects to nothing");
    console.log(`OK mcp patch: full=[${fullServers.join(",")}] focused=[${focusedServers.join(",")}]`);

    // Skills patch under both modes: focused = baseline + pack root (no user
    // root); full = user root + every pack root.
    const dirListOf = async (opts) => {
      const p = await writeSkillsPatch(opts);
      return yaml.load(readFileSync(p, "utf8"))[0].config.customSkillDirs.map((d) => resolve(d));
    };
    const focusedDirs = await dirListOf({ agentPreset: AGENT_ID });
    console.assert(!focusedDirs.includes(resolve(sm.MATERIALIZE_DIR)), "focused mode omits the user skills root");
    console.assert(focusedDirs.includes(resolve(sm.packSkillsRoot(PACK_ID))), "focused mode lists the pack root");
    const fullDirs = await dirListOf({});
    console.assert(fullDirs.includes(resolve(sm.MATERIALIZE_DIR)), "full mode lists the user skills root");
    console.assert(fullDirs.includes(resolve(sm.packSkillsRoot(PACK_ID))), "full mode lists the pack root");
    console.log(`OK skills patch: focused roots=${focusedDirs.length} full roots=${fullDirs.length}`);

    // Pack persona carries the focus note; a non-pack persona does not.
    console.assert(catalogEntryPersona({ id: AGENT_ID, name: "自检官", packId: PACK_ID }).includes("聚焦模式"), "pack persona must carry the focus note");
    console.assert(!catalogEntryPersona({ id: AGENT_ID, name: "自检官" }).includes("聚焦模式"), "non-pack persona must not");
    console.log("OK catalog persona focus note");

    // Cleanup: no self-check pack root, preset dir, or DB survives.
    sm.removePackSkills(PACK_ID);
    rmSync(presetDir, { recursive: true, force: true });
    extensionStore.removeMcpServer("scope-extra");
    db.deleteInstalledPack(PACK_ID);
    // Leave the conventional full-mode patches behind.
    await writeMcpPatch();
    await writeSkillsPatch({});
    for (const suffix of ["", "-wal", "-shm"]) {
      try { rmSync(selfCheckDb + suffix, { force: true }); } catch { /* best-effort */ }
    }
  }
}
