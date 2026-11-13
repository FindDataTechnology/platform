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
import { readFileSync, mkdirSync, chmodSync, existsSync, lstatSync, copyFileSync, symlinkSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { atomicWriteTextSync, normalizeBaseUrl } from "./lib/persistence.js";
import { effectiveMcpTools } from "./lib/pack-manifest.js";
import { findRouteExclusivityViolations, throwRouteViolations } from "./lib/llm-route-exclusivity.js";
import { applyRouteExceptions, loadRouteExceptions } from "./lib/route-exceptions.js";
import { effectiveRows, ledgerFromPlan } from "./lib/fleet-plugin-rows.js";
import { platformCredentialKeysIn } from "./lib/platform-credential-keys.js";
import { deriveFullModeToolScope, customPresetToolScope, capByOperatorFace } from "./lib/full-mode-tool-scope.js";
import { OPERATOR_TOOL_FACES } from "./lib/operator-tool-face.js";
import { describeInjectionSurface } from "./lib/injection-surface.js";
import { trimServersToFace, serversFromFace, describeTrim } from "./lib/mcp-post-trim.js";
import { deriveScopedToken, scopeIdForEmail } from "./lib/scoped-relay-token.js";
import { probeHttpServers } from "./mcp-preflight.js";
import { cellMemoryMount, cellMemoryConfig, MEMORY_DISCIPLINE } from "@finddatatechnology/yongyi-client";
import { repoRoot } from "./paths.js";

const DSH_HOME = process.env.DSH_HOME || join(homedir(), ".dsh");
const MCP_CONFIG_PATH = resolve(process.env.MCP_CONFIG_PATH || "mcp.json");

// token.finddatatech.cloud gateway model catalog. 2026-09-30 refresh: every id
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
//
// 与词元能力快照（/v1/ciyuan/capabilities）的关系，2026-11-10 起明确：
//   这张表仍是**生成 dsh profile 的种子目录**（选型/排序/元数据都来自它），
//   快照目前**只**用于模型同步时缩小探测集合（llm-providers.planSyncProbeSet），
//   **不参与**选模与排序。所以它不是「回退锚」，而是当下的主目录；把它降成回退锚
//   需要先改选模路径并拿到「快照 serving 与探测一致率」的数据（charter 3.5a/3.5b）。
//   前提别搞反：若将来改成从快照取目录，务必保留本表作为快照不可用时的回落，
//   否则词元一次滚版就会让模型选择器变空。
const VOLCES_MODELS = [
  { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", contextWindow: 128000, maxTokens: 32768 },
  { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", contextWindow: 128000, maxTokens: 32768 },
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
  // glm-5.3-flash is DEMOTED to the tail (2026-11-09 measurement, 24h): **2 ok / 55 failed
  // (96%)** while deepseek-v4.1-flash ran 147/92 (38%). It used to sit third, i.e. it was the
  // first fallback — and when the deepseek budget ran out (seen at 101% tonight) traffic
  // landed exactly there. Selection bias is real (it is picked in bad moments), but routing
  // to a lane that fails 96% of the time helps nobody; it keeps its seat at the end so an
  // explicit per-post binding still resolves.
  { id: "glm-5.3-flash", name: "GLM 5.3 Flash", contextWindow: 128000, maxTokens: 32768 },
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
      models.push({
        id: m.id,
        name: m.name,
        provider: route,
        ...(levels.length ? { reasoningEfforts: levels } : {}),
        // Context window rides along (chat-usage-display) when the route
        // declares one — the client's context meter divides by it.
        ...(typeof m.contextWindow === "number" ? { contextWindow: m.contextWindow } : {}),
      });
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
  const home = dirs?.dshHome ?? DSH_HOME;
  const profileDir = join(home, "profiles", dirs?.profileName ?? PROFILE_NAME);
  return {
    // 0.2.0 (D7.1): settings live as rows in the profile's OWN patch file —
    // the one dsh-hmr watches, so mid-session writes hot-apply exactly like
    // the retired home-root settings.yaml once did.
    settings: join(profileDir, "cordis.patch.yml"),
    credentials: join(home, ".credentials.yaml"),
    presetsPatch: join(profileDir, "presets.patch.yml"),
    mcpPatch: join(profileDir, "mcp.patch.yml"),
  };
}

// Upsert the llm-pi-ai row in the profile's cordis.patch.yml (0.2.0 D7.1:
// the section-body shape is unchanged, it just rides a patch ROW now). Other
// rows in the patch (the scaffold's inserts) are preserved. Atomic:
// temp+rename; dsh-hmr watches this file, so a mid-session write hot-applies.
// Returns { providers, models } so server.js can source its model selector.
// How many tokens of a single tool result stay INLINE in the context before it
// spills to disk and becomes a reference. Stock dsh: 12500 (~40KB), which on a
// 128K window is a third of the budget for one result. 4000 (~13KB) still holds
// a useful listing or grep hit; anything larger the model can re-read through
// the spill. Invalid or non-positive values fall back to the default, never to 0
// (0 would suppress every result body).
const DSH_MAX_INLINE_TOKENS_DEFAULT = 4000;
export function inlineTokensBudget(env = process.env) {
  const raw = env.DSH_MAX_INLINE_TOKENS;
  if (raw === undefined || raw === null || String(raw).trim() === "") return DSH_MAX_INLINE_TOKENS_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DSH_MAX_INLINE_TOKENS_DEFAULT;
}

// ── Team plugin rows (add-fleet-plugin-declaration 2.1 / 2.2 / D2) ──────────
//
// The patch file has ONE author (this module): the llm route owns two ids, the
// team plugin rows own a ledger-recorded set, and both are written through the
// same read → filter → append → atomic-write path. Two authors editing the same
// YAML would each filter with their own rules and erase the other's rows — that
// accident has happened elsewhere and is not repeated here.
//
// Row shape is a plain loader entry (`{ id, name }`), because that is the only
// shape cordis' patch layer understands; the "who declared this" answer lives
// in the sibling ledger (`fleet-plugins.json`), NOT as an extra key on the row.
// Deviation from design D2's literal `origin:` field, for a concrete reason:
// an unknown key on a loader entry is a load-time risk, while a sidecar cannot
// be mis-parsed by the loader at all.
const FLEET_PLUGINS_LEDGER = "fleet-plugins.json";

function readPatchRows(patchPath) {
  try {
    const loaded = yaml.load(readFileSync(patchPath, "utf8"));
    return Array.isArray(loaded) ? loaded : [];
  } catch (err) {
    if (err?.code !== "ENOENT") console.warn("[dsh-profile] profile patch unreadable:", err.message);
    return [];
  }
}

function readFleetLedger(ledgerPath) {
  try {
    const doc = JSON.parse(readFileSync(ledgerPath, "utf8"));
    return doc && typeof doc === "object" && doc.plugins && typeof doc.plugins === "object" ? doc : null;
  } catch (err) {
    if (err?.code !== "ENOENT") console.warn("[dsh-profile] fleet plugin ledger unreadable:", err.message);
    return null;
  }
}

/** Rows the profile currently composes for teams, with their declaring fleets. */
export function readFleetPluginRows(dirs) {
  const patchPath = targetPaths(dirs).settings;
  const ledgerPath = join(dirname(patchPath), FLEET_PLUGINS_LEDGER);
  const rows = readPatchRows(patchPath).flatMap((entry) =>
    entry && Array.isArray(entry.insert) ? entry.insert : entry && typeof entry === "object" ? [entry] : [],
  );
  return effectiveRows({ patchRows: rows, ledger: readFleetLedger(ledgerPath) });
}

/**
 * Recompute the team plugin rows for this profile (design D3): remove every row
 * the ledger recorded, then insert exactly `rows` and rewrite the ledger.
 * @param {{ dirs?: object, rows?: {id: string, name: string, fleets: string[]}[] }} opts
 */
export function writeFleetPluginRows({ dirs, rows = [] } = {}) {
  const patchPath = targetPaths(dirs).settings;
  const ledgerPath = join(dirname(patchPath), FLEET_PLUGINS_LEDGER);
  const doc = readPatchRows(patchPath);
  const ledger = readFleetLedger(ledgerPath);
  // Managed = previously recorded ∪ about-to-be-written. A first run has no
  // ledger and therefore removes nothing (it never guesses at ownership).
  const managed = new Set([...(ledger ? Object.keys(ledger.plugins ?? {}) : []), ...rows.map((row) => row.id)]);

  const cleaned = [];
  for (const entry of doc) {
    if (!entry || typeof entry !== "object") {
      cleaned.push(entry);
      continue;
    }
    if (Array.isArray(entry.insert)) {
      const kept = entry.insert.filter((row) => !(row && typeof row === "object" && managed.has(row.id)));
      const others = Object.keys(entry).filter((key) => key !== "insert");
      if (kept.length === 0 && others.length === 0) continue; // entry existed only for team rows
      cleaned.push({ ...entry, insert: kept });
      continue;
    }
    if (managed.has(entry.id)) continue; // a bare (override) row we own
    cleaned.push(entry);
  }

  if (rows.length > 0) {
    let insertEntry = cleaned.find((entry) => entry && typeof entry === "object" && Array.isArray(entry.insert));
    if (!insertEntry) {
      insertEntry = { insert: [] };
      cleaned.unshift(insertEntry);
    }
    for (const row of rows) insertEntry.insert.push({ id: row.id, name: row.name });
  }

  // The same gate the model routes pass: a "plugin" that registers a model
  // route is exactly the bypass the supply gates exist to stop.
  const violations = findRouteExclusivityViolations(cleaned);
  if (violations.length > 0) {
    const loaded = loadRouteExceptions();
    const { violations: remaining } = applyRouteExceptions(violations, loaded.exceptions);
    if (remaining.length > 0) throwRouteViolations(remaining);
  }

  mkdirSync(dirname(patchPath), { recursive: true });
  atomicWriteTextSync(patchPath, yaml.dump(cleaned));
  atomicWriteTextSync(ledgerPath, JSON.stringify(ledgerFromPlan({ rows }), null, 2) + "\n");
  return { patchPath, ledgerPath, count: rows.length };
}

export async function writeLlmProfile(opts = {}) {
  const { dirs, ...buildOpts } = opts;
  const patchPath = targetPaths(dirs).settings;
  const { providers, models } = await buildLlmProfile(buildOpts);
  let rows = [];
  try {
    const loaded = yaml.load(readFileSync(patchPath, "utf8"));
    if (Array.isArray(loaded)) rows = loaded;
  } catch (err) {
    // ENOENT is expected on first run; anything else is warned but not fatal.
    if (err.code !== "ENOENT") console.warn("[dsh-profile] profile patch unreadable, recreating llm row:", err.message);
  }
  // Own BOTH rows we compose: the llm route and the inline budget.
  const kept = rows.filter(
    (r) => !(r && typeof r === "object" && !r.insert && (r.id === "llm-pi-ai" || r.id === "spill-policy")),
  );
  kept.push({ id: "llm-pi-ai", name: "@deepseek-ai/dsh-llm-pi-ai", config: { providers } });
  // Inline budget for tool results and other retained output
  // (fix-dsh-inline-budget): dsh ships `spill-policy` with maxInlineTokens 12500
  // (~40KB per result), and the traced rounds showed exactly that — single tool
  // results at 40KB and single assistant messages at 43KB, 79-87% of the bytes
  // in an overflowing round. On a 128K window two of those plus history is most
  // of the budget, which is how a round dies at `context overflow` after ONE
  // compaction. The retained text is not discarded — it spills to disk and the
  // model gets a reference — so a smaller inline budget costs a re-read, not the
  // information. Env-tunable; set 12500 to restore the stock behaviour.
  kept.push({
    id: "spill-policy",
    name: "@deepseek-ai/dsh-spill-policy",
    config: { maxInlineTokens: inlineTokensBudget() },
  });
  // Route exclusivity (harden-plugin-supply-gates D2): the filter above
  // deliberately preserves every row we do not own, so a supplied bundle can
  // contribute a second model route — bypassing 萬星词元 and the metering lane.
  // Assert on the composition, before it reaches disk.
  //
  // Fail closed by default. DSH_ROUTE_EXCLUSIVITY=warn exists for the one
  // observation run the change's task list calls for (prove zero violations on a
  // real deployment before enforcing); it is not a supported long-term mode.
  const violations = findRouteExclusivityViolations(kept);
  if (violations.length > 0) {
    // Operator exceptions (task 4.3): each entry is a decision with an expiry and
    // an approver, matched by bundle package name, so a legitimate deployment is
    // not forced to run with the gate switched off.
    const loaded = loadRouteExceptions();
    for (const problem of loaded.errors) console.warn(`[dsh-profile] exception file: ${problem}`);
    const { violations: remaining, allowed, expired } = applyRouteExceptions(violations, loaded.exceptions);
    for (const { exception, violation } of allowed) {
      console.warn(
        `[dsh-profile] route EXCEPTED '${exception.name}' until ${new Date(exception.expiresAt).toISOString()} (approved by ${exception.approvedBy}): ${violation.reason}`,
      );
    }
    for (const exception of expired) {
      console.warn(`[dsh-profile] EXPIRED route exception for '${exception.name}' — re-review or remove it`);
    }
    if (remaining.length > 0) {
      if (String(process.env.DSH_ROUTE_EXCLUSIVITY ?? "").toLowerCase() === "warn") {
        console.warn(
          `[dsh-profile] route exclusivity WARN (not enforced): ${remaining.map((v) => v.reason).join("; ")}`,
        );
      } else {
        throwRouteViolations(remaining); // throws with code + violations
      }
    }
  }
  atomicWriteTextSync(patchPath, yaml.dump(kept));

  if (Object.keys(providers).length === 0) {
    console.warn("[dsh] no LLM keys configured; chat non-functional (static + REST still served)");
  } else {
    console.log(
      `[dsh-profile] wrote ${Object.keys(providers).join(", ")} route(s), ${models.length} model(s) → ${patchPath}`,
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
// The deployment's 词元 route in llm-providers.json; a bound 词元 account
// overrides this provider's ref per hosted cell (ciyuan-account-lane). The id
// is deployment data — production names it `finddata-token`, local/dev `finddata`
// — so both ride the default list (CIYUAN_PROVIDER_IDS, comma-separated).
const CIYUAN_PROVIDER_IDS = (process.env.CIYUAN_PROVIDER_IDS || "finddata,finddata-token")
  .split(",").map((s) => s.trim()).filter(Boolean);

// The credential-format invariant a file on disk must satisfy: no block
// scalars. See the write site for why (line-oriented readers, the 2026-10-12
// PAT leak). Checked on the RAW text, not the parsed doc — a folded scalar
// parses back to the same value, so only the text can tell us it is unsafe.
const BLOCK_SCALAR_RE = /:\s*[>|][-+]?\s*$/m;

export async function ensureCredentialsStore(opts = {}) {
  const credentialsPath = targetPaths(opts.dirs).credentials;
  let doc;
  let raw;
  try {
    raw = readFileSync(credentialsPath, "utf8");
    const loaded = yaml.load(raw);
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
  // Third layer (ciyuan-account-lane, design D1/D6): in a hosted cell — one
  // identity per store — a bound 词元 account key overrides the deployment seed
  // the loop above just (re)asserted for the 词元 provider ref, so the next LLM
  // request bills the user's own account. No owner (shared single-process
  // store) or no live key (unbound / stale) leaves the seed in place: that is
  // the fallback, not a special case.
  if (opts.cellOwnerEmail) {
    try {
      const [{ envRefForProvider }, ciyuanAccount] = await Promise.all([
        import("./llm-providers.js"),
        import("./ciyuan-account-credentials.js"),
      ]);
      const userKey = ciyuanAccount.liveToken(opts.cellOwnerEmail);
      if (userKey) {
        // The reserved env route (LLM_API_KEY) is where production actually
        // serves models (the volces route over LLM_BASE_URL), so the override
        // must carry it too — the env seed loop above restores it on unbind.
        const refs = ["LLM_API_KEY", ...CIYUAN_PROVIDER_IDS.map((id) => envRefForProvider(id))];
        for (const ref of refs) {
          if (Object.hasOwn(doc.refs, ref) && doc.refs[ref] !== userKey) {
            doc.refs[ref] = userKey;
            changed = true;
          }
        }
      }
    } catch (e) {
      console.warn(`[dsh-profile] ciyuan account override unavailable: ${e?.message || e}`);
    }
  }
  // Always (re)write on first run (file absent) so perms are set; otherwise
  // only write when a ref changed — OR when the file on disk still violates
  // the single-line invariant. The second condition is load-bearing: a folded
  // file was written by an older writer (or edited by hand) and would then
  // never self-heal, because folding is invisible to the "did a ref change"
  // diff — the parsed value is identical. Leaving it folded is the exact
  // state that leaked a PAT into a transcript.
  const absent = !existsSync(credentialsPath);
  const unsafeFormat = typeof raw === "string" && BLOCK_SCALAR_RE.test(raw);
  if (!changed && !absent && !unsafeFormat) return { path: credentialsPath, changed: false };
  // Invariant (credential-file-format): values MUST stay on one line and be
  // quoted. js-yaml folds long values into a `>-` block scalar past lineWidth
  // (default 80), and a folded ref is invisible to line-oriented extraction
  // (`grep`+`sed`) — a skill reading the file that way gets an empty string,
  // which in 2026-10-12 led an agent to print the file and leak the PAT into
  // its transcript. `lineWidth: -1` disables folding (0 does NOT: it means
  // "stay within zero columns"); forceQuotes keeps the value boundary explicit.
  atomicWriteTextSync(credentialsPath, yaml.dump(doc, { lineWidth: -1, forceQuotes: true }));
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
  // Two scrubs, one purpose: the child must not be able to act as the platform.
  //   · CREDENTIAL_REFS — the user provider keys, so dsh-credentials-local's
  //     .credentials.yaml stays the winning layer (design D3);
  //   · platform credential material (supply-gates 3.3) — the platform's own
  //     tokens/URLs. A bundle runs INSIDE this child; leaving these inherited
  //     would hand every supplied bundle the platform's identity, and the build
  //     gate that refuses them in declarations would be decorative.
  const platformKeys = platformCredentialKeysIn(process.env);
  const hasAny = CREDENTIAL_REFS.some((r) => process.env[r]?.trim()) || platformKeys.length > 0;
  if (!hasAny) return null;
  const env = { ...process.env };
  for (const ref of CREDENTIAL_REFS) delete env[ref];
  for (const key of platformKeys) delete env[key];
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

// Whitelisted bundles (add-dsh-plugin-supply) resolve through the profile's own
// module chain like everything else the profile composes. The image layout gets
// that for free (profiles/<name>/node_modules is ONE symlink to the whole
// matrix tree), but the packaged-desktop layout links package-by-package — so
// every bundle the template declares beyond the six shipped names joins the
// pinned link set here, sourced from the runtime tree exactly like the bridge
// packages. Read from the template (never a frozen list): the operator's
// whitelist edit is the template's bundles list itself.
const BUILTIN_PROFILE_BUNDLES = new Set([
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app",
  "@deepseek-ai/dsh-headless",
  "@deepseek-ai/dsh-sdk-app",
  "@deepseek-ai/dsh-sdk-minimal",
  "@deepseek-ai/dsh-acp-app",
]);

function declaredWhitelistBundles() {
  try {
    const manifest = JSON.parse(readFileSync(join(TEMPLATE_DIR, "package.json"), "utf8"));
    const bundles = manifest?.dsh?.profile?.bundles;
    if (!Array.isArray(bundles)) return [];
    return bundles.filter((b) => typeof b === "string" && b !== "" && !BUILTIN_PROFILE_BUNDLES.has(b));
  } catch {
    return [];
  }
}

function pinnedProfilePackages() {
  return [...new Set([...PROFILE_BRIDGE_PACKAGES, ...declaredWhitelistBundles()])];
}
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
    for (const pkg of pinnedProfilePackages()) {
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
  for (const pkg of pinnedProfilePackages()) {
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

// Satellites the per-cell MCP host may serve (share-mcp-satellites-per-cell).
// Membership is NOT a convenience list: a satellite belongs here only if its
// startup env is cell-scoped. Member-scoped servers (library collections,
// websearch user key, fd-memory member token) and the session-scoped `actions`
// (DSH_SESSION_ID) MUST stay per-runtime — pairing them through a shared host
// would show one member's view to another. The unit test in
// scripts/test-mcp-satellite-sharing.mjs asserts this list against the
// satellites' actual env reads, so adding a member-scoped server here fails.
export const SHARED_SATELLITE_SERVERS = Object.freeze([
  "fleet",
  "cron",
  "delegation",
  "bench-proposal",
  "fleet-architect",
  "blueprint-author",
  "pack-author",
  "skill-evolution",
  "persona-evolution",
]);

// Can this satellite be served once per CELL? Only if nothing in its config is
// per-tenant: an explicit credential hook, a credential ref, or any envRef
// (those resolve to a user's token/collection). Kept as one exported predicate
// because two call sites must never disagree — the patch rewrite below and the
// host's spawn list (mcp.shared.json). A disagreement shows up as the host
// spawning a copy that each dsh ALSO spawns, i.e. strictly worse than no
// sharing at all.
export function isShareableSatellite(name, config) {
  if (!SHARED_SATELLITE_SERVERS.includes(name)) return false;
  if (config?.credentialEnv || config?.credentialRef || config?.credential) return false;
  if (Array.isArray(config?.envRefs) && config.envRefs.length) return false;
  return true;
}

// Gray-rollout switch for the shared browser lane (slim-browser-lane-footprint):
// `BROWSER_SHARED_CELLS` is a comma/space list of owner emails, or "*" for all.
// Unset/empty = everyone (the normal steady state after the rollout completes).
export function sharedCellAllowed(ownerEmail, env = process.env) {
  const raw = (env.BROWSER_SHARED_CELLS || "").trim();
  if (!raw) return true;
  const wanted = raw
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (wanted.includes("*")) return true;
  if (!ownerEmail) return false;
  return wanted.includes(String(ownerEmail).trim().toLowerCase());
}

// Map one host MCP config ({command,args,env,cwd} stdio | {url,headers} http) to
// a dsh-mcp-client cordis loader entry. Unknown shape → null (skipped, warned).
// `scopedEnv` (optional name→value map) overrides process.env for envRefs
// resolution — the per-cell scoped-credential injection point (below).
async function toMcpClientEntry(name, config, scopedEnv = null, ownerEmail = null) {
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
    // `scopedEnv` wins per NAME (add-mcp-credential-hygiene D3): a platform-
    // wide secret is substituted with the per-cell derived value so a patch
    // never carries the shared one while scoped derivation is configured.
    // `envRefsOptional` names are resolved the same way but stay SILENT when
    // unset — the user's own search key (add-search-byok) is absent for most
    // users by design, and a warning would be noise, not a degradation. The
    // resolution set is the UNION: an optional name must still be forwarded
    // when present, so it cannot live outside the loop.
    if (Array.isArray(config.envRefs) || Array.isArray(config.envRefsOptional)) {
      const optional = new Set(Array.isArray(config.envRefsOptional) ? config.envRefsOptional : []);
      const refs = [...new Set([...(config.envRefs ?? []), ...optional])];
      const resolved = {};
      for (const ref of refs) {
        const v = scopedEnv?.[ref] ?? process.env[ref];
        if (v == null || v === "") {
          if (!optional.has(ref)) {
            console.warn(`[dsh-profile] MCP "${name}" envRef ${ref} is not set; the server may run degraded`);
          }
          continue;
        }
        resolved[ref] = v;
      }
      if (Object.keys(resolved).length) entry.config.env = { ...(config.env || {}), ...resolved };
    } else if (config.env) {
      entry.config.env = config.env;
    }
    // credentialEnv override (add-crm-desk-pack-embed D2): names mapped to a
    // credential ref take the OWNER's live token for that ref — the BYOK value
    // rides the patch for this user's cell only. The omission rule upstream in
    // writeMcpPatch guarantees live credentials here for authenticated users;
    // a machine owner (null ownerEmail) never enters this branch.
    if (config.credentialEnv && typeof config.credentialEnv === "object" && ownerEmail) {
      try {
        const refs = await import("./credential-refs.js");
        for (const [envName, ref] of Object.entries(config.credentialEnv)) {
          if (typeof ref !== "string" || !ref) continue;
          const token = refs.liveTokenForRef(ref, ownerEmail, config);
          if (token) entry.config.env = { ...(entry.config.env || {}), [envName]: token };
        }
      } catch (e) {
        console.warn(`[dsh-profile] credentialEnv resolution failed for "${name}": ${e?.message || e}`);
      }
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

// Per-cell scoped-credential overrides for envRefs resolution
// (add-mcp-credential-hygiene D3). While SEARCH_RELAY_SCOPED_MASTER is set,
// the SEARCH_RELAY_TOKEN injected into a cell's patch is derived for THAT
// cell (scope = SEARCH_RELAY_SCOPE_ID, else the owner email's stable cell
// id) instead of the platform-wide shared value — a leaked patch value is
// attributable and revocable for one cell alone. Returns null (shared-value
// fallback, today's behavior) when derivation isn't configured or can't
// resolve a scope; each miss warns ONCE per process to keep logs sane.
//
// add-websearch-settings: the non-derived fallback now also consults the
// stored layer (Settings → Network search, deployment_config) BEFORE process
// env — the settings surface is the user-facing override; env stays the
// deployment fallback. The scoped derivation above still wins over both.
let scopedEnvWarned = false;
async function relayEnvOverrides(ownerEmail) {
  // Stored layer first (Settings → Network search), independent of the scoped
  // decision — a stored URL must survive even while the TOKEN is derived.
  const out = {};
  try {
    const db = await import("./db.js");
    const { resolveWebsearchRelay, getUserKey } = await import("./lib/websearch-relay.js");
    const { url, token, source } = await resolveWebsearchRelay(db);
    if (source.url === "stored" && url) out.SEARCH_RELAY_URL = url;
    if (source.token === "stored" && token) out.SEARCH_RELAY_TOKEN = token;
    // The user's OWN search key (add-search-byok): rides the patch for THIS
    // user's cell only. Not scoped-derived — derivation protects platform-
    // shared secrets; this is the user's own credential, same exposure class
    // as their registry/connector key.
    const userKey = getUserKey(db, ownerEmail);
    if (userKey) out.SEARCH_USER_KEY = userKey;
  } catch { /* stored layer unavailable — env fallback stands */ }
  // Scoped derivation overrides the TOKEN only (per-cell value); the URL
  // override above is orthogonal and must not be clobbered by the early
  // return this function used to have.
  const scoped = scopedRelayEnvOverrides(ownerEmail);
  if (scoped) Object.assign(out, scoped);
  return Object.keys(out).length ? out : null;
}
function scopedRelayEnvOverrides(ownerEmail) {
  const master = process.env.SEARCH_RELAY_SCOPED_MASTER;
  if (!master) return null;
  const scope = process.env.SEARCH_RELAY_SCOPE_ID || (ownerEmail ? scopeIdForEmail(ownerEmail) : "");
  if (!scope) {
    if (!scopedEnvWarned) {
      scopedEnvWarned = true;
      console.warn("[dsh-profile] SEARCH_RELAY_SCOPED_MASTER set but no scope (no ownerEmail / SEARCH_RELAY_SCOPE_ID); falling back to the shared token");
    }
    return null;
  }
  try {
    const token = deriveScopedToken(master, scope);
    console.log(`[dsh-profile] SEARCH_RELAY_TOKEN derived per cell (scope=${scope})`);
    return { SEARCH_RELAY_TOKEN: token };
  } catch (e) {
    if (!scopedEnvWarned) {
      scopedEnvWarned = true;
      console.warn(`[dsh-profile] scoped token derivation failed (${e?.message || e}); falling back to the shared token`);
    }
    return null;
  }
}

// Authorization-header snapshot of a written MCP patch
// (add-line-credential-renewal D5): dshUpdateMcp diffs the snapshot before and
// after a rewrite to decide restart-vs-HMR. A header-VALUE change (a renewed
// line credential) is NOT trusted to cordis HMR — production 2026-10-24: the
// patch was rewritten with a fresh token, the child kept the old one for three
// rounds, and only a platform restart (re-spawn re-reads the file) fixed it.
// Server add/remove changes keep riding HMR. Returns null when the patch is
// absent/unreadable (first write — nothing to diff, the child carries no
// patch either).
export function readPatchAuthorizations(patchPath) {
  try {
    const loaded = yaml.load(readFileSync(patchPath, "utf8"));
    const rows = Array.isArray(loaded) ? loaded : [];
    const out = {};
    for (const row of rows) {
      for (const entry of row?.insert ?? []) {
        const cfg = entry?.config;
        if (!cfg?.serverName) continue;
        const auth = cfg?.headers?.Authorization;
        if (typeof auth === "string" && auth) out[cfg.serverName] = auth;
      }
    }
    return out;
  } catch {
    return null;
  }
}

// True when any existing server's Authorization value changed or a
// ref-carrying server appeared/disappeared between two snapshots — i.e. the
// running child's baked credentials no longer match the patch. Pure.
export function authorizationHeadersChanged(prev, next) {
  if (!prev || !next) return false;
  const names = new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const name of names) {
    if (prev[name] !== next[name]) return true;
  }
  return false;
}

export async function writeMcpPatch({ mcpOverlay, userGroups = null, ownerEmail = null, agentPreset = null, noOverlay = false, workspace = null, enrichmentEnabled = true, dirs = null } = {}) {
  // `dirs` re-aims this writer at a private home — the same contract every
  // other writer here honors through targetPaths (settings/credentials/
  // presets/tool-filter/overlay). It is not cosmetic: without it the path
  // constants are frozen at import time, so a caller that sets DSH_HOME after
  // an unrelated import chain has already loaded this module writes the
  // developer's REAL ~/.dsh profile instead of its own temp one (that is
  // exactly how the unit lane overwrote a live profile). mcp.json is read from
  // the same private home unless the caller names the file outright.
  const mcpJsonPath = dirs ? (dirs.mcpConfig ?? join(dirs.dshHome, "mcp.json")) : MCP_CONFIG_PATH;
  const patchPath = dirs
    ? join(dirs.dshHome, "profiles", dirs.profileName ?? PROFILE_NAME, "mcp.patch.yml")
    : MCP_PATCH_PATH;
  // 1. mcp.json (operator config, base layer).
  let mcpJsonServers = {};
  try {
    mcpJsonServers = JSON.parse(readFileSync(mcpJsonPath, "utf8")).mcpServers || {};
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

  // ── Connector injection: one row per binding (add-connector-bindings D4) ──
  // The baseline `connector` row stops being a server and becomes a TEMPLATE:
  // it supplies the transport (url) and nothing else, and the global row is
  // deleted. Every connector row a session gets is a BINDING —
  // `connector:<slot>` — carrying that binding's own scoped token, so one
  // revoked binding cannot take the others' capability with it and no row ever
  // rides a full-authority token that the user did not grant for it.
  //
  // Carve-out: with no owning identity (auth off / machine owner) there is no
  // one to resolve bindings for, so the template row stays exactly as it was —
  // deleting it would remove the connector capability from auth-off installs.
  const connectorTemplate = servers.connector;
  if (connectorTemplate && ownerEmail) {
    delete servers.connector;
    try {
      const bindings = await import("./connector-bindings.js");
      const dbModule = await import("./db.js");
      const installedPacks = dbModule.isDbReady() ? dbModule.listInstalledPacks().map((pack) => pack.packId) : [];
      const rows = bindings.injectionRows(ownerEmail, { installedPacks });
      for (const row of rows) {
        servers[row.name] = {
          ...connectorTemplate,
          // The template's own credentialRef is the retired single-token ref;
          // the binding row carries its slot instead and resolves through the
          // `connector-binding` ref.
          credentialRef: bindings.CONNECTOR_BINDING_CREDENTIAL_REF,
          slot: row.slot,
        };
      }
      if (rows.length === 0) {
        console.log(`[dsh-profile] connector: no authorized binding for ${ownerEmail} — no connector row injected`);
      }
    } catch (e) {
      // Fail closed: the retired global row must not come back as a fallback.
      console.warn(`[dsh-profile] connector binding injection failed for ${ownerEmail}: ${e?.message || e}`);
    }
  }

  // requiresEnv omission (add-crm-desk-bridge D4): an entry whose declared env
  // names are ALL absent from the deployment env is omitted entirely — a
  // server that cannot start (its child exits on missing env) must not ride
  // every patch of every user as a dead entry on deployments that never
  // configured it. Partial presence keeps the entry and falls through to the
  // envRefs warn+degrade semantics in toMcpClientEntry. Applies to the MERGED
  // map, so a bundled/DB row carrying the declaration is honored wherever it
  // landed; a user/admin DB edit without the key is a deliberate override and
  // omits nothing. Info-level by design (spec: omission is a silent normal
  // state, not a warn-grade degradation).
  let userEnvRefs = null;
  if (ownerEmail) {
    try {
      userEnvRefs = await import("./credential-refs.js");
    } catch { userEnvRefs = null; }
  }
  const userHasRef = (ref, config = null) => Boolean(ownerEmail && userEnvRefs?.liveTokenForRef(ref, ownerEmail, config));
  for (const [name, config] of Object.entries(servers)) {
    const required = Array.isArray(config?.requiresEnv) ? config.requiresEnv.filter((v) => typeof v === "string" && v) : [];
    if (!required.length) continue;
    const credentialEnv = config?.credentialEnv && typeof config.credentialEnv === "object" ? config.credentialEnv : {};
    const present = required.filter(
      (v) =>
        (process.env[v] != null && process.env[v] !== "") ||
        (credentialEnv[v] && userHasRef(credentialEnv[v], config)),
    );
    if (present.length === 0) {
      delete servers[name];
      console.log(`[dsh-profile] omitting MCP server "${name}": requiresEnv [${required.join(", ")}] all unset in this deployment`);
    }
  }

  // Browser lane supply gate (add-browser-use-lane, design D2): the lane is
  // composed only where the deployment actually supplies a browser runtime
  // (BROWSER_RUNTIME_PATH exists) or a remote endpoint (BROWSER_CDP_ENDPOINT);
  // BROWSER_LANE=off vetoes both. Otherwise the entry is omitted entirely —
  // the tools simply do not appear in the roster ("模型看不到不存在的腿"),
  // same silent-normal omission family as requiresEnv above. A hand-added
  // DB/mcp.json row without the marker is a deliberate override and skips
  // this gate.
  //
  // Shared shape (slim-browser-lane-footprint, design D5): when the pod sets
  // BROWSER_SHARED_MCP_URL, the lane is a POD-LEVEL service and this cell owns
  // no browser process at all. The entry becomes the streamable-http form
  // ({url}) and drops every stdio field plus the per-cell BROWSER_OUTPUT_DIR
  // injection — the service routes artifacts into the owning cell's workspace
  // instead (task 1.5). No local runtime is required in that shape, and an
  // UNREACHABLE endpoint is NOT a reason to fall back: the entry stays as a url
  // and dsh's ordinary MCP failure path greys the tools out (D6 — falling back
  // would silently recreate the per-cell processes this change removes).
  // BROWSER_LANE=off still wins over a shared endpoint: the operator's kill
  // switch must never leave a lane entry behind.
  for (const [name, config] of Object.entries(servers)) {
    if (config?.laneGate !== "browser") continue;
    const off = (process.env.BROWSER_LANE || "").trim().toLowerCase() === "off";
    if (off) {
      delete servers[name];
      console.log(`[dsh-profile] omitting MCP server "${name}": browser lane disabled by BROWSER_LANE=off`);
      continue;
    }
    const sharedUrl = (process.env.BROWSER_SHARED_MCP_URL || "").trim();
    // Gray switch: BROWSER_SHARED_CELLS narrows the shared shape to a list of
    // owner emails ("*" = everyone). The env is deployment-wide but a rollout
    // must be able to start with ONE test cell — unlisted cells fall through to
    // the per-cell shape below rather than losing the lane entirely. Values are
    // author emails (what an operator actually knows), never cell ids.
    if (sharedUrl && sharedCellAllowed(ownerEmail)) {
      servers[name] = {
        url: sharedUrl,
        ...(config.headers && typeof config.headers === "object" ? { headers: config.headers } : {}),
      };
      console.log(
        `[dsh-profile] browser lane "${name}": shared endpoint ${sharedUrl} — ` +
          "no per-cell browser process, no BROWSER_OUTPUT_DIR (artifacts follow the cell at the service)",
      );
      continue;
    }
    if (sharedUrl) {
      console.log(
        `[dsh-profile] browser lane "${name}": shared endpoint configured but cell "${ownerEmail ?? "(machine)"}" ` +
          "is not in BROWSER_SHARED_CELLS — keeping the per-cell shape for this cell",
      );
    }
    const runtimePath = (process.env.BROWSER_RUNTIME_PATH || "").trim();
    const chromiumPath = (process.env.BROWSER_CHROMIUM_PATH || "").trim();
    const cliPath = (process.env.BROWSER_MCP_CLI || "").trim();
    const endpoint = (process.env.BROWSER_CDP_ENDPOINT || "").trim();
    // Local supply evidence — any of: the browsers dir, the chromium binary, or
    // the MCP CLI file the operator installed. The CLI counts because the
    // desktop opt-in has no image prefix to point at (2026-10-28 verification:
    // docs told desktop users to set BROWSER_MCP_CLI and the gate then omitted
    // the lane, so following the docs produced no lane at all).
    const hasRuntime =
      (runtimePath !== "" && existsSync(runtimePath)) ||
      (chromiumPath !== "" && existsSync(chromiumPath)) ||
      (cliPath !== "" && existsSync(cliPath));
    if (!hasRuntime && !endpoint) {
      delete servers[name];
      console.log(
        `[dsh-profile] omitting MCP server "${name}": browser lane unsupplied (no BROWSER_RUNTIME_PATH, no BROWSER_CDP_ENDPOINT, no BROWSER_SHARED_MCP_URL)`,
      );
      continue;
    }
    // Route the lane's artifacts (page snapshots, screenshots, downloads) into
    // the SESSION's workspace so /api/files can serve them and the resource
    // capture hook accepts them. The MCP sidecar's cwd is not trustworthy for
    // this (it can be a read-only /app), and a per-user cell workspace varies —
    // so the path is injected here, at patch-write time, from the resolved
    // session workspace (add-browser-use-lane; walkthrough 2026-10-28).
    const outputDir =
      (process.env.BROWSER_OUTPUT_DIR || "").trim() ||
      (process.env.AGENT_WORKSPACE || "").trim() ||
      (typeof workspace === "string" ? workspace.trim() : "");
    if (outputDir) {
      servers[name] = { ...config, env: { ...(config.env ?? {}), BROWSER_OUTPUT_DIR: outputDir } };
    } else {
      console.log(`[dsh-profile] browser lane "${name}": no session workspace resolved — outputs fall back to the MCP default dir`);
    }
  }

  // Shared MCP satellites (share-mcp-satellites-per-cell): when this cell runs a
  // satellite host (TASK_WORKER_MAX>0), the shareable servers are served ONCE
  // per cell and every dsh generation attaches by url instead of spawning its
  // own copy. Same shape as the shared browser lane — url entry, no command.
  // Safety: anything carrying credentials or envRefs is skipped even if it were
  // mis-listed above, because those are per-tenant by definition.
  // One predicate, TWO consumers: this rewrite, and the host's spec list
  // (server/mcp-satellite-wiring.js reads the authoritative set from
  // mcp.shared.json next to the patch). They drifted once and the 2026-11-09
  // live A/B caught it: the host was handed every shareable name the patch
  // still had a command for, so an envRefs-bearing satellite (bench-proposal in
  // the real fleet) would be spawned by the host AND by every dsh — exactly the
  // duplicate this change exists to remove.
  const sharedSatelliteNames = Object.entries(servers)
    .filter(([name, config]) => isShareableSatellite(name, config))
    .map(([name]) => name);
  const satelliteHostUrl = (process.env.MCP_SATELLITE_HOST_URL || "").trim().replace(/\/+$/, "");
  if (satelliteHostUrl) {
    for (const name of sharedSatelliteNames) {
      servers[name] = { url: `${satelliteHostUrl}/${name}/mcp` };
      console.log(`[dsh-profile] MCP "${name}": shared per-cell satellite host (${satelliteHostUrl}/${name}/mcp)`);
    }
  }

  // Per-user credential source (add-crm-desk-pack-embed D2): an entry whose
  // env resolves through credentialEnv refs is OMITTED for an authenticated
  // user with no live credential — never falls back to the deployment pair
  // (tenant isolation: a cleared merchant connection must not surface the
  // shared A-tenant inbox). Machine owner (null ownerEmail) keeps the
  // deployment path untouched, byte-identical to the pre-change composition.
  // Dispatch-table failure fails closed (those entries omitted) like the
  // credentialRef resolution below.
  if (ownerEmail) {
    const credentialServers = Object.entries(servers).filter(
      ([, config]) => config?.credentialEnv && typeof config.credentialEnv === "object",
    );
    if (credentialServers.length) {
      if (!userEnvRefs) {
        for (const [name] of credentialServers) delete servers[name];
        console.warn(`[dsh-profile] credential-ref table unavailable; omitting ${credentialServers.length} credentialEnv server(s)`);
      } else {
        for (const [name, config] of credentialServers) {
          const refsNeeded = [...new Set(Object.values(config.credentialEnv).filter((v) => typeof v === "string" && v))];
          if (!refsNeeded.length) continue;
          if (!refsNeeded.every((ref) => userEnvRefs.liveTokenForRef(ref, ownerEmail, config))) {
            delete servers[name];
            console.log(`[dsh-profile] omitting MCP server "${name}": owner has no live credential for [${refsNeeded.join(", ")}]`);
          }
        }
      }
    }
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

  // Proposer identity for the actions bridge (add-wire-line-board D4): the
  // stdio `actions` child has no session of its own, so the per-user profile
  // names the user in its env and the loopback propose route records that as
  // the proposer. Email is not credential-shaped, so dsh's env scrub lets it
  // through; a machine-owner profile (no email) simply carries nothing.
  if (servers.actions?.command && ownerEmail) {
    servers.actions = {
      ...servers.actions,
      env: { ...(servers.actions.env || {}), ACTIONS_MCP_PROPOSER_EMAIL: String(ownerEmail).trim().toLowerCase() },
    };
  }

  // Owner identity for the input-request bridge (add-input-request-cards): 同一
  // 条纪律——子进程没有会话，owner 由 per-user profile 注入。没有 owner 的
  // 输入请求永远没人能答（owner-only），所以机器 owner 的 profile 宁可让工具
  // 报「未配置」，也不落一行死记录。会话 id 由 dsh 自己的 DSH_SESSION_ID 兜底。
  if (servers["input-request"]?.command && ownerEmail) {
    servers["input-request"] = {
      ...servers["input-request"],
      env: {
        ...(servers["input-request"].env || {}),
        INPUT_REQUEST_OWNER_EMAIL: String(ownerEmail).trim().toLowerCase(),
      },
    };
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
    // External-team narrowing (fix-external-team-chat-lane B3): a pack that
    // declares publicFacing faces VISITORS. Its personas keep only the
    // public surfaces (the fleet bridge + the market/directory faces) — the
    // internal business faces (data/legal/trading desks) are dropped, because
    // their tool names and descriptions leak internal vocabulary into the
    // answer (the walkthrough caught "wire-ops" and the 柏讯 demand-desk
    // surface that way). Undeclared packs keep their current face exactly.
    if (scope.publicFacing) {
      for (const name of [...keep]) {
        if (!isPublicFace(name)) keep.delete(name);
      }
    }
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

  const scopedEnv = await relayEnvOverrides(ownerEmail);
  const entries = [];
  for (const [name, config] of Object.entries(servers)) {
    const e = await toMcpClientEntry(name, config, scopedEnv, ownerEmail);
    if (e) entries.push(e);
    else console.warn(`[dsh-profile] skipping MCP server "${name}": unknown config shape`);
  }

  // Per-preset tool faces (fix-parked-preset-attribution D2): the filter doc
  // gains a `byPreset` section for every installed pack persona, so a session
  // created with THAT preset resolves its own allowlist instead of the
  // deployment default's. This is what makes a PARKED round hold its own tool
  // face: the cell writes one MCP patch per boot for the deployment default
  // (parking deliberately does not move it), and without per-preset sections
  // `applyMcpToolRestrict(agentCtx, presetId)` falls back to the whole-home
  // map — i.e. the default persona's face. Same shape the pod adapter already
  // writes (agent-runner/compose.js), so the reader is unchanged.
  async function packPersonaToolFaces() {
    let faces = null;
    try {
      const db = await import("./db.js");
      if (!db.isDbReady()) return null;
      const byPreset = {};
      for (const installed of db.listInstalledPacks()) {
        for (const agent of installed.manifest?.agents ?? []) {
          if (!agent?.id) continue;
          const tools = effectiveMcpTools(installed.manifest, agent);
          if (!Object.keys(tools).length) continue;
          const presetId = rosterPresetId(agent.id);
          byPreset[presetId] = { mcpTools: { ...(byPreset[presetId]?.mcpTools ?? {}), ...tools } };
        }
      }
      if (Object.keys(byPreset).length) faces = { byPreset };
    } catch (e) {
      // Degrade open: an unreadable installed-pack set leaves the doc as it was
      // (no per-preset sections ⇒ every preset reads the whole-home map).
      console.warn(`[dsh-profile] per-preset tool faces unavailable: ${e?.message || e}`);
    }
    return faces;
  }


  // Cell memory mount (add-memory-federation-v1): appended after the user's
  // own servers; fail-open — any failure leaves the patch without the row.
  const memoryMount = await cellMemoryMount(process.env, ownerEmail);
  if (memoryMount) entries.push(memoryMount.mcpEntry);

  // The filter config refreshes at the same composition moments as the MCP
  // patch (server cells, desktop, and the runner all converge here or on the
  // parameterized writer below) — a stale filter cannot outlive its patch.
  // full-mode-tool-scope: the derived map is the whole input now — focused
  // packs, custom presets and full mode's union all arrive in mcpTools; null
  // keeps the pre-change "no filter" composition byte-for-byte.
  // Operator ceiling (add-crm-desk-bridge D5): applied LAST, over the final
  // composition set, so the operator-declared per-server faces cap every mode
  // from above — pack unions, role narrowing and the user's full-surface
  // override all restore/declare UP TO the face, never past it.
  // Public-facing personas (fix-external-team-chat-lane B3): the workspace
  // file tools and the roster-discovery tools are denied — the first group
  // reads the deployment's own project files, the second ENUMERATES the
  // internal tool names (the walkthrough caught "wire-ops" that way). Absent
  // declaration ⇒ nothing denied (byte-for-byte pre-change composition).
  const personaFaces = await packPersonaToolFaces();
  // Shape discipline: the pod-style { mcpTools, byPreset } doc ONLY when
  // per-preset sections exist; otherwise the legacy bare map byte-for-byte —
  // the reader tells them apart by the own `byPreset` key, so a bare map must
  // never accidentally gain that key (a wrapper object around an empty section
  // set would be read as `mcpTools: { mcpTools: … }`).
  const cappedTools = capByOperatorFace(scope.mcpTools, Object.keys(servers));
  writeToolFilterPatch(
    personaFaces?.byPreset ? { mcpTools: cappedTools, byPreset: personaFaces.byPreset } : cappedTools,
    { denyTools: scope.publicFacing ? PUBLIC_FACING_DENIED_TOOLS : null },
  );

  // Tool description overlay (add-tool-description-enrichment D1): curated
  // canonical briefs from the annotation layer. Owner switch off or a
  // public-facing face writes nothing (D3: the internal-vocabulary defense
  // stays — enrichment must not carry internal wording to the model face).
  // The briefs accessor lazy-imports the extension store (same posture as the
  // DB read above); any failure degrades to no overlay, never a broken patch.
  if (enrichmentEnabled && !scope.publicFacing) {
    try {
      const { getCanonicalBriefs } = await import("./extension-store.js");
      writeToolDescriptionOverlay(await getCanonicalBriefs(), { dirs });
    } catch (e) {
      writeToolDescriptionOverlay(null, { dirs });
      console.warn(`[dsh-profile] tool-description overlay unavailable: ${e?.message || e}`);
    }
  } else {
    writeToolDescriptionOverlay(null, { dirs });
  }

  // Preflight health signal (add-mcp-credential-hygiene D5): fire-and-forget
  // probe of every http entry with the exact URL+headers the patch carries —
  // a 401'd server must be VISIBLE instead of silently tool-less. Async on
  // purpose: observation never becomes a new failure mode for the write.
  if (entries.length > 0) {
    void probeHttpServers(entries).catch((e) => {
      console.warn(`[dsh-profile] MCP preflight failed wholesale: ${e?.message || e}`);
    });
  }

  if (entries.length === 0) {
    console.log("[dsh-profile] no MCP servers configured; skipping --patch");
    return null;
  }
  mkdirSync(dirname(patchPath), { recursive: true });
  // Wrap entries in an `insert` list — a bare `{id, config}` is treated by
  // cordis-plugin-include as an override-by-id on an EXISTING entry, and since
  // these mcp-client entries don't exist in the base bundle they'd be warned +
  // skipped ("patch: entry "mcp-x" not found"). `insert` tells cordis to add
  // them as new loader entries. (The skills patch differs: skill-filesystem
  // DOES exist in the base bundle, so its override-by-id shape is correct.)
  // Mode 0600 is the atomic-write default now — the patch carries resolved
  // credential values (Authorization headers, per-cell env) and is readable
  // by the cell owner alone (add-mcp-credential-hygiene D4).
  atomicWriteTextSync(patchPath, yaml.dump([{ insert: entries }]));
  // The host's spawn list, written next to the patch (share-mcp-satellites
  // 2.4 / the 2026-11-09 A/B defect): this file — not a re-derivation from the
  // patch — is what the satellite host obeys. It is emitted on EVERY write,
  // including the boot write that happens before MCP_SATELLITE_HOST_URL is set,
  // because "who is shareable" does not depend on whether a host exists yet.
  try {
    atomicWriteTextSync(
      join(dirname(patchPath), "mcp.shared.json"),
      JSON.stringify({ sharedSatelliteNames }, null, 2),
    );
  } catch (err) {
    console.warn(`[dsh-profile] could not write mcp.shared.json: ${err?.message || err}`);
  }
  console.log(
    `[dsh-profile] wrote ${entries.length} MCP server(s): ${entries.map((e) => e.config.serverName).join(", ")} → ${patchPath}`,
  );
  // Injection-surface accounting (trim-mcp-injection-per-post 1.1): the server
  // count above IS every turn's schema bill, because one patch serves all
  // personas. Log the two comparable facts so growth is visible before it
  // costs a diagnosis — and read the skill roots from the patch actually on
  // disk (never a re-derivation) so the number matches what dsh will load.
  try {
    let skillRoots = 0;
    const skillsPatchPath = join(dirname(patchPath), "skills.patch.yml");
    if (existsSync(skillsPatchPath)) {
      const doc = yaml.load(readFileSync(skillsPatchPath, "utf8"));
      const dirs = doc?.[0]?.config?.customSkillDirs;
      skillRoots = Array.isArray(dirs) ? dirs.length : 0;
    }
    console.log(
      `[dsh-profile] injection surface: ${describeInjectionSurface({
        serverNames: entries.map((e) => e.config.serverName),
        skillRoots,
      })}`,
    );
  } catch {
    // Observation only — a missing/garbled skills patch must never fail the
    // MCP patch write it was measuring. (Optional catch binding: the error is
    // deliberately not inspected, and naming it made lint read it as an unused
    // variable — the intent was always an empty catch, not a swallowed one.)
  }
  return patchPath;
}

// Per-member MCP patch (add-member-knowledge-profile): the fleet member's
// private composition for a WORKER SLOT (each worker is pinned to one persona
// for its life, so the member identity is baked, never raced). Composed by the
// SAME writer into a per-member profile dir (the shared patch keeps serving
// the chat lane byte-identically), then two surgical overrides on the entries:
//   1. fd-memory row → the member's deployment token in the Authorization
//      header (memoryToken null = the row is DROPPED — profile memory off is
//      "the tools do not appear", never a dead entry);
//   2. library row (stdio) → env.LIBRARY_COLLECTIONS stamped with the member's
//      bound collections (the boundary the tool server enforces; empty = the
//      pre-change whole-account view, byte-for-byte).
// Dirs reuse targetPaths' { dshHome, profileName } contract (the same
// parameterization writeToolFilterPatch takes).
export async function writeMemberMcpPatch({ personaPreset, memoryToken = null, libraryCollections = [], faceForPreset = null, ...writeOpts } = {}) {
  // `faceForPreset` is this function's own input, never the base writer's —
  // destructured out above so it cannot leak into writeMcpPatch's options.
  const patchPath = await writeMcpPatch({ ...writeOpts });
  if (!patchPath) return null;
  // Per-post trimming (trim-mcp-injection-per-post 2.1): a worker slot is
  // pinned to ONE persona for its life, so its patch only needs the servers
  // that persona's tool face references. The shared patch keeps serving the
  // chat lane unchanged; this narrows the member's private composition.
  // `faceForPreset` arrives as this function's own parameter (destructured
  // above), so this module keeps no catalog knowledge of its own.
  const memberDir = join(dirname(MCP_PATCH_PATH), `member-${safeProfileSegment(personaPreset)}`);
  mkdirSync(memberDir, { recursive: true });
  let rows;
  try {
    rows = yaml.load(readFileSync(patchPath, "utf8"));
  } catch (e) {
    console.warn(`[dsh-profile] member patch read failed (fail-open to shared): ${e?.message || e}`);
    return null;
  }
  const insert = Array.isArray(rows?.[0]?.insert) ? rows[0].insert : null;
  if (!insert) return null;
  // Trim to the persona's declared face BEFORE the member overrides run, so a
  // post that never uses a server does not pay for its schema (and so the
  // fd-memory append below still works on the trimmed list). `null` face
  // (no declaration) means "no narrowing" — the safety valve.
  let trimmed = insert;
  try {
    const face = faceForPreset ? faceForPreset(personaPreset) : null;
    const allowed = serversFromFace(face);
    if (allowed.size > 0) {
      trimmed = trimServersToFace(insert, { allowed, keepMemory: true });
      console.log(`[dsh-profile] member ${personaPreset}: ${describeTrim(insert, trimmed)}`);
    }
  } catch (e) {
    // Fail-open: a broken face must never ship an empty patch (that would
    // silently remove every tool from a working post).
    console.warn(`[dsh-profile] member trim skipped (${e?.message || e}); keeping the full composition`);
    trimmed = insert;
  }
  const out = applyMemberOverrides(trimmed, { memoryToken, libraryCollections, memoryUrl: writeOpts.mcpOverlay?.fd_memory_url ?? null });
  const memberPatch = join(memberDir, "mcp.patch.yml");
  atomicWriteTextSync(memberPatch, yaml.dump([{ insert: out }]));
  console.log(`[dsh-profile] member patch for ${personaPreset}: ${out.length} server(s) → ${memberPatch}`);
  return memberPatch;
}

// The override math, PURE (exported for the boundary test): fd-memory row
// carries the member token or DROPS (profile memory off = the tools do not
// appear, never a dead entry); library row gets LIBRARY_COLLECTIONS stamped
// (empty = pre-change whole-account view, byte-for-byte); `library:` prefixes
// are stripped HERE (single point — callers may pass blueprint refs or bare
// ids); everything else rides verbatim.
// The fd-memory row does NOT depend on the base composition having a person
// mount: the member token is the identity, so an absent row with a present
// token APPENDS a standard entry (the memoryMcpEntry shape, verbatim). This
// is what makes the member patch self-sufficient — the base writer only adds
// the person row when the person mount resolves, which is orthogonal to
// whether the member's own memory face exists.
export function applyMemberOverrides(insert, { memoryToken = null, libraryCollections = [], memoryUrl = null } = {}) {
  const ids = libraryCollections.map((c) => String(c).replace(/^library:/, "")).filter(Boolean);
  const hasMemoryRow = insert.some((e) => e?.config?.serverName === "fd-memory");
  let out = insert
    .filter((e) => !(e?.config?.serverName === "fd-memory" && (!memoryToken || hasMemoryRow === false && memoryToken)))
    .map((e) => {
      if (e?.config?.serverName === "fd-memory" && memoryToken) {
        return { ...e, config: { ...e.config, headers: { ...(e.config.headers ?? {}), Authorization: `Bearer ${memoryToken}` } } };
      }
      if (e?.config?.serverName === "library" && ids.length > 0) {
        return { ...e, config: { ...e.config, env: { ...(e.config.env ?? {}), LIBRARY_COLLECTIONS: ids.join(",") } } };
      }
      return e;
    });
  if (memoryToken && !hasMemoryRow) {
    out = [
      ...out,
      {
        id: "mcp-fd-memory",
        name: "@deepseek-ai/dsh-mcp-client",
        config: {
          serverName: "fd-memory",
          failOnStartupError: false,
          transport: "streamable-http",
          ...(memoryUrl ? { url: memoryUrl } : {}),
          headers: { Authorization: `Bearer ${memoryToken}` },
        },
      },
    ];
  }
  return out;
}

function safeProfileSegment(s) {
  return String(s ?? "x").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "x";
}

// ── MCP tool allowlist filter (add-mcp-tool-scoping D1/D2) ────────────────────
// Materializes the focused role's per-server tool allowlists as the config the
// preset bridge's scope module reads: tool-filter.json beside the copied
// bridge files (the chart-bind allowlist precedent — a plain data file, not a
// loader entry, so no patch row is consumed). The scope module itself ships
// beside the preset bridge (its relative import target) and is refreshed on
// every materialization, idempotently.
//
// `mcpTools` is the derived map ({server: [leaf...]}), null/empty = no
// filtering (full mode, legacy packs, a persona without allowlists) — the
// bridge no-ops on an empty mapping, which is what keeps every pre-change
// composition byte-identical in behavior.
// `dirs` ({dshHome, profileName}) re-aims the writer at a private home — the
// same parameterization writePresetsPatch takes, so agent-runner's per-role
// homes carry the filter through the one shared writer (zero format drift).
const TOOL_SCOPE_BRIDGE_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "dsh-profile-template", "platform-tool-scope.js");
const TOOL_DESCRIPTION_BRIDGE_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "dsh-profile-template", "platform-tool-description.js");
const TOOL_FILTER_FILE = "tool-filter.json";
const TOOL_DESCRIPTION_FILE = "tool-description.json";

export function writeToolFilterPatch(mcpTools, { dirs = null, denyTools = null } = {}) {
  const profileDir = dirs
    ? join(dirs.dshHome, "profiles", dirs.profileName || "platform")
    : dirname(MCP_PATCH_PATH);
  mkdirSync(profileDir, { recursive: true });
  // add-dsh-pod-adapter: pack homes pass the pod filter doc —
  // { mcpTools: <union>, byPreset: { <presetId>: { mcpTools: {…} } } } —
  // recognized by an own `byPreset` key (a raw per-server map never carries
  // one). The union feeds the guard/register-shadow (upper bound: never
  // narrower than a member's own allowlist); per-preset sections are the
  // member exact faces composition-time restrict resolves. Everything else
  // keeps the legacy single-map doc byte-for-byte.
  const doc = Object.hasOwn(mcpTools ?? {}, "byPreset")
    ? {
        mcpTools: mcpTools.mcpTools && typeof mcpTools.mcpTools === "object" ? mcpTools.mcpTools : {},
        ...(mcpTools.byPreset && typeof mcpTools.byPreset === "object" ? { byPreset: mcpTools.byPreset } : {}),
      }
    : { mcpTools: mcpTools && typeof mcpTools === "object" ? mcpTools : {} };
  // Operator-face provenance (add-crm-desk-bridge D5): the guard needs to know
  // WHICH denials are platform governance (no escape hatch) versus role
  // narrowing (Settings → MCP full-surface escape hatch applies). The faces of
  // servers actually present in the composition ride the doc; the guard reads
  // them per call. Absent section = pre-change denial copy byte-for-byte.
  const operatorSection = {};
  for (const [server, face] of Object.entries(OPERATOR_TOOL_FACES)) {
    if (doc.mcpTools && Object.hasOwn(doc.mcpTools, server)) operatorSection[server] = [...face].sort();
  }
  if (Object.keys(operatorSection).length) doc.operatorFaces = operatorSection;
  // Denied built-in tools (fix-external-team-chat-lane B3): a public-facing
  // persona may not use the workspace file tools (glob / grep / read / bash)
  // nor the roster-discovery tools (tool_search / list_agents /
  // list_mcp_resources) — the last group is how the model enumerated the
  // internal tool names in the first place. Absent ⇒ nothing denied (every
  // pre-change composition is byte-for-byte).
  if (Array.isArray(denyTools) && denyTools.length) {
    doc.denyTools = [...new Set(denyTools.filter((n) => typeof n === "string" && n.trim()))].sort();
  }
  atomicWriteTextSync(join(profileDir, TOOL_FILTER_FILE), JSON.stringify(doc, null, 2) + "\n");
  try {
    atomicWriteTextSync(join(profileDir, "platform-tool-scope.js"), readFileSync(TOOL_SCOPE_BRIDGE_SOURCE, "utf8"));
    // The description module rides the same refresh (the preset bridge imports
    // it — add-tool-description-enrichment); a stale copy keeps the prior
    // briefs serving, same degraded-window posture as the scope module.
    atomicWriteTextSync(join(profileDir, "platform-tool-description.js"), readFileSync(TOOL_DESCRIPTION_BRIDGE_SOURCE, "utf8"));
  } catch (err) {
    // A stale copy from an earlier materialization keeps the guard alive; the
    // warning names the degraded window instead of failing composition.
    console.warn(`[dsh-profile] could not refresh platform-tool-scope.js (${err.message}); the existing copy (if any) keeps serving`);
  }
  return join(profileDir, TOOL_FILTER_FILE);
}

// ── Tool description overlay (add-tool-description-enrichment D1) ─────────────
// Materializes the annotation layer's canonical briefs as the config the
// preset bridge's description module reads: tool-description.json beside the
// copied bridge files (the tool-filter.json precedent — a plain data file, no
// patch row). `briefs` is getCanonicalBriefs()'s shape ({ tools: {
// "<server>__<leaf>": { brief, source, updatedAt } } }); null/empty REMOVES
// any stale file, so a disabled switch or a public-facing face leaves no
// overlay behind — the consumer reads absence as "no enrichment", keeping
// every pre-change composition byte-identical.
export function writeToolDescriptionOverlay(briefs, { dirs = null } = {}) {
  const profileDir = dirs
    ? join(dirs.dshHome, "profiles", dirs.profileName || "platform")
    : dirname(MCP_PATCH_PATH);
  const target = join(profileDir, TOOL_DESCRIPTION_FILE);
  const tools = briefs?.tools && typeof briefs.tools === "object" ? briefs.tools : {};
  const descriptions = {};
  let enriched = 0;
  for (const [key, v] of Object.entries(tools)) {
    const sep = key.indexOf("__");
    const brief = typeof v?.brief === "string" ? v.brief.trim() : "";
    if (sep <= 0 || !brief) continue;
    const server = key.slice(0, sep);
    const leaf = key.slice(sep + 2);
    if (!server || !leaf) continue;
    descriptions[server] ??= {};
    descriptions[server][leaf] = {
      brief,
      source: typeof v.source === "string" ? v.source : null,
      updatedAt: typeof v.updatedAt === "string" ? v.updatedAt : null,
    };
    enriched++;
  }
  if (!enriched) {
    try { rmSync(target); } catch { /* absent is the goal */ }
    return null;
  }
  mkdirSync(profileDir, { recursive: true });
  const doc = { descriptions, meta: { enriched, source: "annotations", generatedAt: new Date().toISOString() } };
  atomicWriteTextSync(target, JSON.stringify(doc, null, 2) + "\n");
  console.log(`[dsh-profile] tool-description overlay: ${enriched} tool(s) enriched → ${TOOL_DESCRIPTION_FILE}`);
  return target;
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

// The public tool face (fix-external-team-chat-lane B3, decision 2026-10-30):
// a public-facing pack's personas may mount the fleet bridge (its own team
// lane) and the market/directory faces, and NOTHING else. Everything else —
// the internal business desks (wire-ops / lex-ops / paper-trading /
// facet-market / facet-ops / fd-*) and the authoring surfaces (pack-author /
// blueprint-author) — stays off, because their names and descriptions reach
// the model and end up in visitor-facing answers.
//
// Configurable so an operator can widen it without a code change; the default
// is the list the user approved.
const PUBLIC_FACE_DEFAULT = ["fleet", "market", "marketplace", "market-catalog", "websearch", "fd-official-web"];

// The built-in tools a public-facing persona may not use. The workspace file
// tools would let it read the deployment's own project files; the roster
// discovery tools are how the model enumerates the internal tool names.
const PUBLIC_FACING_DENIED_TOOLS = [
  "glob",
  "grep",
  "read",
  "bash",
  "list_agents",
  "list_mcp_resources",
  "tool_search",
];

function publicFaceNames() {
  const raw = process.env.PACK_PUBLIC_FACE_MCP;
  const names = raw === undefined
    ? PUBLIC_FACE_DEFAULT
    : raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  return new Set(names);
}

function isPublicFace(name) {
  if (!name) return false;
  // Prefix match on the declared list: "market" admits "marketplace" and
  // "market-catalog" — the operator names a FACE, not a server.
  for (const allowed of publicFaceNames()) {
    if (name === allowed || name.startsWith(`${allowed}-`)) return true;
  }
  return false;
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
// full mode, { source: "pack", packId, packName, persona, mcpKeep, mcpTools,
// skillsDir, skillsDecl, overlay } for a pack persona, or { source: "custom",
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
//
// add-mcp-tool-scoping D6: `mcpTools` carries the per-server tool allowlists —
// for each KEPT reference, the role's resources.mcpTools list when declared
// (intersected with the pack-level allowTools for defense — the validator
// already enforces subset at publish), else the pack-level allowTools, else
// the server is absent from the map = full surface. null for full mode and
// custom presets (v1 declares tools on packs only).
//
// full-mode-tool-scope: full mode and custom presets gain a tool dimension too.
// The union is derived from the durable installed-pack snapshots at EVERY
// composition (never persisted), and the per-server override (a global
// preference) removes a server from any map — removal IS the marker, because
// the runtime bridge only narrows servers present in the map.

const fullModeToolScopeEnabled = () =>
  String(process.env.FULL_MODE_TOOL_SCOPE || "").trim().toLowerCase() === "on";

// Fail-open: an unavailable DB yields no filter rather than hiding tools.
async function readFullSurfaceOverrides() {
  try {
    const db = await import("./db.js");
    if (!db.isDbReady()) return [];
    return db.getFullSurfaceServers();
  } catch {
    return [];
  }
}

async function fullModeToolInputs() {
  let installed = [];
  let overrides = [];
  try {
    const db = await import("./db.js");
    if (db.isDbReady()) {
      installed = db.listInstalledPacks();
      overrides = db.getFullSurfaceServers();
    }
  } catch { /* no inputs ⇒ no filter (fail open) */ }
  return { union: deriveFullModeToolScope(installed, overrides), overrides };
}

export async function deriveScope(agentPreset, { noOverlay = false } = {}) {
  const full = { source: null, packId: null, packName: null, persona: null, mcpKeep: null, mcpTools: null, skillsDir: null, skillsDecl: undefined, overlay: null };
  const persona = await resolvePersona(agentPreset);
  if (!persona) {
    // Full mode's tool dimension (full-mode-tool-scope B1/B2): the union of
    // the installed packs' declarations, with the safety valve inside the
    // derivation. Flag off keeps the pre-change null composition.
    if (!fullModeToolScopeEnabled()) return full;
    const { union } = await fullModeToolInputs();
    return { ...full, mcpTools: union };
  }
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
    const mcpKeep = [...new Set(row.mcpServers ?? [])];
    // Tool dimension (full-mode-tool-scope D4): a declared per-server list
    // narrows; an absent one inherits the full-mode union; the override
    // removes the server. Flag off keeps the pre-change null byte-for-byte.
    let mcpTools = null;
    if (fullModeToolScopeEnabled()) {
      const inputs = await fullModeToolInputs();
      mcpTools = customPresetToolScope(mcpKeep, row.mcpTools ?? {}, inputs.union, inputs.overrides);
    }
    return {
      source: "custom",
      packId: null,
      packName: null,
      persona: null,
      customPresetId: row.id,
      customPresetName: row.name,
      mcpKeep,
      mcpTools,
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
  // Tool allowlists (add-mcp-tool-scoping D6) — one shared definition with the
  // serving descriptor (lib/pack-manifest.js effectiveMcpTools); only kept
  // servers appear, a dropped server's allowlist is moot (not loaded).
  const mcpTools = effectiveMcpTools(persona.manifest, persona.agent);
  // Per-server full-surface override (full-mode-tool-scope B3): removing the
  // key IS the marker — the bridge only narrows servers present in the map.
  for (const server of await readFullSurfaceOverrides()) delete mcpTools[server];
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
    mcpTools,
    skillsDir,
    skillsDecl: Array.isArray(skillsDecl) ? skillsDecl : undefined,
    overlay,
    // External-team declaration (fix-external-team-chat-lane B3): the pack
    // says it faces visitors, so its personas get the narrowed public tool
    // face. Absent ⇒ undefined ⇒ the current focus path is byte-identical.
    publicFacing: persona.manifest?.publicFacing === true,
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
const BRIDGE_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "dsh-profile-template", "platform-preset-bridge.js");
const PRESET_BRIDGE_FILE = "platform-preset-bridge.js";
export const DEFAULT_AGENT_PRESET = "standard";

// The platform-owned standard agent-plane composition (0.2.0, ADR-0023 D7.2):
// dsh no longer ships config/agent-presets — "the deployment persona is a
// deployment choice" — so the composition lives in dsh-profile-template/ as
// data, translated once from the 0.1.1 shipped `standard`. Every generated
// preset composes from THIS file with the persona row's text swapped, so one
// template serves the platform cell and the runner alike.
const STANDARD_COMPOSITION_SOURCE = join(
  dirname(fileURLToPath(import.meta.url)),
  "dsh-profile-template",
  "standard.agent.cordis.yml",
);

// The two `!!js` platform gates in the template are evaluated HERE, at
// composition-write time: this writer runs on the target host, so the rows it
// emits carry plain booleans and the whole plugins list stays plain YAML
// (round-trippable by js-yaml — the 0.1.1 text-surgery workaround retired).
export function standardCompositionRows() {
  const text = readFileSync(STANDARD_COMPOSITION_SOURCE, "utf8")
    .replaceAll("disabled: !!js process.platform === 'win32'", `disabled: ${process.platform === "win32"}`)
    .replaceAll("disabled: !!js process.platform !== 'win32'", `disabled: ${process.platform !== "win32"}`);
  const rows = yaml.load(text);
  if (!Array.isArray(rows)) throw new Error(`standard composition is not an entry list: ${STANDARD_COMPOSITION_SOURCE}`);
  return rows;
}

// One generated preset's plugin rows: the standard composition with the
// persona row's prefix swapped (data-level, not YAML round-trip; 0.2.0's
// dsh-persona schema is prefix/suffix sections).
export function composePresetRows(persona) {
  const rows = structuredClone(standardCompositionRows());
  const personaRow = rows.find((r) => r && typeof r === "object" && r.id === "persona");
  if (!personaRow) throw new Error("standard composition has no `persona` row");
  personaRow.config = { ...(personaRow.config ?? {}), prefix: persona };
  return rows;
}

// Write the bridge plugin file + presets.patch.yml into the profile dir.
// Returns the patch path for the bridge's --patch args.
//
// Target-home + roster composition (add-dsh-matrix-lock design D6): agent-
// runner/compose.js calls this with its own { dshHome } plus the role's
// persona definition, so the presets overlay format exists only here.
//   - dirs           { dshHome, profileName } — default the deployment
//                    singleton, which also folds in the persisted catalog
//                    preset definitions (0.2.0 D7.2)
//   - default        registry default preset id (platform: "standard")
//   - extraPresets   additional preset definitions
//                    { id, name, description, order, persona } (runner: the
//                    role's persona row)
export function writePresetsPatchSync({ dirs, default: defaultPreset = DEFAULT_AGENT_PRESET, extraPresets = [] } = {}) {
  const presetsPatchPath = targetPaths(dirs).presetsPatch;
  mkdirSync(dirname(presetsPatchPath), { recursive: true });
  // The bridge source is copied into the profile dir because the loader
  // resolves a relative plugin name beside the profile's cordis.yml. Written
  // UNCONDITIONALLY, before any roster work: platform-permission-bridge.js
  // (written by writePermissionsPatch, loaded by its unconditional overlay)
  // imports this file — skipping it here leaves a dangling import that
  // crashes dsh at boot.
  const bridgeTarget = join(dirname(presetsPatchPath), PRESET_BRIDGE_FILE);
  atomicWriteTextSync(bridgeTarget, readFileSync(BRIDGE_SOURCE, "utf8"));
  // The preset bridge imports the tool-scope module (add-mcp-tool-scoping
  // D2) — same unconditional-copy discipline as the bridge itself. The
  // tool-description module rides for the same reason (add-tool-description-
  // enrichment): the bridge chains its register wrapper at plugin start.
  atomicWriteTextSync(
    join(dirname(presetsPatchPath), "platform-tool-scope.js"),
    readFileSync(TOOL_SCOPE_BRIDGE_SOURCE, "utf8"),
  );
  atomicWriteTextSync(
    join(dirname(presetsPatchPath), "platform-tool-description.js"),
    readFileSync(TOOL_DESCRIPTION_BRIDGE_SOURCE, "utf8"),
  );
  // The deployment singleton folds in the catalog/custom preset definitions
  // (persisted in $DSH_HOME/.agent-presets.defs.json); an explicit dirs
  // target (the runner's private homes) uses only the caller's extras —
  // those homes have no platform catalog.
  const defs = dirs ? [...extraPresets] : [...extraPresets, ...catalogPresetDefinitions()];
  // Cell memory discipline (fix-memory-capture-p0 D6): on the deployment
  // singleton, when the cell memory mount is configured, every persona preset
  // carries the discipline text in the dsh-persona suffix — the mount row and
  // the persona text appear and disappear together (CELL_MEMORY_ENABLED=0
  // leaves the output byte-identical). Runner-private homes (dirs set) are
  // excluded: the runner appends the discipline into the persona text itself
  // at materialization, gated on the mount actually being present.
  const cellMemoryOn = !dirs && Boolean(cellMemoryConfig(process.env));
  const personaSuffix = (rows) => {
    if (cellMemoryOn) {
      const personaRow = rows.find((r) => r && typeof r === "object" && r.id === "persona");
      if (personaRow) {
        personaRow.config = { ...(personaRow.config ?? {}), suffix: `${personaRow.config?.suffix ?? ""}${MEMORY_DISCIPLINE}` };
      }
    }
    return rows;
  };
  const presetRows = [
    {
      id: "preset-standard",
      name: "@deepseek-ai/dsh-agent-preset",
      config: {
        id: "standard",
        name: "Standard",
        description: "The full local agent",
        order: 10,
        plugins: personaSuffix(standardCompositionRows()),
      },
    },
    ...defs.map((d) => ({
      id: `preset-${d.id}`,
      name: "@deepseek-ai/dsh-agent-preset",
      config: {
        id: d.id,
        name: d.name,
        description: d.description,
        order: d.order ?? 50,
        plugins: personaSuffix(composePresetRows(d.persona)),
      },
    })),
  ];
  const patch = [
    { id: "sdk-jsonrpc-server", disabled: true },
    {
      insert: [
        { id: "agent-presets", name: "@deepseek-ai/dsh-agent-preset-registry", config: { default: defaultPreset } },
        ...presetRows,
        { id: "platform-sdk-server", name: `./${PRESET_BRIDGE_FILE}` },
      ],
    },
  ];
  atomicWriteTextSync(presetsPatchPath, yaml.dump(patch));
  console.log(
    `[dsh-profile] wrote preset overlay (registry default: ${defaultPreset}, ${presetRows.length} preset row(s)) → ${presetsPatchPath}`,
  );
  return presetsPatchPath;
}

export async function writePresetsPatch(opts = {}) {
  return writePresetsPatchSync(opts);
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
// The preset id the platform itself always composes (0.2.0: no shipped
// four — dsh ships none; the platform's standard row IS the baseline). A
// catalog entry may not shadow it, and the boot-time preset guard treats it
// as always-known.
const SHIPPED_PRESET_IDS = ["standard"];

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

// Per-preset MCP face, PURE (trim-mcp-injection-per-post 2.1): given the
// installed-pack snapshots, return the { mcpTools } face a preset declares.
// The caller resolves the DB (exactly like packPersonaToolFaces does at
// composition time) and hands the list in, so this stays testable and this
// module keeps no catalog knowledge of its own.
//
// Returns null when the preset declares nothing — the caller passes that
// straight to trimServersToFace, whose safety valve then keeps the full
// composition. Never fabricates an empty face: "declares nothing" and
// "declares nothing usable" must both mean "do not narrow".
export function faceForPresetFromPacks(installedPacks, presetId) {
  if (!presetId || !Array.isArray(installedPacks)) return null;
  const want = rosterPresetId(presetId);
  const merged = {};
  for (const installed of installedPacks) {
    const manifest = installed?.manifest;
    if (!manifest) continue;
    for (const agent of manifest.agents ?? []) {
      if (!agent?.id) continue;
      if (rosterPresetId(agent.id) !== want) continue;
      const tools = effectiveMcpTools(manifest, agent);
      for (const [server, list] of Object.entries(tools)) {
        const prev = merged[server];
        merged[server] = prev ? [...new Set([...prev, ...list])] : [...list];
      }
    }
  }
  return Object.keys(merged).length ? merged : null;
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
  // Memory constitution (add-agent-self-iteration): the agent's own
  // declaration composed as the persona's tail — the self-writing face
  // (memory_write_page) and the recall face (fleetContext digest) read it.
  const guidance = typeof entry?.memory === "object" && entry?.memory !== null
    ? String(entry.memory.guidance ?? "").trim()
    : "";
  if (guidance) {
    lines.push(`【记忆章程】${guidance}`);
  }
  if (entry?.packId) lines.push(PACK_FOCUS_NOTE);
  else if (entry?.customPreset) lines.push(CUSTOM_FOCUS_NOTE);
  lines.push("You are powered by the {{model}} model; your working directory is {{cwd}}.");
  return lines.join("\n");
}

// ── Catalog/custom preset definitions (0.2.0 declarative model, D7.2) ───────
// Upstream's preset registry no longer discovers directories, so generated
// presets live as rows in the preset overlay (writePresetsPatchSync). The
// definition set persists in $DSH_HOME/.agent-presets.defs.json so a restart
// (new process, cold module state) still knows the roster BEFORE the catalog
// refresh runs — the persisted-preset validation at server boot depends on
// it (0.1.1 got this for free from the on-disk .agent-presets dirs).
const CATALOG_PRESET_DEFS_PATH = join(DSH_HOME, ".agent-presets.defs.json");
let catalogPresetDefs = null;
// Read-only view for callers that need the current definition set (tests
// merge seeds into it; writeCatalogAgentPresets itself replaces the set).
export function catalogPresetDefinitions() {
  if (catalogPresetDefs === null) {
    try {
      const loaded = JSON.parse(readFileSync(CATALOG_PRESET_DEFS_PATH, "utf8"));
      catalogPresetDefs = Array.isArray(loaded) ? loaded : [];
    } catch {
      catalogPresetDefs = [];
    }
  }
  return catalogPresetDefs;
}

// Preset ids the deployment can boot with: the platform's standard row plus
// every generated catalog/custom preset. Used to
// validate the persisted preset choice BEFORE the child spawns — an unknown id
// there would fail every new session's mount.
export function knownPresetIds() {
  return new Set(["standard", ...catalogPresetDefinitions().map((d) => d.id)]);
}

// Does this catalog entry id have a generated local-preset composition? True ⇒
// the id is served by the LOCAL agent (tools + history + persona) rather than
// forked to its remote endpoint.
export function hasCatalogAgentPreset(id) {
  if (!isSafePresetId(id)) return false;
  return catalogPresetDefinitions().some((d) => d.entryId === id || d.id === rosterPresetId(id));
}

// Generate/refresh/prune the preset definitions for chat-mode catalog agents
// (custom presets ride the same flow — they are catalog entries with
// customPreset set). Returns { changed, ids }: `changed` drives the host's
// roster refresh (a child restart is what makes `presets/list` see a new
// preset — the overlay is a --patch layer, deliberately NOT hot-watched).
// Idempotent — the defs file and overlay are only rewritten when the
// definition set differs, so a catalog poll costs nothing.
export function writeCatalogAgentPresets(entries = []) {
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
      console.warn(`[dsh-profile] catalog agents '${wanted.get(dirId).id}' and '${entry.id}' map to the same preset id '${dirId}'; the latter stays a remote chat`);
      continue;
    }
    wanted.set(dirId, entry);
  }
  const defs = [];
  wanted.forEach((entry, dirId) => {
    const name = entry.name || entry.id;
    defs.push({
      id: dirId,
      entryId: entry.id,
      name,
      description: (entry.description || `Catalog agent ${name}`).trim(),
      order: 50 + defs.length,
      persona: catalogEntryPersona(entry),
    });
  });
  const changed = JSON.stringify(defs) !== JSON.stringify(catalogPresetDefinitions());
  if (changed) {
    catalogPresetDefs = defs;
    atomicWriteTextSync(CATALOG_PRESET_DEFS_PATH, `${JSON.stringify(defs, null, 2)}\n`);
    // Stale 0.1.1 materialization dirs are inert under 0.2.0 (nothing
    // discovers directories anymore); prune the ones we generated so
    // $DSH_HOME stays honest.
    try {
      for (const dirent of readdirSync(CATALOG_PRESET_ROOT, { withFileTypes: true })) {
        if (dirent.isDirectory() && existsSync(join(CATALOG_PRESET_ROOT, dirent.name, CATALOG_PRESET_MARKER))) {
          rmSync(join(CATALOG_PRESET_ROOT, dirent.name), { recursive: true, force: true });
        }
      }
    } catch { /* no legacy root */ }
    writePresetsPatchSync();
    console.log(`[dsh-profile] catalog agent presets: ${defs.map((d) => d.id).join(", ") || "(none)"}`);
  }
  return { changed, ids: defs.map((d) => d.id) };
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

// ── Save-library bridge patch (add-save-to-library-tool) ────────────────────
// The `save_to_library` tool (ingest workspace files into the resource library
// during the turn) rides its own overlay, exactly like chart_bind: the plugin
// is copied into the profile dir and one fresh row is inserted. No allowlist
// and no subclassing — the tool is a thin client over the save-declared
// loopback route; all gates live server-side. Purely additive: without the
// overlay the roster is unchanged and chat works as before.
const SAVE_LIBRARY_PATCH_PATH = join(DSH_HOME, "profiles", PROFILE_NAME, "save-library.patch.yml");
const SAVE_LIBRARY_BRIDGE_SOURCE = join(
  dirname(fileURLToPath(import.meta.url)),
  "dsh-profile-template",
  "platform-save-library-bridge.js",
);

export function writeSaveLibraryPatch() {
  mkdirSync(dirname(SAVE_LIBRARY_PATCH_PATH), { recursive: true });
  atomicWriteTextSync(
    join(dirname(SAVE_LIBRARY_PATCH_PATH), "platform-save-library-bridge.js"),
    readFileSync(SAVE_LIBRARY_BRIDGE_SOURCE, "utf8"),
  );
  const patch = [{ insert: [{ id: "save-library-bridge", name: "./platform-save-library-bridge.js" }] }];
  atomicWriteTextSync(SAVE_LIBRARY_PATCH_PATH, yaml.dump(patch));
  console.log(`[dsh-profile] wrote save-library bridge patch → ${SAVE_LIBRARY_PATCH_PATH}`);
  return SAVE_LIBRARY_PATCH_PATH;
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

// ── Plugin-supply bridge patch (add-dsh-plugin-supply) ──────────────────────
// The dsh-layer plugin supply face: platform-plugin-supply-bridge.js subclasses
// the user-questions bridge and exposes the profile's `pluginManager` service
// (composed by the dsh-base bundle) as `plugins/list` + `plugins/set_enabled`.
// Toggles are BUNDLE-layer only and ride the service's own write semantics
// (manifest bundles-list edit + reload: "applied" under HMR,
// "restart-required" otherwise — the host then restarts the child through the
// established path). Runtime package installation is deliberately not exposed:
// v1 supply is the deployment whitelist (matrix bake + template bundles), never
// a runtime installer (design D2).
//
// Swap mechanics mirror the user-questions overlay: this patch disables the
// `platform-user-questions-server` row and inserts the subclass under a fresh
// `platform-plugin-supply-server` row. Layer order: AFTER
// user-questions.patch.yml (it swaps the row that overlay inserted) and BEFORE
// save-library.patch.yml (insert-only, so order vs it is immaterial) — fixed by
// dsh-bridge.js's patchArgs.
const PLUGIN_SUPPLY_PATCH_PATH = join(DSH_HOME, "profiles", PROFILE_NAME, "plugin-supply.patch.yml");
const PLUGIN_SUPPLY_BRIDGE_SOURCE = join(
  dirname(fileURLToPath(import.meta.url)),
  "dsh-profile-template",
  "platform-plugin-supply-bridge.js",
);
const PLUGIN_SUPPLY_BRIDGE_FILE = "platform-plugin-supply-bridge.js";

// Write the plugin-supply bridge file + plugin-supply.patch.yml into the
// profile dir. The bridge imports the user-questions bridge (its subclass
// parent), so that file (and its own permission parent) is re-written beside it
// — same idempotent-copy shape the user-questions overlay uses. Returns the
// patch path for the --patch args. Unconditional like its predecessors: an
// absent pluginManager service degrades to an empty roster inside the bridge
// (Plugins section renders "no bundles supplied", chat unaffected).
export function writePluginSupplyPatch() {
  mkdirSync(dirname(PLUGIN_SUPPLY_PATCH_PATH), { recursive: true });
  const profileDir = dirname(PLUGIN_SUPPLY_PATCH_PATH);
  atomicWriteTextSync(
    join(profileDir, USER_QUESTIONS_BRIDGE_FILE),
    readFileSync(USER_QUESTIONS_BRIDGE_SOURCE, "utf8"),
  );
  atomicWriteTextSync(
    join(profileDir, PERMISSION_BRIDGE_FILE),
    readFileSync(PERMISSION_BRIDGE_SOURCE, "utf8"),
  );
  atomicWriteTextSync(
    join(profileDir, PLUGIN_SUPPLY_BRIDGE_FILE),
    readFileSync(PLUGIN_SUPPLY_BRIDGE_SOURCE, "utf8"),
  );
  const patch = [
    { id: "platform-user-questions-server", disabled: true },
    {
      insert: [{ id: "platform-plugin-supply-server", name: `./${PLUGIN_SUPPLY_BRIDGE_FILE}` }],
    },
  ];
  atomicWriteTextSync(PLUGIN_SUPPLY_PATCH_PATH, yaml.dump(patch));
  console.log(`[dsh-profile] wrote plugin supply bridge patch → ${PLUGIN_SUPPLY_PATCH_PATH}`);
  return PLUGIN_SUPPLY_PATCH_PATH;
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
  // a caller ever writes this overlay ahead of the presets one. The parent's
  // own dependency (platform-tool-scope.js) rides along for the same reason.
  atomicWriteTextSync(join(profileDir, PRESET_BRIDGE_SOURCE_FILE), readFileSync(BRIDGE_SOURCE, "utf8"));
  atomicWriteTextSync(join(profileDir, "platform-tool-scope.js"), readFileSync(TOOL_SCOPE_BRIDGE_SOURCE, "utf8"));
  atomicWriteTextSync(join(profileDir, "platform-tool-description.js"), readFileSync(TOOL_DESCRIPTION_BRIDGE_SOURCE, "utf8"));
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

// ── Serving questions bridge patch (add-serving-ask-bridge D1) ──────────────
// The serving child's ask answerer: platform-serving-questions-bridge.js
// (a NotifySdkServer subclass carrying the cell bridge's ask body) is copied
// into the profile dir and a fresh-insert row disables the notify row it
// subclasses — the chain grows by disable + insert, one overlay per face:
//   presets.patch.yml inserts `platform-sdk-server`
//   → notify.patch.yml disables it, inserts `platform-notify-server`
//   → serving-questions.patch.yml disables THAT, inserts
//     `platform-serving-questions-server`.
// Composed into agent-runner children only (compose.js calls this writer with
// the child's PRIVATE home, AFTER writeNotifyPatch — layer order is fixed by
// compose.js's patchPaths); the platform's own web children keep their
// permission-bridge chain untouched.
const SERVING_QUESTIONS_BRIDGE_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "dsh-profile-template", "platform-serving-questions-bridge.js");
export const SERVING_QUESTIONS_BRIDGE_FILE = "platform-serving-questions-bridge.js";
export const SERVING_QUESTIONS_PATCH_FILE = "serving-questions.patch.yml";

// Write the serving questions bridge file + serving-questions.patch.yml into
// the profile dir. Same { dshHome, profileName } contract as writeNotifyPatch;
// returns the patch path for the child's --patch args. (Distinct from the
// cell-side writeUserQuestionsPatch above, which swaps the PERMISSION row.)
export function writeServingQuestionsPatch({ dirs } = {}) {
  const profileDir = dirname(targetPaths(dirs).presetsPatch);
  mkdirSync(profileDir, { recursive: true });
  // The subclass parent chain, re-written idempotently: the questions bridge
  // imports the notify bridge, which imports the preset bridge — every layer
  // must resolve regardless of which overlay a caller writes first.
  atomicWriteTextSync(join(profileDir, PRESET_BRIDGE_SOURCE_FILE), readFileSync(BRIDGE_SOURCE, "utf8"));
  atomicWriteTextSync(join(profileDir, "platform-tool-scope.js"), readFileSync(TOOL_SCOPE_BRIDGE_SOURCE, "utf8"));
  atomicWriteTextSync(join(profileDir, "platform-tool-description.js"), readFileSync(TOOL_DESCRIPTION_BRIDGE_SOURCE, "utf8"));
  atomicWriteTextSync(join(profileDir, NOTIFY_BRIDGE_FILE), readFileSync(NOTIFY_BRIDGE_SOURCE, "utf8"));
  atomicWriteTextSync(join(profileDir, NOTIFY_MODULE_FILE), readFileSync(NOTIFY_MODULE_SOURCE, "utf8"));
  atomicWriteTextSync(join(profileDir, SERVING_QUESTIONS_BRIDGE_FILE), readFileSync(SERVING_QUESTIONS_BRIDGE_SOURCE, "utf8"));
  const patchPath = join(profileDir, SERVING_QUESTIONS_PATCH_FILE);
  const patch = [
    { id: "platform-notify-server", disabled: true },
    { insert: [{ id: "platform-serving-questions-server", name: `./${SERVING_QUESTIONS_BRIDGE_FILE}` }] },
  ];
  atomicWriteTextSync(patchPath, yaml.dump(patch));
  console.log(`[dsh-profile] wrote serving questions bridge patch → ${patchPath}`);
  return patchPath;
}

// ── Matters bridge patch (add-matter-threads D2) ─────────────────────────────
// The facade reception's matter face: platform-matters-bridge.js (a
// ServingQuestionsSdkServer subclass carrying the matter trio from
// matter-tools.js) is copied into the profile dir and a fresh-insert row
// disables the questions row it subclasses — the chain grows by disable +
// insert, one overlay per face:
//   presets.patch.yml inserts `platform-sdk-server`
//   → notify.patch.yml disables it, inserts `platform-notify-server`
//   → serving-questions.patch.yml disables THAT, inserts
//     `platform-serving-questions-server`
//   → matters.patch.yml disables THAT, inserts `platform-matters-server`.
// Composed into agent-runner FACADE children only (compose.js gates this
// writer on the descriptor's `facade` block, AFTER writeServingQuestionsPatch
// — layer order is fixed by compose.js's patchPaths); non-facade children
// keep the questions row and structurally never see the matter tools.
const MATTERS_BRIDGE_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "dsh-profile-template", "platform-matters-bridge.js");
const MATTERS_MODULE_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "dsh-profile-template", "matter-tools.js");
export const MATTERS_BRIDGE_FILE = "platform-matters-bridge.js";
export const MATTERS_MODULE_FILE = "matter-tools.js";
export const MATTERS_PATCH_FILE = "matters.patch.yml";

// Write the matters bridge files + matters.patch.yml into the profile dir.
// Same { dshHome, profileName } contract as writeNotifyPatch; returns the
// patch path for the child's --patch args.
export function writeMattersPatch({ dirs } = {}) {
  const profileDir = dirname(targetPaths(dirs).presetsPatch);
  mkdirSync(profileDir, { recursive: true });
  // The full subclass parent chain, re-written idempotently (every layer
  // must resolve regardless of which overlay a caller writes first).
  atomicWriteTextSync(join(profileDir, PRESET_BRIDGE_SOURCE_FILE), readFileSync(BRIDGE_SOURCE, "utf8"));
  atomicWriteTextSync(join(profileDir, "platform-tool-scope.js"), readFileSync(TOOL_SCOPE_BRIDGE_SOURCE, "utf8"));
  atomicWriteTextSync(join(profileDir, "platform-tool-description.js"), readFileSync(TOOL_DESCRIPTION_BRIDGE_SOURCE, "utf8"));
  atomicWriteTextSync(join(profileDir, NOTIFY_BRIDGE_FILE), readFileSync(NOTIFY_BRIDGE_SOURCE, "utf8"));
  atomicWriteTextSync(join(profileDir, NOTIFY_MODULE_FILE), readFileSync(NOTIFY_MODULE_SOURCE, "utf8"));
  atomicWriteTextSync(join(profileDir, SERVING_QUESTIONS_BRIDGE_FILE), readFileSync(SERVING_QUESTIONS_BRIDGE_SOURCE, "utf8"));
  atomicWriteTextSync(join(profileDir, MATTERS_BRIDGE_FILE), readFileSync(MATTERS_BRIDGE_SOURCE, "utf8"));
  atomicWriteTextSync(join(profileDir, MATTERS_MODULE_FILE), readFileSync(MATTERS_MODULE_SOURCE, "utf8"));
  const patchPath = join(profileDir, MATTERS_PATCH_FILE);
  const patch = [
    { id: "platform-serving-questions-server", disabled: true },
    { insert: [{ id: "platform-matters-server", name: `./${MATTERS_BRIDGE_FILE}` }] },
  ];
  atomicWriteTextSync(patchPath, yaml.dump(patch));
  console.log(`[dsh-profile] wrote matters bridge patch → ${patchPath}`);
  return patchPath;
}

// ── Tool-face patch (add-serving-tool-face D1/D2) ────────────────────────────
// A serving contract's DECLARED built-in tool reduction, materialized as row
// disables over the dsh-base composition. The chat face strips the
// filesystem/command/web/subagent TOOL rows (the leak/escape vectors the
// 2026-10-25 reception incident rode) and keeps `tool-skill` (the corpus
// entry), `tool-ask-user`, and everything the platform bridges inject via
// ctx.inject (notify/questions/matters — those never ride composition rows).
// Infrastructure service rows (sandbox/subprocess/ptc-runtime/…) stay: an
// unconsumed service is inert, while dropping one risks dependency breakage.
const TOOL_FACE_DROPS = {
  chat: [
    "tool-bash", "tool-pwsh", "tool-jobs",
    "tool-fs", "tool-fs-search",
    "tool-web", "web", "web-search-deepseek", "web-fetch-http",
    "tool-subagent", "tool-subagent-fork", "tool-subagent-list-agents", "tool-subagent-control",
    "tool-workflow", "tool-ralph",
  ],
};
export const TOOL_FACE_PATCH_FILE = "tool-face.patch.yml";

// Write tool-face.patch.yml (pure disable list) into the profile dir. Same
// { dshHome, profileName } contract as the bridge patch writers. An unknown
// face throws — the publish gate validates the enum, and the runner refuses
// a half-known tier rather than silently composing the full face.
export function writeToolFacePatch({ dirs, face }) {
  const drop = TOOL_FACE_DROPS[face];
  if (!drop) throw new Error(`unknown tool face '${face}' (known: ${Object.keys(TOOL_FACE_DROPS).join(", ")})`);
  const profileDir = dirname(targetPaths(dirs).presetsPatch);
  mkdirSync(profileDir, { recursive: true });
  const patchPath = join(profileDir, TOOL_FACE_PATCH_FILE);
  const patch = drop.map((id) => ({ id, disabled: true }));
  atomicWriteTextSync(patchPath, yaml.dump(patch));
  console.log(`[dsh-profile] wrote tool-face '${face}' patch (${drop.length} rows disabled) → ${patchPath}`);
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
  // Preset overlay self-check: shows the generated registry + preset rows.
  const presetsPatch = await writePresetsPatch();
  console.log(`--- presets patch (${presetsPatch}) ---`);
  console.log(readFileSync(presetsPatch, "utf8"));
  // Permission bridge patch self-check.
  const permissionsPatch = await writePermissionsPatch();
  console.log(`--- permissions patch (${permissionsPatch}) ---`);
  console.log(readFileSync(permissionsPatch, "utf8"));
  // Tool-search bridge patch self-check.
  const toolSearchPatch = writeToolSearchPatch();
  console.log(`--- tool-search patch (${toolSearchPatch}) ---`);
  console.log(readFileSync(toolSearchPatch, "utf8"));
  // Catalog agent preset self-check: compose one from the platform-owned
  // standard composition and prove the persona swap landed (this is what a
  // vertical-pack chat agent runs on — see writeCatalogAgentPresets).
  {
    const rows = composePresetRows(catalogEntryPersona({ id: "pack-demo", name: "合同审查官", description: "法律-合同包对话入口", tags: ["法律", "合同"] }));
    const personaRow = rows.find((r) => r?.id === "persona");
    console.assert(personaRow?.config?.prefix?.includes("合同审查官"), "composed preset lost its persona");
    console.assert(rows.some((r) => r?.id === "tool-ask-user"), "the ask tool rides every composed preset");
    console.log("OK catalog agent preset composes (persona prefix swapped, ask tool intact)");
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
    // register the definition the way writeCatalogAgentPresets would.
    writeCatalogAgentPresets([{ type: "agent-remote", mode: "chat", id: AGENT_ID, name: "自检官", description: "自检角色", packId: PACK_ID }]);

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
