// ── Pack manifest content model (openspec: add-pack-marketplace) ─────────────
//
// The single definition of what a pack manifest may contain, shared by the
// two places that must enforce the same rules: the gateway's publish endpoint
// (creators gate + validation before anything is stored) and the cell's
// install endpoint (defense in depth — the manifest is re-fetched server-side
// from the market, or arrives in a compatibility-window body, and either way
// is re-validated before materializing).
//
// The v1 content boundary lives here: MCP entries are registry-name
// references only (no endpoints or commands — a pack can never introduce a
// server the operator has not registered), and agent entries are persona-only
// (no baseUrl/model/credentials — pack agents run as local personas on the
// subscriber's runtime).
//
// Boundary update (openspec: agent-service-config, ADR-0019): the SERVING
// contract may now declare a default model (`serving.model`) and a narrowing
// model whitelist (`serving.modelWhitelist`). These remain lane CONSTRAINTS —
// a declared default and a subset of names the deployer's own billing key
// must additionally authorize — never runtime configuration: no endpoints,
// no credentials, and the deployer's write-time lane check still gates every
// actual choice (the whitelist narrows, it can never widen).

// lib/rhythm.js owns the shape parsers (every/daily) so the validator and the
// runner's scheduler can never disagree about what a rhythm entry is.
import { parseEveryMinutes, parseDaily, RHYTHM_KEYS } from "./rhythm.js";
// lib/skill-files.js owns the skill-package file rules (add-packaged-skills
// D3) so the validator, the external-market parser, the upload endpoint and
// the CLI packager can never disagree about what a package may carry.
import { safePackagePath, isTextFilePath, isScriptFilePath, isSkillMdCollision } from "./skill-files.js";
// lib/generic-bot-types.js owns the generic bot type set (pack-bot-units):
// a pack's bots section may only reference these type names. A dependency-
// free constants file — this module is imported by the gateway process.
import { GENERIC_BOT_TYPE_NAMES } from "./generic-bot-types.js";
import { isDomainSlug, lineSlugs } from "./pack-taxonomy.js";

// Design D11 defaults; callers may override via env for ops/testing.
// Turn budget cap (add-serving-budgets D1): the platform's ceiling on a
// serving contract's declared per-turn duration.
export const BUDGET_MAX_MINUTES = 120;

export const PACK_LIMITS = {
  maxSkills: 10,
  maxSkillBodyChars: 64 * 1024,
  // Market-policy ceiling (enable-wire-content-fleet P3), not a structural
  // fact. The v1 marketplace default was 3; raised to 50 on 2026-10-30 so a
  // pack can carry a whole team self-contained — aligned with the fleet
  // template member roster cap (TEMPLATE_MEMBER_LIMIT). Operator-overridable
  // via PACK_MAX_AGENTS.
  maxAgents: 50,
  maxMcpRefs: 6,
  // Bot units (pack-bot-units): a pack may declare at most this many generic
  // bot entries — an ops-policy ceiling like skills/agents/MCP refs, not a
  // structural fact.
  maxBots: 3,
  maxTags: 10,
  maxTagChars: 24,
  maxNameChars: 80,
  maxDescriptionChars: 2000,
  // Version note (add-facet-version-history): optional human-readable note
  // riding the immutable manifest — each published version may carry one.
  maxNotesChars: 500,
  // Usage guide (add-pack-tutorials-and-wizard): exactly three authored steps,
  // the pack's own-language "prepare / ask / get".
  maxGuideStepTitleChars: 60,
  maxGuideStepBodyChars: 500,
  maxPersonaChars: 16 * 1024,
  // Serving contract (add-a2a-agent-serving D1): the contract declares WHAT is
  // exposed, never how the runtime is configured.
  maxCardNameChars: 100,
  maxCardDescriptionChars: 1000,
  maxCardSkills: 8,
  maxCapabilityDescriptionChars: 500,
  // Work rhythm (add-agent-residency D2): declarative cadence entries — the
  // autonomy grant. Same exposure-not-configuration boundary.
  maxRhythmEntries: 5,
  maxRhythmDoChars: 2000,
  // Turn budget (add-serving-budgets D1): the contract's optional per-turn
  // duration ceiling. A duration declaration, not runtime configuration.
  maxBudgetMinutes: BUDGET_MAX_MINUTES,
  // Model whitelist (agent-service-config / ADR-0019): the contract's
  // optional narrowing lane declaration — at most this many entries.
  maxModelWhitelist: 8,
  // Tool allowlist (add-mcp-tool-scoping D3): a pack may narrow one MCP
  // reference to at most this many tool leaf names.
  maxToolsPerMcp: 64,
  // Data workspace (facet-mcp-foundation-v1 3.1): the contract's optional
  // per-deployment data-volume request. A capacity declaration — the platform
  // ceiling keeps a runaway quota out of the manifests.
  maxWorkspaceQuotaMb: 512 * 1024,
  // Skill package shape (add-packaged-skills D2): a skill entry may carry an
  // inline auxiliary `files` map (relative path → text) and captured
  // `frontmatter`. Numbers deliberately equal 刀二's PACKAGE_LIMITS — one
  // boundary across every entry surface (validator, external line, zip
  // upload, CLI). Chars, not bytes, matching maxSkillBodyChars' convention.
  maxSkillFileChars: 512 * 1024, // one auxiliary file
  maxSkillAuxChars: 2 * 1024 * 1024, // all auxiliary files + frontmatter together
  maxSkillAuxFiles: 64,
  // Cluster metadata (agent-cluster-platform): optional cluster declaration
  // that groups pack agents into shareable agent clusters.
  maxClusterNameChars: 100,
  maxClusterDescriptionChars: 500,
  maxClusterMaxConcurrentRuns: 10,
  // Facade profile (add-principal-facade D2): a pack's optional delegation
  // list ceiling — the reception role may name at most this many specialists.
  maxFacadeDelegations: 8,
};

// The three POLICY ceilings an operator may retune without a code change
// (enable-wire-content-fleet D4): how many skills/agents/MCP servers a pack
// may carry is a market-policy call, not a structural fact. The char and byte
// caps stay fixed — those are abuse guards, not policy. Read per call, the
// same as PACK_FILES_ENABLED, so a running market picks up a change without a
// restart. A missing, non-integer or non-positive override falls back to the
// default (a typo must never silently disable the ceiling).
const LIMIT_ENV = {
  maxSkills: "PACK_MAX_SKILLS",
  maxAgents: "PACK_MAX_AGENTS",
  maxMcpRefs: "PACK_MAX_MCP_REFS",
  maxBots: "PACK_MAX_BOTS",
};

export function packLimits(env = process.env) {
  const out = { ...PACK_LIMITS };
  for (const [key, name] of Object.entries(LIMIT_ENV)) {
    const n = Number(env?.[name]);
    if (Number.isInteger(n) && n > 0) out[key] = n;
  }
  return out;
}

// Validate a single turn-budget value in minutes (add-serving-budgets D1).
// The deploy override carries the number directly; the contract wraps it in
// `budget.turnMinutes` — both enforce the identical rule (whole minutes,
// positive, within the platform cap). Returns the error string or null.
export function budgetMinutesError(minutes, limits = PACK_LIMITS) {
  if (!Number.isInteger(minutes) || minutes <= 0 || minutes > limits.maxBudgetMinutes) {
    return `turnMinutes must be a positive whole number of minutes at most ${limits.maxBudgetMinutes}`;
  }
  return null;
}

// Validate a single data-workspace quota in MB (facet-mcp-foundation-v1 3.1).
// Whole MB, positive, within the platform cap — the same rule shape as
// budgetMinutesError, one definition, both enforcement points. Returns the
// error string or null.
export function workspaceQuotaMbError(quotaMb, limits = PACK_LIMITS) {
  if (!Number.isInteger(quotaMb) || quotaMb <= 0 || quotaMb > limits.maxWorkspaceQuotaMb) {
    return `quotaMb must be a positive whole number of MB at most ${limits.maxWorkspaceQuotaMb}`;
  }
  return null;
}

// Validate a contract's data-workspace object (facet-mcp-foundation-v1 3.1):
// exactly `{ enabled, quotaMb? }` — a declarative volume request under the
// same discipline as budget, so runtime configuration cannot be smuggled
// alongside. Returns [{ error, entry? }].
export function validateWorkspace(workspace, limits = PACK_LIMITS) {
  const errors = [];
  if (!workspace || typeof workspace !== "object" || Array.isArray(workspace)) {
    fail(errors, "workspace must be an object of { enabled, quotaMb? }", "workspace");
    return errors;
  }
  for (const key of Object.keys(workspace)) {
    if (!WORKSPACE_KEYS.includes(key)) {
      fail(errors, `workspace has unknown key '${key}' (only ${WORKSPACE_KEYS.join(", ")})`, "workspace");
    }
  }
  if (typeof workspace.enabled !== "boolean") {
    fail(errors, "workspace.enabled must be a boolean", "workspace.enabled");
  }
  if (workspace.quotaMb !== undefined) {
    const err = workspaceQuotaMbError(workspace.quotaMb, limits);
    if (err) fail(errors, `workspace.${err}`, "workspace.quotaMb");
  }
  return errors;
}

// Validate a contract's budget object (add-serving-budgets D1): exactly
// `{ turnMinutes }` — a duration declaration under the same discipline as
// rhythm, so runtime configuration cannot be smuggled alongside. Returns
// [{ error, entry? }].
export function validateBudget(budget, limits = PACK_LIMITS) {
  const errors = [];
  if (!budget || typeof budget !== "object" || Array.isArray(budget)) {
    fail(errors, "budget must be an object of { turnMinutes }", "budget");
    return errors;
  }
  for (const key of Object.keys(budget)) {
    if (!BUDGET_KEYS.includes(key)) {
      fail(errors, `budget has unknown key '${key}' (only ${BUDGET_KEYS.join(", ")})`, "budget");
    }
  }
  const err = budgetMinutesError(budget.turnMinutes, limits);
  if (err) fail(errors, `budget.${err}`, "budget.turnMinutes");
  return errors;
}

const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

// Tool leaf names (add-mcp-tool-scoping D3): the raw tool name as the server's
// tools/list reports it — MCP tolerates dots, the DeepSeek function-name
// contract permits [A-Za-z0-9_-], so leaf names carry both here and the
// mcp__<server>__<leaf> public name keeps its own encoding downstream.
export const TOOL_LEAF_NAME_RE = /^[A-Za-z0-9._-]{1,128}$/;

// Cluster metadata keys (agent-cluster-platform)
const CLUSTER_KEYS = ["name", "description", "defaultAgents", "optionalAgents", "schedulingPolicy"];
const SCHEDULING_POLICY_KEYS = ["maxConcurrentRuns", "preferredRunner"];

// Facade profile (add-principal-facade): a pack carrying a `facade` block is
// a principal facade — the conversational front door of the person or
// organization behind it. The block names the reception role (a serving
// agent of THIS pack), the corpus skills feeding it, an optional delegation
// list (in-pack roles or existing a2a target refs), and a billing stance.
// References stay inside the pack; identity claims never ride the manifest —
// the platform's author stamp is the only trusted attribution.
const FACADE_KEYS = ["reception", "corpus", "delegation", "stance"];
const FACADE_DELEGATION_KEYS = ["kind", "ref"];
const FACADE_DELEGATION_KINDS = ["in-pack", "a2a"];
// An a2a delegation ref is a market target reference in any of the shapes
// the delegation face resolves (slug or registry path) — resolution and the
// unknown-target refusal happen at the bridge, shape is all we pin here.
const FACADE_A2A_REF_RE = /^[A-Za-z0-9._:/-]{1,128}$/;

// Adopted provenance (add-official-adopted-agents D1): an optional top-level
// block recording that this pack's content was adopted from an upstream
// third-party skill and republished by the platform. It is a SOURCE axis,
// deliberately orthogonal to both the structure-derived type badge
// (lib/pack-badge.js) and the roster-derived `official` flag
// (gateway/packs.js): carrying this block grants NO official status — the
// roster still decides that. Fields are the audit trail the curation review
// and the detail page rely on; `revision` pins the upstream commit the
// snapshot was taken from (D2), so the asset never depends on the shelf.
const PROVENANCE_KEYS = [
  "kind",
  "upstreamUrl",
  "upstreamName",
  "license",
  "revision",
  "adoptedBy",
  "reviewedBy",
  "reviewedAt",
  // Lineage (add-agent-fork-lineage D1): a fork stamps WHERE it came from as
  // an optional provenance key. `kind` semantics are untouched — a fork is
  // community material derived from its parent (official status stays a
  // roster judgment, and forking never confers it).
  "forkOf",
];
const PROVENANCE_KINDS = ["official-adopted"];
// License id shape only — the ADMISSION decision lives in lib/license-gate.js,
// which reads upstream evidence rather than the shelf's mirrored (always-
// unknown) license state.
const PROVENANCE_LICENSE_RE = /^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/;
// 40-hex sha or a ref-ish short form; upstream not-found is fail-closed, so a
// garbage revision must not pass as "pinned".
const PROVENANCE_REVISION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{6,63}$/;
const PROVENANCE_URL_RE = /^https?:\/\/[^\s]{1,500}$/;

// Locale overlay (add-pack-locale-tracks D1): the optional top-level `i18n`
// block carries secondary-language overrides of display fields. Base fields
// stay zh main-track strings — the overlay may never redefine them, so `zh`
// locale keys are rejected outright. Locale keys follow the BCP-47 lower-case
// primary-subtag shape.
const LOCALE_KEY_RE = /^[a-z]{2,3}(-[a-zA-Z0-9]{2,8})*$/;
// Absolute-replacement claims (add-pack-locale-tracks D4): the SAME rule the
// marketing audit applies to collateral — kept in lockstep with
// ABSOLUTE_CLAIM_RE in finddata docs/marketing/audit.py:131. Applied to the
// en secondary track here (zh collateral has its own audit lane; zh base
// manifest fields stay unscanned this version).
const ABSOLUTE_CLAIM_RE =
  /(?:接管|替代|取代)(?:所有|全部|一切)(?:人类)?(?:的)?工作|全面(?:接管|替代|取代)|replac\w+\s+all\s+(?:human\s+)?work|tak\w+\s+over\s+all\s+(?:human\s+)?work/i;
// Length parity (D4): long-form fields (description, guide step bodies) must
// stay within this factor of their zh base in either direction — a tripwire
// for pasted-wrong-locale content, never for legitimate translation. Below
// the floor on both sides a ratio carries no signal (a 3-char zh label may
// legitimately translate to 12 chars), so parity is skipped there.
const LOCALE_LENGTH_RATIO = 3;
const LOCALE_LENGTH_FLOOR = 20;

// Keys a pack MCP entry must NOT carry — anything endpoint- or command-shaped
// would break the v1 security boundary.
const MCP_FORBIDDEN_KEYS = ["url", "command", "args", "env", "headers", "config", "configTemplate"];

// Keys a pack agent entry must NOT carry — pack agents are local personas,
// never a forwarded endpoint.
const AGENT_FORBIDDEN_KEYS = ["baseUrl", "model", "apiKey", "apiKeyEnv", "local", "url"];

// Bot units (pack-bot-units): the exact keys a bots entry may carry, and the
// keys it must NOT. A pack bot is a generic-type reference plus an optional
// single mounted skill — channel credentials, endpoints, tokens and anything
// executable-shaped belong to the cell operator, never to the pack (the same
// no-credentials philosophy as MCP references and persona-only agents).
const BOT_KEYS = ["id", "name", "generic", "description", "skill"];
const BOT_FORBIDDEN_KEYS = [
  "url",
  "baseUrl",
  "endpoint",
  "token",
  "secret",
  "apiKey",
  "apiKeyEnv",
  "credentials",
  "auth",
  "command",
  "args",
  "env",
];

// Keys the serving contract (and its card) must NOT carry — model, endpoints,
// and credentials are deployment concerns that stay out of the pack (the same
// v1 boundary, extended to the deployable surface).
// Boundary update (ADR-0019): `model` is legal AT THE CONTRACT LEVEL (a
// declared default + narrowing whitelist, see validateModelSelection) but
// stays forbidden everywhere nested (rhythm entries, card) — those remain
// pure exposure/cadence declarations.
const SERVING_FORBIDDEN_KEYS = ["url", "baseUrl", "endpoint", "model", "apiKey", "apiKeyEnv", "token", "credentials", "auth"];
const SERVING_CONTRACT_FORBIDDEN_KEYS = SERVING_FORBIDDEN_KEYS.filter((k) => k !== "model");
// `harness` (add-harness-adapter D5): the role's harness NAME — the runner's
// allowlist resolves it to a command, so the pack never carries an executable
// (same safety shape as `model`: a selection, not runtime configuration).
const SERVING_KEYS = ["protocol", "card", "rhythm", "budget", "workspace", "model", "modelWhitelist", "harness", "toolFace"];
// Tool-face tiers (add-serving-tool-face): a serving contract's DECLARED
// built-in tool surface. "chat" strips the filesystem/command/web/subagent
// rows at materialization — the reception shape (corpus + matter + ask only).
// Absent = the full face, byte-identical to the pre-key behavior.
const SERVING_TOOL_FACES = ["chat"];
const WORKSPACE_KEYS = ["enabled", "quotaMb"];
const CARD_KEYS = ["name", "description", "capabilities", "skills", "examples"];
const CARD_SKILL_KEYS = ["id", "name", "description", "tags"];
const BUDGET_KEYS = ["turnMinutes"];

// Model identifiers (ADR-0019): roster names like "deepseek-v4-flash" and
// provider-prefixed forms ("vendor/model") — no leading/trailing separator,
// no whitespace, at most 128 chars. Shared with the config write route
// (gateway/packs.js) so publish and reconfigure enforce one shape.
export const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export function modelIdError(model) {
  if (typeof model !== "string" || !MODEL_ID_RE.test(model)) {
    return "model must be a model identifier (letters/digits/._:/-, 1-128 chars, no whitespace)";
  }
  return null;
}

// add-agent-builder-workspace 5.1: every finding carries a stable `code`
// (additive; the `error`原文 is untouched and stays the only display truth for
// unknown codes). Explicit codes win at the call sites users actually hit in
// the workspace; everything else derives deterministically from the first four
// alphanumeric words of the message — a baseline identifier, not a summary key.
// Consumers MUST treat unknown codes as "no summary available", never guess.
export function deriveCode(error) {
  const words = String(error).toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return words.slice(0, 4).join("_") || "validation_error";
}

function fail(errors, error, entry, code) {
  errors.push({ error, ...(entry ? { entry } : {}), code: code ?? deriveCode(error) });
}

// Effective per-server tool allowlists for one role (add-mcp-tool-scoping D6).
// For each MCP reference the role KEEPS (its resources.mcpServers declaration
// when present, else the whole pack list): the role's resources.mcpTools list
// when declared — intersected with the pack-level allowTools, since a role may
// only narrow — else the pack-level allowTools. References without any
// effective allowlist are absent from the map = full tool surface. One
// definition shared by the cell's deriveScope and the serving descriptor's
// compose, so the two composition targets can never disagree.
export function effectiveMcpTools(manifest, agent) {
  const result = {};
  const entries = new Map(
    (manifest?.mcpServers ?? [])
      .filter((m) => m && typeof m.registryName === "string")
      .map((m) => [m.registryName, m]),
  );
  const declaredMcp = agent?.resources?.mcpServers;
  const keep = Array.isArray(declaredMcp) ? new Set(declaredMcp) : null;
  const roleTools = agent?.resources?.mcpTools;
  for (const [name, entry] of entries) {
    if (keep && !keep.has(name)) continue;
    const packList = Array.isArray(entry.allowTools) ? entry.allowTools : null;
    const roleList = roleTools && Array.isArray(roleTools[name]) ? roleTools[name] : null;
    const effective = roleList !== null
      ? (packList !== null ? roleList.filter((t) => packList.includes(t)) : roleList)
      : packList;
    if (effective !== null) result[name] = [...new Set(effective)];
  }
  return result;
}

// Validate a rhythm entries array (add-agent-residency D2). Shared by the
// manifest's serving validation and the deploy endpoint's rhythm override —
// one shape definition, two enforcement points. Returns [{ error, entry? }].
export function validateRhythm(rhythm, limits = PACK_LIMITS) {
  const errors = [];
  if (rhythm === undefined) return errors;
  if (!Array.isArray(rhythm) || rhythm.length === 0 || rhythm.length > limits.maxRhythmEntries) {
    fail(errors, `rhythm must be a non-empty array of at most ${limits.maxRhythmEntries} entries`);
    return errors;
  }
  rhythm.forEach((r, j) => {
    const e = `rhythm[${j}]`;
    if (!r || typeof r !== "object" || Array.isArray(r)) {
      fail(errors, "rhythm entry must be an object of { every | daily, do? }", e);
      return;
    }
    const forbidden = SERVING_FORBIDDEN_KEYS.filter((k) => r[k] !== undefined);
    if (forbidden.length > 0) {
      fail(errors, `rhythm declares cadence, not runtime configuration (found forbidden key(s): ${forbidden.join(", ")})`, e);
    }
    for (const key of Object.keys(r)) {
      if (!RHYTHM_KEYS.includes(key)) {
        fail(errors, `rhythm entry has unknown key '${key}' (only ${RHYTHM_KEYS.join(", ")})`, e);
      }
    }
    const hasEvery = r.every !== undefined;
    const hasDaily = r.daily !== undefined;
    if (hasEvery === hasDaily) {
      fail(errors, `a rhythm entry carries exactly one of every (e.g. "90m", "2h") or daily ("HH:MM")`, e);
    } else if (hasEvery && parseEveryMinutes(r.every) === null) {
      fail(errors, `every must be Nm or Nh with a minimum of 5 minutes`, e);
    } else if (hasDaily && parseDaily(r.daily) === null) {
      fail(errors, `daily must be a 24h "HH:MM" wall-clock time`, e);
    }
    if (r.do !== undefined && (typeof r.do !== "string" || !r.do.trim() || r.do.length > limits.maxRhythmDoChars)) {
      fail(errors, `do must be a non-empty string of at most ${limits.maxRhythmDoChars} characters`, e);
    }
  });
  return errors;
}

// Validate a skill entry's package shape (add-packaged-skills D1/D2/D3):
// optional inline `files` map (relative path → text) and optional captured
// `frontmatter` object. Absent fields = the legacy single-document skill,
// byte-identical behavior. Returns [{ error, entry }] where entry points at
// `skills[i]` (and deeper for a specific file).
export function validateSkillFiles(skill, index, limits = PACK_LIMITS) {
  const errors = [];
  const entry = `skills[${index}]`;
  if (!skill || typeof skill !== "object") return errors;
  // Auxiliary aggregate: every auxiliary file plus the frontmatter's own bulk
  // (D2 — frontmatter counts toward the per-skill total).
  let auxChars = 0;
  if (skill.frontmatter !== undefined) {
    if (!skill.frontmatter || typeof skill.frontmatter !== "object" || Array.isArray(skill.frontmatter)) {
      fail(errors, "skill frontmatter must be an object of YAML mapping fields", `${entry}.frontmatter`);
    } else {
      auxChars += JSON.stringify(skill.frontmatter).length;
    }
  }
  if (skill.files === undefined) return errors;
  if (!skill.files || typeof skill.files !== "object" || Array.isArray(skill.files)) {
    fail(errors, "skill files must be an object mapping relative paths to text content", `${entry}.files`);
    return errors;
  }
  const keys = Object.keys(skill.files);
  if (keys.length > limits.maxSkillAuxFiles) {
    fail(errors, `skill files must contain at most ${limits.maxSkillAuxFiles} entries (found ${keys.length})`, entry);
  }
  // Case-folded collision guard: the tree materializes onto the filesystem,
  // where a case-insensitive volume would silently clobber `refs/A.md` with
  // `refs/a.md` — reject instead of losing a file.
  const seenFolded = new Set();
  for (const rawPath of keys) {
    const fentry = `${entry}.files['${rawPath}']`;
    const text = skill.files[rawPath];
    if (typeof text !== "string") {
      fail(errors, "file content must be text (a string)", fentry);
      continue;
    }
    const safe = safePackagePath(rawPath);
    if (!safe) {
      fail(errors, "file path must be relative and safe (no absolute paths, '..', backslashes, drive letters, or NUL)", fentry);
      continue;
    }
    if (isSkillMdCollision(safe)) {
      fail(errors, "files may not include a SKILL.md (any casing) — the rendered SKILL.md is generated from the entry's content and would be clobbered", fentry);
      continue;
    }
    if (!isTextFilePath(safe, text.slice(0, 64))) {
      fail(errors, "file is not a text type the platform stores (text/markdown/code extensions only)", fentry);
      continue;
    }
    const folded = safe.toLowerCase();
    if (seenFolded.has(folded)) {
      fail(errors, `file path '${safe}' collides (case-insensitively) with another file in this skill`, fentry);
      continue;
    }
    seenFolded.add(folded);
    if (text.length > limits.maxSkillFileChars) {
      fail(errors, `file '${safe}' exceeds the per-file limit of ${limits.maxSkillFileChars} characters`, fentry);
      continue;
    }
    auxChars += text.length;
  }
  if (auxChars > limits.maxSkillAuxChars) {
    fail(errors, `skill '${skill.name ?? index}' auxiliary content (files + frontmatter) exceeds ${limits.maxSkillAuxChars} characters in total`, entry);
  }
  return errors;
}

// Script files carried by a skill entry — the executable-when-run subset that
// drives the install-time confirm gate and the report's disclosure (one
// definition, both consumers; the facet and cell sides both import this).
export function skillScriptFiles(skill) {
  if (!skill?.files || typeof skill.files !== "object") return [];
  return Object.keys(skill.files).filter((p) => isScriptFilePath(p)).sort();
}

// ── Locale overlay validation (add-pack-locale-tracks D1/D4) ────────────────
// The optional top-level `i18n` block carries secondary-language overrides of
// display fields. The base string fields stay the zh MAIN track — the overlay
// never redefines them, only covers them, and only when the manifest declares
// the field in its base form (an override with no zh base would strand zh
// readers, breaking the main-track guarantee). Fields are addressed the way
// they are declared: array members by index (guide.steps[i]), named entities
// by their own name/id (skills[name], mcpServers[registryName], agents[id],
// bots[id], card.skills[id]).
const LOCALE_OVERLAY_KEYS = ["name", "description", "notes", "guide", "skills", "mcpServers", "agents", "bots", "cluster", "promise", "audience", "outcomes", "examples", "domain", "tags", "identity"];
const SKILL_DESC_CHARS = 300; // mirrors the base skills[].description cap
const MCP_DESC_CHARS = 300; // mirrors the base mcpServers[].description cap (add-mcp-annotation-overlay)
const AGENT_NAME_CHARS = 60; // mirrors the base agents[].name cap

function plainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

// A single non-empty-string override bound by the cap of the base field it
// covers. Returns false (and records the error) when the value is malformed.
//
// Length is measured in display-width units (CJK/fullwidth chars count 2,
// everything else 1) and the cap doubles to match: the base caps were
// calibrated against the CJK main track, where one char carries roughly twice
// the rendered width of a Latin char. Width-for-width, a CJK overlay track
// keeps exactly the budget it had under raw char counts, while en/es/fr
// translations of the same content get equivalent visual room instead of
// failing at half their natural expansion.
const OVERLAY_CAP_WIDTHS = 2;
const CJK_WIDTH_RE = /[\u1100-\u115F\u2E80-\uA4CF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6\u3000-\u303F\u3040-\u30FF\u3190-\u319F\u31F0-\u31FF\u3400-\u4DBF\u4E00-\u9FFF]/;

function displayWidth(value) {
  let width = 0;
  for (const ch of value) width += CJK_WIDTH_RE.test(ch) ? 2 : 1;
  return width;
}

function checkStringOverride(value, cap, entry, errors) {
  if (typeof value !== "string" || !value.trim() || displayWidth(value) > cap * OVERLAY_CAP_WIDTHS) {
    fail(errors, `must be a non-empty string within ${cap} CJK-equivalent display widths`, entry);
    return false;
  }
  return true;
}

// Names win/lose comparably: the overlay must not drift far from its zh base.
// Skipped below the floor — short strings legitimately diverge in ratio.
// Compared in display widths so the bound is visual size parity, not raw
// char parity: a faithful CJK→Latin translation runs 2.5–3.5x in chars while
// rendering at roughly the same physical size (and vice versa for Latin→CJK).
function ratioBroken(localeValue, zhBase) {
  const valueWidth = displayWidth(localeValue);
  const baseWidth = displayWidth(zhBase);
  if (localeValue.length < LOCALE_LENGTH_FLOOR || zhBase.length < LOCALE_LENGTH_FLOOR) return false;
  return (
    valueWidth > baseWidth * LOCALE_LENGTH_RATIO ||
    baseWidth > valueWidth * LOCALE_LENGTH_RATIO
  );
}

function validateLocaleOverlay(manifest, errors, limits) {
  const overlay = manifest.i18n;
  if (!plainObject(overlay)) {
    fail(errors, "i18n must be an object mapping locale tags to display-field overrides", "i18n");
    return;
  }
  const locales = Object.keys(overlay);
  if (locales.length === 0) {
    fail(errors, "i18n must carry at least one locale block (omit the key instead of an empty object)", "i18n");
    return;
  }

  const skillByName = new Map(
    (Array.isArray(manifest.skills) ? manifest.skills : [])
      .filter((s) => s && typeof s.name === "string")
      .map((s) => [s.name, s]),
  );
  const mcpServerByName = new Map(
    (Array.isArray(manifest.mcpServers) ? manifest.mcpServers : [])
      .filter((m) => m && typeof m.registryName === "string")
      .map((m) => [m.registryName, m]),
  );
  const agentById = new Map(
    (Array.isArray(manifest.agents) ? manifest.agents : [])
      .filter((a) => a && typeof a.id === "string")
      .map((a) => [a.id, a]),
  );
  const botById = new Map(
    (Array.isArray(manifest.bots) ? manifest.bots : [])
      .filter((b) => b && typeof b.id === "string")
      .map((b) => [b.id, b]),
  );

  for (const locale of locales) {
    const lentry = `i18n.${locale}`;
    if (!LOCALE_KEY_RE.test(locale)) {
      fail(errors, `i18n locale '${locale}' must be a lower-case BCP-47 tag ([a-z]{2,3} plus optional -suffixes)`, "i18n");
      continue;
    }
    if (locale === "zh" || locale.startsWith("zh-")) {
      fail(errors, `i18n may not declare '${locale}' — Chinese is the main track and lives in the base string fields`, "i18n");
      continue;
    }
    const block = overlay[locale];
    if (!plainObject(block)) {
      fail(errors, "must be an object of display-field overrides", lentry);
      continue;
    }
    for (const key of Object.keys(block)) {
      if (!LOCALE_OVERLAY_KEYS.includes(key)) {
        fail(errors, `has unknown key '${key}' (only ${LOCALE_OVERLAY_KEYS.join(", ")})`, lentry);
      }
    }
    const enTrack = locale === "en" || locale.startsWith("en-");
    const scanned = []; // [entry, value] — en-track strings for the claim scan
    const ratios = []; // [entry, localeValue, zhBase] — long-form parity pairs

    // Scalar display fields — each bound to the base field's own cap.
    for (const [key, cap] of [
      ["name", limits.maxNameChars],
      ["description", limits.maxDescriptionChars],
      ["notes", limits.maxNotesChars],
    ]) {
      if (block[key] === undefined) continue;
      const entry = `${lentry}.${key}`;
      const base = manifest[key];
      if (typeof base !== "string" || !base.trim()) {
        fail(errors, `overrides '${key}', which the manifest does not declare in its zh main track`, entry);
        continue;
      }
      if (!checkStringOverride(block[key], cap, entry, errors)) continue;
      scanned.push([entry, block[key]]);
      if (key === "description") ratios.push([entry, block[key], base]);
    }

    // Usage guide — the whole three-step group or nothing (a half-translated
    // guide would fall back per-step and read as two languages in one card).
    if (block.guide !== undefined) {
      const gentry = `${lentry}.guide`;
      const baseSteps = plainObject(manifest.guide) && Array.isArray(manifest.guide.steps) ? manifest.guide.steps : null;
      if (!baseSteps || baseSteps.length !== 3) {
        fail(errors, "overrides guide, which the manifest does not declare in its zh main track (three steps)", gentry);
      } else if (!plainObject(block.guide)) {
        fail(errors, "must be an object of { steps }", gentry);
      } else {
        for (const key of Object.keys(block.guide)) {
          if (key !== "steps") fail(errors, `guide has unknown key '${key}' (only steps)`, gentry);
        }
        const steps = block.guide.steps;
        if (!Array.isArray(steps) || steps.length !== 3) {
          fail(errors, "guide.steps must be exactly 3 steps when overridden (translate the whole guide or omit it)", `${gentry}.steps`);
        } else {
          steps.forEach((st, i) => {
            const sentry = `${gentry}.steps[${i}]`;
            if (!plainObject(st)) {
              fail(errors, "guide step must be an object of { title, body }", sentry);
              return;
            }
            for (const key of Object.keys(st)) {
              if (key !== "title" && key !== "body") fail(errors, `guide step has unknown key '${key}' (only title, body)`, sentry);
            }
            if (checkStringOverride(st.title, limits.maxGuideStepTitleChars, `${sentry}.title`, errors)) {
              scanned.push([`${sentry}.title`, st.title]);
            }
            if (checkStringOverride(st.body, limits.maxGuideStepBodyChars, `${sentry}.body`, errors)) {
              scanned.push([`${sentry}.body`, st.body]);
              ratios.push([`${sentry}.body`, st.body, baseSteps[i].body]);
            }
          });
        }
      }
    }

    // Skill descriptions, named entities keyed by declared skill name.
    if (block.skills !== undefined) {
      if (!plainObject(block.skills)) {
        fail(errors, "must be an object mapping declared skill names to { description }", `${lentry}.skills`);
      } else {
        for (const [name, ov] of Object.entries(block.skills)) {
          const entry = `${lentry}.skills['${name}']`;
          const skill = skillByName.get(name);
          if (!skill) {
            fail(errors, `references '${name}', which the manifest does not declare in skills`, entry);
            continue;
          }
          if (!plainObject(ov)) {
            fail(errors, "must be an object of { description, name? }", entry);
            continue;
          }
          const hasTitle = typeof skill.title === "string" && !!skill.title.trim();
          for (const key of Object.keys(ov)) {
            if (key !== "description" && key !== "name") {
              fail(errors, `has unknown key '${key}' (only description and, for skills declaring a title, name)`, entry);
            } else if (key === "name" && !hasTitle) {
              fail(errors, "overrides 'name' but the skill entry declares no base title (add skills[].title first)", entry);
            }
          }
          if (ov.description !== undefined && checkStringOverride(ov.description, SKILL_DESC_CHARS, `${entry}.description`, errors)) {
            scanned.push([`${entry}.description`, ov.description]);
          }
          if (ov.name !== undefined && checkStringOverride(ov.name, 60, `${entry}.name`, errors)) {
            scanned.push([`${entry}.name`, ov.name]);
          }
        }
      }
    }

    // MCP server display descriptions (add-mcp-annotation-overlay), named
    // entities keyed by the declared registryName. Display only — the runtime
    // contract (registryName, tool-face declaration) is never overlayable.
    if (block.mcpServers !== undefined) {
      if (!plainObject(block.mcpServers)) {
        fail(errors, "must be an object mapping declared registryNames to { description }", `${lentry}.mcpServers`);
      } else {
        for (const [name, ov] of Object.entries(block.mcpServers)) {
          const entry = `${lentry}.mcpServers['${name}']`;
          const server = mcpServerByName.get(name);
          if (!server) {
            fail(errors, `references '${name}', which the manifest does not declare in mcpServers`, entry);
            continue;
          }
          if (!plainObject(ov)) {
            fail(errors, "must be an object of { description }", entry);
            continue;
          }
          for (const key of Object.keys(ov)) {
            if (key !== "description") fail(errors, `has unknown key '${key}' (only description)`, entry);
          }
          if (ov.description !== undefined && checkStringOverride(ov.description, MCP_DESC_CHARS, `${entry}.description`, errors)) {
            scanned.push([`${entry}.description`, ov.description]);
          }
        }
      }
    }

    // Agent display names + their A2A card text, keyed by declared agent id.
    if (block.agents !== undefined) {
      if (!plainObject(block.agents)) {
        fail(errors, "must be an object mapping declared agent ids to overrides", `${lentry}.agents`);
      } else {
        for (const [id, ov] of Object.entries(block.agents)) {
          const entry = `${lentry}.agents['${id}']`;
          const agent = agentById.get(id);
          if (!agent) {
            fail(errors, `references '${id}', which the manifest does not declare in agents`, entry);
            continue;
          }
          if (!plainObject(ov)) {
            fail(errors, "must be an object of { name, serving }", entry);
            continue;
          }
          for (const key of Object.keys(ov)) {
            if (key !== "name" && key !== "serving") fail(errors, `has unknown key '${key}' (only name, serving)`, entry);
          }
          if (ov.name !== undefined && checkStringOverride(ov.name, AGENT_NAME_CHARS, `${entry}.name`, errors)) {
            scanned.push([`${entry}.name`, ov.name]);
          }
          if (ov.serving !== undefined) {
            const baseCard = plainObject(agent.serving) && plainObject(agent.serving.card) ? agent.serving.card : null;
            const sentry = `${entry}.serving`;
            if (!plainObject(ov.serving)) {
              fail(errors, "must be an object of { card }", sentry);
            } else {
              for (const key of Object.keys(ov.serving)) {
                if (key !== "card") fail(errors, `serving has unknown key '${key}' (only card)`, sentry);
              }
              if (ov.serving.card !== undefined) {
                const centry = `${sentry}.card`;
                if (!baseCard) {
                  fail(errors, "overrides serving.card, which the manifest does not declare in its zh main track", centry);
                } else if (!plainObject(ov.serving.card)) {
                  fail(errors, "must be an object of { name, description, skills }", centry);
                } else {
                  for (const ckey of Object.keys(ov.serving.card)) {
                    if (ckey !== "name" && ckey !== "description" && ckey !== "skills") {
                      fail(errors, `card has unknown key '${ckey}' (only name, description, skills)`, centry);
                    }
                  }
                  if (ov.serving.card.name !== undefined && checkStringOverride(ov.serving.card.name, limits.maxCardNameChars, `${centry}.name`, errors)) {
                    scanned.push([`${centry}.name`, ov.serving.card.name]);
                  }
                  if (ov.serving.card.description !== undefined && checkStringOverride(ov.serving.card.description, limits.maxCardDescriptionChars, `${centry}.description`, errors)) {
                    scanned.push([`${centry}.description`, ov.serving.card.description]);
                  }
                  if (ov.serving.card.skills !== undefined) {
                    const baseCardSkills = new Map(
                      (Array.isArray(baseCard.skills) ? baseCard.skills : [])
                        .filter((cs) => cs && typeof cs.id === "string")
                        .map((cs) => [cs.id, cs]),
                    );
                    if (!plainObject(ov.serving.card.skills)) {
                      fail(errors, "must be an object mapping declared capability ids to { name, description }", `${centry}.skills`);
                    } else {
                      for (const [cid, csov] of Object.entries(ov.serving.card.skills)) {
                        const csentry = `${centry}.skills['${cid}']`;
                        if (!baseCardSkills.has(cid)) {
                          fail(errors, `references '${cid}', which the manifest does not declare in serving.card.skills`, csentry);
                          continue;
                        }
                        if (!plainObject(csov)) {
                          fail(errors, "must be an object of { name, description }", csentry);
                          continue;
                        }
                        for (const ckey of Object.keys(csov)) {
                          if (ckey !== "name" && ckey !== "description") fail(errors, `has unknown key '${ckey}' (only name, description)`, csentry);
                        }
                        if (csov.name !== undefined && checkStringOverride(csov.name, limits.maxCardNameChars, `${csentry}.name`, errors)) {
                          scanned.push([`${csentry}.name`, csov.name]);
                        }
                        if (csov.description !== undefined && checkStringOverride(csov.description, limits.maxCapabilityDescriptionChars, `${csentry}.description`, errors)) {
                          scanned.push([`${csentry}.description`, csov.description]);
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    // Bot display text, keyed by declared bot id.
    if (block.bots !== undefined) {
      if (!plainObject(block.bots)) {
        fail(errors, "must be an object mapping declared bot ids to { name, description }", `${lentry}.bots`);
      } else {
        for (const [id, ov] of Object.entries(block.bots)) {
          const entry = `${lentry}.bots['${id}']`;
          if (!botById.has(id)) {
            fail(errors, `references '${id}', which the manifest does not declare in bots`, entry);
            continue;
          }
          if (!plainObject(ov)) {
            fail(errors, "must be an object of { name, description }", entry);
            continue;
          }
          for (const key of Object.keys(ov)) {
            if (key !== "name" && key !== "description") fail(errors, `has unknown key '${key}' (only name, description)`, entry);
          }
          if (ov.name !== undefined && checkStringOverride(ov.name, AGENT_NAME_CHARS, `${entry}.name`, errors)) {
            scanned.push([`${entry}.name`, ov.name]);
          }
          if (ov.description !== undefined && checkStringOverride(ov.description, SKILL_DESC_CHARS, `${entry}.description`, errors)) {
            scanned.push([`${entry}.description`, ov.description]);
          }
        }
      }
    }

    // Cluster template display text — only when the pack declares a cluster.
    if (block.cluster !== undefined) {
      const centry = `${lentry}.cluster`;
      if (!plainObject(manifest.cluster)) {
        fail(errors, "overrides cluster, which the manifest does not declare in its zh main track", centry);
      } else if (!plainObject(block.cluster)) {
        fail(errors, "must be an object of { name, description }", centry);
      } else {
        for (const key of Object.keys(block.cluster)) {
          if (key !== "name" && key !== "description") fail(errors, `has unknown key '${key}' (only name, description)`, centry);
        }
        if (block.cluster.name !== undefined && checkStringOverride(block.cluster.name, limits.maxClusterNameChars, `${centry}.name`, errors)) {
          scanned.push([`${centry}.name`, block.cluster.name]);
        }
        if (block.cluster.description !== undefined && checkStringOverride(block.cluster.description, limits.maxClusterDescriptionChars, `${centry}.description`, errors)) {
          scanned.push([`${centry}.description`, block.cluster.description]);
        }
      }
    }

    // ── Display format v2 overlays (overhaul-market-catalog-presentation 4.2) ─
    // promise — scalar display copy bound to the card slot's own width cap
    // (60 display-width units — the same unit the renderer clips in, so a
    // passing override never truncates).
    if (block.promise !== undefined) {
      const entry = `${lentry}.promise`;
      if (typeof manifest.promise !== "string" || !manifest.promise.trim()) {
        fail(errors, "overrides promise, which the manifest does not declare in its zh main track", entry);
      } else if (typeof block.promise !== "string" || !block.promise.trim() || displayWidth(block.promise) > DISPLAY_PROMISE_MAX_WIDTH) {
        fail(errors, `promise must be a non-empty string within ${DISPLAY_PROMISE_MAX_WIDTH} display-width units (CJK counts 2)`, entry);
      } else {
        scanned.push([entry, block.promise]);
        ratios.push([entry, block.promise, manifest.promise]);
      }
    }

    // tags — free-form display labels: same length, aligned by index; each
    // label obeys the base field's own cap.
    if (block.tags !== undefined) {
      const entry = `${lentry}.tags`;
      const baseTags = Array.isArray(manifest.tags) ? manifest.tags : null;
      if (!baseTags || baseTags.length === 0) {
        fail(errors, "overrides tags, which the manifest does not declare in its zh main track", entry);
      } else if (!Array.isArray(block.tags)) {
        fail(errors, "tags override must be an array aligned by index with the zh base", entry);
      } else if (block.tags.length !== baseTags.length) {
        fail(errors, `tags override has ${block.tags.length} entries but the zh base declares ${baseTags.length} — translate every tag or none`, entry);
      } else {
        block.tags.forEach((t, i) => {
          const tentry = `${entry}[${i}]`;
          if (typeof t !== "string" || !t.trim() || displayWidth(t) > limits.maxTagChars * OVERLAY_CAP_WIDTHS) {
            fail(errors, `tag must be a non-empty string within ${limits.maxTagChars} CJK-equivalent display widths`, tentry);
          } else {
            scanned.push([tentry, t]);
          }
        });
      }
    }

    // audience / domain — controlled-vocabulary slugs: per-locale display
    // selection, SAME length aligned by index; never free text. The chip's
    // label itself comes from the server-side vocabulary, so only slugs ride.
    for (const [key, base] of [
      ["audience", manifest.audience],
      ["domain", manifest.domain],
    ]) {
      if (block[key] === undefined) continue;
      const entry = `${lentry}.${key}`;
      const baseArr = Array.isArray(base) ? base : null;
      if (!baseArr || baseArr.length === 0) {
        fail(errors, `overrides ${key}, which the manifest does not declare in its zh main track`, entry);
      } else if (!Array.isArray(block[key])) {
        fail(errors, `${key} override must be an array aligned by index with the zh base`, entry);
      } else if (block[key].length !== baseArr.length) {
        fail(errors, `${key} override has ${block[key].length} entries but the zh base declares ${baseArr.length} — align every entry or omit the override`, entry);
      } else {
        block[key].forEach((slug, i) => {
          const sentry = `${entry}[${i}]`;
          if (typeof slug !== "string" || !isDomainSlug(slug)) {
            fail(errors, `${sentry} must be a domain slug from the controlled vocabulary, got ${JSON.stringify(slug)}`, sentry);
          }
        });
      }
    }

    // outcomes / examples — index-aligned objects; a locale may translate the
    // whole item set; a sub-field only overrides what the zh base declares.
    for (const [key, spec] of [
      ["outcomes", { fields: [["title", DISPLAY_OUTCOMES_TITLE_MAX_WIDTH, false], ["detail", DISPLAY_OUTCOMES_DETAIL_MAX_WIDTH, true]] }],
      ["examples", { fields: [["title", DISPLAY_EXAMPLES_TITLE_MAX_WIDTH, false], ["prompt", DISPLAY_EXAMPLES_PROMPT_MAX_WIDTH, true]] }],
    ]) {
      if (block[key] === undefined) continue;
      const entry = `${lentry}.${key}`;
      const baseArr = Array.isArray(manifest[key]) ? manifest[key] : null;
      if (!baseArr || baseArr.length === 0) {
        fail(errors, `overrides ${key}, which the manifest does not declare in its zh main track`, entry);
      } else if (!Array.isArray(block[key])) {
        fail(errors, `${key} override must be an array aligned by index with the zh base`, entry);
      } else if (block[key].length !== baseArr.length) {
        fail(errors, `${key} override has ${block[key].length} entries but the zh base declares ${baseArr.length} — translate every entry or none`, entry);
      } else {
        block[key].forEach((ov, i) => {
          const oentry = `${entry}[${i}]`;
          if (!plainObject(ov)) {
            fail(errors, `${key} entry must be an object overriding the zh base fields`, oentry);
            return;
          }
          for (const fkey of Object.keys(ov)) {
            if (!spec.fields.some(([f]) => f === fkey)) fail(errors, `${oentry} has unknown key '${fkey}' (only ${spec.fields.map(([f]) => f).join(", ")})`, oentry);
          }
          for (const [field, cap, longForm] of spec.fields) {
            if (ov[field] === undefined) continue;
            const fentry = `${oentry}.${field}`;
            const baseVal = plainObject(baseArr[i]) ? baseArr[i][field] : undefined;
            if (typeof baseVal !== "string" || !baseVal.trim()) {
              fail(errors, `overrides ${field}, which the zh base entry does not declare`, fentry);
              continue;
            }
            if (typeof ov[field] !== "string" || !ov[field].trim() || displayWidth(ov[field]) > cap) {
              fail(errors, `${field} must be a non-empty string within ${cap} display-width units (CJK counts 2)`, fentry);
              continue;
            }
            scanned.push([fentry, ov[field]]);
            if (longForm) ratios.push([fentry, ov[field], baseVal]);
          }
        });
      }
    }

    // identity — ONLY the mark glyph/emoji value is display copy; kind and
    // accent are STRUCTURE (translation would change the presentation
    // identity) and are rejected by name.
    if (block.identity !== undefined) {
      const ientry = `${lentry}.identity`;
      if (!plainObject(block.identity)) {
        fail(errors, "identity override may only carry mark", ientry);
      } else {
        if (block.identity.accent !== undefined) {
          fail(errors, "identity.accent is structure, not display copy — the overlay cannot carry it", `${ientry}.accent`);
        }
        const markOv = block.identity.mark;
        if (markOv !== undefined) {
          const mentry = `${ientry}.mark`;
          const baseMark = plainObject(manifest.identity) && plainObject(manifest.identity.mark) ? manifest.identity.mark : null;
          if (!baseMark) {
            fail(errors, "overrides identity.mark, which the manifest does not declare in its zh main track", mentry);
          } else if (!plainObject(markOv)) {
            fail(errors, "identity.mark override may only carry value", mentry);
          } else {
            if (markOv.kind !== undefined) {
              fail(errors, "identity.mark.kind is structure, not display copy — the overlay cannot carry it", `${mentry}.kind`);
            }
            for (const mkey of Object.keys(markOv)) {
              if (mkey !== "value" && mkey !== "kind") fail(errors, `${mentry} has unknown key '${mkey}' (only value)`, mentry);
            }
            if (markOv.value !== undefined) {
              const ventry = `${mentry}.value`;
              const kind = baseMark.kind;
              if (kind === "image") {
                if (typeof markOv.value !== "string" || !markOv.value.trim() || markOv.value.length > 128) {
                  fail(errors, "identity.mark.value for an image mark must be a non-empty controlled reference string (≤128 chars)", ventry);
                }
              } else {
                const chars = typeof markOv.value === "string" ? Array.from(markOv.value) : null;
                if (!chars || chars.length < 1 || chars.length > 2) {
                  fail(errors, `identity.mark.value for a ${kind} mark must be 1-2 characters`, ventry);
                }
              }
            }
          }
        }
      }
    }

    // Length parity on the long-form fields (D4).
    for (const [entry, value, base] of ratios) {
      if (typeof base !== "string" || base.length === 0) continue;
      if (ratioBroken(value, base)) {
        fail(
          errors,
          `is more than ${LOCALE_LENGTH_RATIO}x its zh base in display width (${displayWidth(value)} vs ${displayWidth(base)} width units) — check this is the translation, not different content`,
          entry,
        );
      }
    }

    // Absolute-replacement claim scan on the en secondary track (D4-6).
    if (enTrack) {
      for (const [entry, value] of scanned) {
        if (typeof value === "string" && ABSOLUTE_CLAIM_RE.test(value)) {
          fail(errors, `declares an absolute-replacement claim (honest-voice rule, same rule as the marketing audit)`, entry);
        }
      }
    }
  }
}

// Validate a pack manifest. Returns an array of { error, entry? } — empty
// means valid. `entry` names the offending item so the editor can point at it.
/**
 * Validate the optional top-level `provenance` block (add-official-adopted-agents
 * D1). Pure shape check: does this pack CLAIM to be adopted, and is the claim
 * well-formed enough to audit? Whether adoption is ADMISSIBLE (license,
 * review, roster) is decided elsewhere — this never grants official status.
 *
 * Absent → no errors (every legacy manifest stays byte-identical).
 * Exported so the adoption lane can validate a provenance draft before mint.
 */
export function validateProvenance(manifest, errors) {
  const p = manifest.provenance;
  if (p === undefined) return;
  const entry = "provenance";
  if (!p || typeof p !== "object" || Array.isArray(p)) {
    fail(errors, `provenance must be an object of { ${PROVENANCE_KEYS.join(", ")} }`, entry);
    return;
  }
  // Lineage-only block (add-agent-fork-lineage D1): a fork stamps provenance
  // with `forkOf` and NO kind — the adopted record's all-fields contract is
  // an adoption-plane contract and a fork must not fabricate it. With `kind`
  // present the block is an adopted record and every legacy requirement
  // below applies unchanged; in lineage-only mode any PRESENT field still
  // gets its shape check, but nothing beyond `forkOf` is required.
  const lineageOnly = p.kind === undefined && p.forkOf !== undefined;
  for (const key of Object.keys(p)) {
    if (!PROVENANCE_KEYS.includes(key)) {
      fail(errors, `provenance has unknown key '${key}' (only ${PROVENANCE_KEYS.join(", ")})`, entry);
    }
  }
  if (!lineageOnly && !PROVENANCE_KINDS.includes(p.kind)) {
    fail(errors, `provenance.kind must be one of ${PROVENANCE_KINDS.join(", ")}`, `${entry}.kind`);
  }
  // Required in an adopted record; OPTIONAL in a lineage-only block — but a
  // PRESENT field gets its shape check in both modes (D6: the fork carries
  // the parent's license, and a bad one must not slip because it is optional).
  const field = (present, shapeBad, requiredMsg, shapeMsg, key) => {
    if (present === undefined) {
      if (!lineageOnly) fail(errors, requiredMsg, `${entry}.${key}`);
      return;
    }
    if (shapeBad) fail(errors, shapeMsg, `${entry}.${key}`);
  };
  field(p.upstreamUrl, typeof p.upstreamUrl !== "string" || !PROVENANCE_URL_RE.test(p.upstreamUrl),
    "provenance.upstreamUrl must be an http(s) URL", "provenance.upstreamUrl must be an http(s) URL", "upstreamUrl");
  field(p.upstreamName, typeof p.upstreamName !== "string" || !p.upstreamName.trim() || p.upstreamName.length > 200,
    "provenance.upstreamName must be a non-empty string of at most 200 chars",
    "provenance.upstreamName must be a non-empty string of at most 200 chars", "upstreamName");
  field(p.license, typeof p.license !== "string" || !PROVENANCE_LICENSE_RE.test(p.license),
    "provenance.license must be an SPDX-like id (letters/digits/._+-)",
    "provenance.license must be an SPDX-like id (letters/digits/._+-)", "license");
  field(p.revision, typeof p.revision !== "string" || !PROVENANCE_REVISION_RE.test(p.revision),
    "provenance.revision must be a pinned commit sha or revision string",
    "provenance.revision must be a pinned commit sha or revision string", "revision");
  for (const who of ["adoptedBy", "reviewedBy"]) {
    field(p[who], typeof p[who] !== "string" || !p[who].trim() || p[who].length > 320,
      `provenance.${who} must be a non-empty operator email of at most 320 chars`,
      `provenance.${who} must be a non-empty operator email of at most 320 chars`, who);
  }
  field(p.reviewedAt, typeof p.reviewedAt !== "string" || Number.isNaN(Date.parse(p.reviewedAt)),
    "provenance.reviewedAt must be an ISO date string", "provenance.reviewedAt must be an ISO date string", "reviewedAt");
  // forkOf (add-agent-fork-lineage): optional lineage block { packId, version }.
  if (p.forkOf !== undefined) {
    const f = p.forkOf;
    const fEntry = `${entry}.forkOf`;
    if (!f || typeof f !== "object" || Array.isArray(f)) {
      fail(errors, "provenance.forkOf must be an object of { packId, version }", fEntry);
    } else {
      for (const key of Object.keys(f)) {
        if (key !== "packId" && key !== "version") {
          fail(errors, `provenance.forkOf has unknown key '${key}' (only packId, version)`, `${fEntry}.${key}`);
        }
      }
      if (typeof f.packId !== "string" || !f.packId.trim()) {
        fail(errors, "provenance.forkOf.packId must be a non-empty pack id", `${fEntry}.packId`);
      }
      if (!Number.isInteger(f.version) || f.version <= 0) {
        fail(errors, "provenance.forkOf.version must be a positive integer version", `${fEntry}.version`);
      }
    }
  }
}

// ── Display format v2 (overhaul-market-catalog-presentation 4.1) ─────────────
// Optional structured display fields — identity / promise / audience /
// outcomes / examples / domain. Everything here is PRESENTATION: no runtime
// contract moves (packId, skill names, MCP registryName, tool faces, consent
// and billing keys are untouched), and an absent field costs exactly nothing:
// a legacy manifest validates and projects byte-identically to the pre-change
// form. Caps are measured in display width (CJK counts 2) — the same unit the
// card's promise slot uses (web/src/lib/packIdentity.ts), so an author who
// passes validation never sees a truncating clip.

const DISPLAY_PROMISE_MAX_WIDTH = 60;
const DISPLAY_OUTCOMES_TITLE_MAX_WIDTH = 40;
const DISPLAY_OUTCOMES_DETAIL_MAX_WIDTH = 160;
const DISPLAY_EXAMPLES_TITLE_MAX_WIDTH = 40;
const DISPLAY_EXAMPLES_PROMPT_MAX_WIDTH = 400;
const DISPLAY_AUDIENCE_RANGE = [1, 3];
const DISPLAY_OUTCOMES_RANGE = [2, 5];
const DISPLAY_EXAMPLES_RANGE = [2, 4];
const DISPLAY_DOMAIN_RANGE = [1, 3];
const MARK_KINDS = ["glyph", "emoji", "image"];

function withinRange(arr, [min, max], field, errors) {
  if (arr.length < min || arr.length > max) {
    fail(errors, `${field} must hold ${min}-${max} entries, got ${arr.length}`, field);
    return false;
  }
  return true;
}

function widthCapped(value, cap, field, errors) {
  if (typeof value !== "string" || !value.trim()) {
    fail(errors, `${field} must be a non-empty string`, field);
    return false;
  }
  const w = displayWidth(value);
  if (w > cap) {
    fail(errors, `${field} exceeds the ${cap}-unit display-width cap (CJK counts 2, got ${w})`, field);
    return false;
  }
  return true;
}

function validateDomainList(arr, field, errors) {
  if (!withinRange(arr, DISPLAY_DOMAIN_RANGE, field, errors)) return;
  arr.forEach((slug, i) => {
    const entry = `${field}[${i}]`;
    if (typeof slug !== "string" || !isDomainSlug(slug)) {
      fail(errors, `${entry} must be a domain slug from the controlled vocabulary, got ${JSON.stringify(slug)}`, entry);
    }
  });
}

function validateDisplayFields(manifest, errors) {
  // identity — object with at most mark + accent; both optional inside.
  if (manifest.identity !== undefined && manifest.identity !== null) {
    const identity = manifest.identity;
    if (!plainObject(identity)) {
      fail(errors, "identity must be an object", "identity");
    } else {
      for (const key of Object.keys(identity)) {
        if (key !== "mark" && key !== "accent") {
          fail(errors, `identity carries an unknown key '${key}' (only mark and accent are allowed)`, "identity");
        }
      }
      if (identity.mark !== undefined && identity.mark !== null) {
        const mark = identity.mark;
        if (!plainObject(mark) || typeof mark.kind !== "string" || !MARK_KINDS.includes(mark.kind)) {
          fail(errors, `identity.mark.kind must be one of ${MARK_KINDS.join("/")}`, "identity.mark.kind");
        } else if (!plainObject(mark) || Object.keys(mark).some((k) => k !== "kind" && k !== "value")) {
          fail(errors, "identity.mark only carries kind and value", "identity.mark");
        } else {
          const v = mark.value;
          if (mark.kind === "image") {
            // Controlled reference: a short opaque string the SERVER resolves —
            // never a URL, never bytes (D11: the seal surface is generated or
            // picked from the controlled set, so there is no upload/audit face).
            if (typeof v !== "string" || !v.trim() || v.length > 128) {
              fail(errors, "identity.mark.value for an image mark must be a non-empty controlled reference string (≤128 chars)", "identity.mark.value");
            }
          } else {
            const chars = typeof v === "string" ? Array.from(v) : null;
            if (!chars || chars.length < 1 || chars.length > 2) {
              fail(errors, `identity.mark.value for a ${mark.kind} mark must be 1-2 characters`, "identity.mark.value");
            }
          }
        }
      }
      if (identity.accent !== undefined && identity.accent !== null) {
        const lines = lineSlugs();
        if (typeof identity.accent !== "string" || !lines.includes(identity.accent)) {
          const looksLikeColor = typeof identity.accent === "string" && /^(#|rgb|hsl)/i.test(identity.accent.trim());
          fail(
            errors,
            looksLikeColor
              ? "identity.accent accepts only a declared line slug — free color values are not writable by authors"
              : `identity.accent must be one of the declared lines: ${lines.join("/")}`,
            "identity.accent",
          );
        }
      }
    }
  }

  if (manifest.promise !== undefined && manifest.promise !== null) {
    widthCapped(manifest.promise, DISPLAY_PROMISE_MAX_WIDTH, "promise", errors);
  }

  if (manifest.audience !== undefined && manifest.audience !== null) {
    if (!Array.isArray(manifest.audience)) {
      fail(errors, "audience must be an array of domain slugs", "audience");
    } else if (withinRange(manifest.audience, DISPLAY_AUDIENCE_RANGE, "audience", errors)) {
      manifest.audience.forEach((slug, i) => {
        const entry = `audience[${i}]`;
        if (typeof slug !== "string" || !isDomainSlug(slug)) {
          fail(errors, `${entry} must be a domain slug from the controlled vocabulary, got ${JSON.stringify(slug)}`, entry);
        }
      });
    }
  }

  if (manifest.outcomes !== undefined && manifest.outcomes !== null) {
    if (!Array.isArray(manifest.outcomes)) {
      fail(errors, "outcomes must be an array", "outcomes");
    } else if (withinRange(manifest.outcomes, DISPLAY_OUTCOMES_RANGE, "outcomes", errors)) {
      manifest.outcomes.forEach((o, i) => {
        const entry = `outcomes[${i}]`;
        if (!plainObject(o)) {
          fail(errors, `${entry} must be an object with title and an optional detail`, entry);
          return;
        }
        for (const key of Object.keys(o)) {
          if (key !== "title" && key !== "detail") fail(errors, `${entry} carries an unknown key '${key}'`, entry);
        }
        widthCapped(o.title, DISPLAY_OUTCOMES_TITLE_MAX_WIDTH, `${entry}.title`, errors);
        if (o.detail !== undefined && o.detail !== null) {
          widthCapped(o.detail, DISPLAY_OUTCOMES_DETAIL_MAX_WIDTH, `${entry}.detail`, errors);
        }
      });
    }
  }

  if (manifest.examples !== undefined && manifest.examples !== null) {
    if (!Array.isArray(manifest.examples)) {
      fail(errors, "examples must be an array", "examples");
    } else if (withinRange(manifest.examples, DISPLAY_EXAMPLES_RANGE, "examples", errors)) {
      manifest.examples.forEach((e, i) => {
        const entry = `examples[${i}]`;
        if (!plainObject(e)) {
          fail(errors, `${entry} must be an object with title and prompt`, entry);
          return;
        }
        for (const key of Object.keys(e)) {
          if (key !== "title" && key !== "prompt") fail(errors, `${entry} carries an unknown key '${key}'`, entry);
        }
        widthCapped(e.title, DISPLAY_EXAMPLES_TITLE_MAX_WIDTH, `${entry}.title`, errors);
        widthCapped(e.prompt, DISPLAY_EXAMPLES_PROMPT_MAX_WIDTH, `${entry}.prompt`, errors);
      });
    }
  }

  if (manifest.domain !== undefined && manifest.domain !== null) {
    if (!Array.isArray(manifest.domain)) {
      fail(errors, "domain must be an array of domain slugs", "domain");
    } else {
      validateDomainList(manifest.domain, "domain", errors);
    }
  }
}

// ── Connector bindings (add-connector-bindings D1) ─────────────────────────
//
// A pack declares which EXTERNAL systems it needs at `(provider, operationType)`
// grain. The two families of fields are deliberately different:
//
//   machine  key / provider / allowOperations / allowActions / connectionHint /
//            optional / alternativeProviders — validated here, because publish
//            and install must agree on what was promised.
//   human    external_system / surface / direction / credential / note — prose
//            for the detail page. Never validated, never parsed.
//
// The rejected middle ground is the point of the change: `provider_status` used
// to be prose claiming "supported", which nothing checked. Status is now the
// ledger's job, so it is not a writable manifest field.
export const CONNECTOR_BINDING_HUMAN_FIELDS = ["external_system", "surface", "direction", "credential", "note"];
// Role names are a shared vocabulary: lowercase kebab-case only (see the template
// repo's docs/connector-role-vocabulary.md). A vendor id can never match this by
// accident for a role-shaped word, and a CamelCase or snake_case role is almost
// always an invention that will drift from the same need declared elsewhere.
const ROLE_NAME_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

function alternativesLength(binding) {
  return Array.isArray(binding?.alternativeProviders) ? binding.alternativeProviders.length : 0;
}

export const CONNECTOR_BINDING_KEYS = [
  "key",
  "provider",
  "providerRole",
  "allowOperations",
  "allowActions",
  "connectionHint",
  "optional",
  "alternativeProviders",
  ...CONNECTOR_BINDING_HUMAN_FIELDS,
];
/** The classes a binding may request. `destructive` is deliberately absent. */
export const CONNECTOR_BINDING_OPERATION_TYPES = ["read", "write"];

function validateConnectorBindings(manifest, errors) {
  if (manifest.connector_bindings === undefined) return;
  const bindings = manifest.connector_bindings;
  if (!Array.isArray(bindings)) {
    fail(errors, "connector_bindings must be an array of binding objects", "connector_bindings");
    return;
  }
  if (bindings.length > 32) {
    fail(errors, "connector_bindings must not declare more than 32 bindings", "connector_bindings");
    return;
  }

  const seen = new Set();
  bindings.forEach((binding, index) => {
    const entry = `connector_bindings[${index}]`;
    if (!plainObject(binding)) {
      fail(errors, "connector binding must be an object", entry);
      return;
    }
    for (const key of Object.keys(binding)) {
      if (CONNECTOR_BINDING_KEYS.includes(key)) continue;
      const isProse = key === "provider_status" || key === "status";
      fail(
        errors,
        isProse
          ? `${entry}.${key} is not writable: a binding's status is decided by the binding ledger, not by prose`
          : `${entry} carries an unknown key '${key}'`,
        entry,
      );
    }

    // key — required, unique in the pack, and usable as a profile row suffix
    // (`connector:<key>`) so no whitespace or separators that would make two
    // rows collide.
    const key = typeof binding.key === "string" ? binding.key.trim() : "";
    const label = key ? `'${key}'` : entry;
    if (!key) {
      fail(errors, "connector binding needs a non-empty key", `${entry}.key`);
    } else if (!/^[A-Za-z0-9._:-]{1,64}$/.test(key)) {
      fail(errors, `connector binding key '${key}' must be 1-64 chars of [A-Za-z0-9._:-]`, `${entry}.key`);
    } else if (seen.has(key)) {
      fail(errors, `duplicate connector binding key '${key}'`, `${entry}.key`);
    } else {
      seen.add(key);
    }

    // provider — the connector catalog's service id; existence is NOT checked
    // here (D2: the catalog lives only in the connector, resolution reports
    // `unwired`).
    const provider = typeof binding.provider === "string" ? binding.provider.trim() : "";
    if (!provider) {
      fail(errors, `connector binding ${label} needs a provider service id`, `${entry}.provider`);
    } else if (/\s/.test(provider)) {
      fail(errors, `connector binding ${label} provider must be a service id without spaces`, `${entry}.provider`);
    }

    // providerRole (add-connector-role-mapping D1) — `provider` is a ROLE name
    // (e.g. "wms"), not a catalog service id, and the user picks the actual
    // system per identity. Whether the role name happens to collide with a real
    // service id cannot be checked here (no catalog); the explicit boolean is
    // what decides, so a collision never silently changes semantics.
    if (binding.providerRole !== undefined && typeof binding.providerRole !== "boolean") {
      fail(errors, `${entry}.providerRole must be a boolean`, `${entry}.providerRole`);
    }
    // A role name is a shared vocabulary key, not a per-pack invention: it is the
    // lookup key in connector_role_mappings(email, role), so two packs declaring
    // the same need MUST spell it identically or the customer answers twice.
    // Enforcing the shape here (rather than only in the template repo) means it
    // holds for packs published from anywhere. Vendor ids stay legal as plain
    // `provider` values; this only constrains the role form.
    if (binding.providerRole === true && provider && !ROLE_NAME_RE.test(provider)) {
      fail(errors, `${entry}.provider must be a kebab-case role name when providerRole is true`, `${entry}.provider`);
    }
    if (binding.providerRole === true && alternativesLength(binding) > 0) {
      // A mapped role has exactly one answer (the system the customer chose).
      // Alternatives would silently override that choice, and the status face
      // would then disagree with the person who made it.
      fail(errors, `${entry}.alternativeProviders must not accompany providerRole`, `${entry}.alternativeProviders`);
    }

    const alternatives = [];
    if (binding.alternativeProviders !== undefined) {
      if (!Array.isArray(binding.alternativeProviders)) {
        fail(errors, `${entry}.alternativeProviders must be an array of service ids`, `${entry}.alternativeProviders`);
      } else {
        binding.alternativeProviders.forEach((alt, altIndex) => {
          const value = typeof alt === "string" ? alt.trim() : "";
          if (!value || /\s/.test(value)) {
            fail(
              errors,
              `${entry}.alternativeProviders[${altIndex}] must be a service id without spaces`,
              `${entry}.alternativeProviders`,
            );
            return;
          }
          if (alternatives.includes(value)) {
            fail(errors, `${entry}.alternativeProviders repeats '${value}'`, `${entry}.alternativeProviders`);
            return;
          }
          alternatives.push(value);
        });
      }
    }
    const declaredProviders = provider ? [provider, ...alternatives] : alternatives;

    // Scope — at least one of the two allowlists. Omitted is NOT "full
    // authority": a binding with no range cannot be granted safely, so it is
    // rejected rather than defaulted.
    let hasOperations = false;
    if (binding.allowOperations !== undefined) {
      if (!Array.isArray(binding.allowOperations) || binding.allowOperations.length === 0) {
        fail(errors, `${entry}.allowOperations must be a non-empty array when present`, `${entry}.allowOperations`);
      } else {
        binding.allowOperations.forEach((operation, opIndex) => {
          const at = `${entry}.allowOperations[${opIndex}]`;
          // `"read"` is shorthand for the binding's own provider.
          if (typeof operation === "string") {
            const type = operation.trim();
            if (!CONNECTOR_BINDING_OPERATION_TYPES.includes(type)) {
              fail(
                errors,
                `${at} must be one of ${CONNECTOR_BINDING_OPERATION_TYPES.join("/")} (destructive is not grantable by a binding)`,
                at,
              );
              return;
            }
            hasOperations = true;
            return;
          }
          if (!plainObject(operation)) {
            fail(errors, `${at} must be an operation class or a {provider, operationType} object`, at);
            return;
          }
          const type = typeof operation.operationType === "string" ? operation.operationType.trim() : "";
          if (!CONNECTOR_BINDING_OPERATION_TYPES.includes(type)) {
            fail(
              errors,
              `${at}.operationType must be one of ${CONNECTOR_BINDING_OPERATION_TYPES.join("/")} (destructive is not grantable by a binding)`,
              at,
            );
            return;
          }
          if (operation.provider !== undefined) {
            const opProvider = typeof operation.provider === "string" ? operation.provider.trim() : "";
            if (!declaredProviders.includes(opProvider)) {
              // A grant for a provider this binding never declared is a typo or
              // a scope escape — either way it must not reach the mint.
              fail(
                errors,
                `${at}.provider '${opProvider}' is not this binding's provider or one of its alternativeProviders`,
                at,
              );
              return;
            }
          }
          hasOperations = true;
        });
      }
    }

    let hasActions = false;
    if (binding.allowActions !== undefined) {
      if (!Array.isArray(binding.allowActions) || binding.allowActions.length === 0) {
        fail(errors, `${entry}.allowActions must be a non-empty array when present`, `${entry}.allowActions`);
      } else {
        binding.allowActions.forEach((action, actionIndex) => {
          const at = `${entry}.allowActions[${actionIndex}]`;
          if (typeof action !== "string" || !action.trim() || /\s/.test(action.trim())) {
            fail(errors, `${at} must be a non-empty action rule without spaces`, at);
            return;
          }
          hasActions = true;
        });
      }
    }

    if (!hasOperations && !hasActions) {
      fail(
        errors,
        `connector binding ${label} declares no scope: allowOperations or allowActions is required (there is no implicit full authority)`,
        entry,
        "connector_binding_scope_missing",
      );
    }

    if (binding.optional !== undefined && typeof binding.optional !== "boolean") {
      fail(errors, `${entry}.optional must be a boolean`, `${entry}.optional`);
    }
    if (binding.connectionHint !== undefined && typeof binding.connectionHint !== "string") {
      fail(errors, `${entry}.connectionHint must be a string`, `${entry}.connectionHint`);
    }
  });
}

export function validatePackManifest(manifest, limits = packLimits()) {
  const errors = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return [{ error: "manifest must be an object" }];
  }

  const name = manifest.name;
  if (typeof name !== "string" || !name.trim() || name.trim().length > limits.maxNameChars) {
    fail(errors, `name must be a non-empty string of at most ${limits.maxNameChars} characters`, undefined, "name_too_long");
  }

  if (manifest.description != null && (typeof manifest.description !== "string" || manifest.description.length > limits.maxDescriptionChars)) {
    fail(errors, `description must be a string of at most ${limits.maxDescriptionChars} characters`, undefined, "description_too_long");
  }

  // Version note (add-facet-version-history): optional, one per published
  // version, immutable with it. Renders in version-history rows.
  if (manifest.notes != null && (typeof manifest.notes !== "string" || manifest.notes.length > limits.maxNotesChars)) {
    fail(errors, `notes must be a string of at most ${limits.maxNotesChars} characters`);
  }

  // Usage guide (add-pack-tutorials-and-wizard): optional, exactly three
  // authored steps. Shape-strict — the detail page renders it verbatim.
  if (manifest.guide !== undefined) {
    const g = manifest.guide;
    const steps = g && g.steps;
    if (!steps || !Array.isArray(steps) || steps.length !== 3) {
      fail(errors, "guide.steps must be an array of exactly 3 steps");
    } else {
      steps.forEach((st, i) => {
        const entry = `guide.steps[${i}]`;
        if (!st || typeof st !== "object") {
          fail(errors, "guide step must be an object", entry);
          return;
        }
        if (typeof st.title !== "string" || !st.title.trim() || st.title.length > limits.maxGuideStepTitleChars) {
          fail(errors, `guide step title must be a non-empty string of at most ${limits.maxGuideStepTitleChars} characters`, entry);
        }
        if (typeof st.body !== "string" || !st.body.trim() || st.body.length > limits.maxGuideStepBodyChars) {
          fail(errors, `guide step body must be a non-empty string of at most ${limits.maxGuideStepBodyChars} characters`, entry);
        }
      });
    }
  }

  // Visibility (add-agent-platform-ops): optional public|private, defaulting
  // to public. A pack-level exposure attribute, not content.
  if (manifest.visibility !== undefined && manifest.visibility !== "public" && manifest.visibility !== "private") {
    fail(errors, 'visibility must be "public" or "private" when present');
  }

  // Public-facing declaration (fix-external-team-chat-lane B3): optional
  // boolean. A pack that declares it is an EXTERNAL team — its personas run
  // with a narrowed tool face (public surfaces only, no workspace file
  // tools) so internal lane names and internal product surfaces cannot leak
  // into a visitor's answer. Absent ⇒ the pack keeps its current tool face
  // byte-for-byte (every existing official seed is unaffected).
  if (manifest.publicFacing !== undefined && typeof manifest.publicFacing !== "boolean") {
    fail(errors, "publicFacing must be a boolean when present");
  }

  // Curation category (add-facet-content-management): optional vertical slug
  // the author may declare at publish; admins can retarget it later via the
  // curation endpoint. Presentation-level only.
  if (manifest.category !== undefined && (typeof manifest.category !== "string" || !/^[a-z0-9-]{1,32}$/.test(manifest.category))) {
    fail(errors, "category must be a slug of 1-32 chars [a-z0-9-] when present");
  }

  const tags = manifest.tags ?? [];
  if (!Array.isArray(tags) || tags.length > limits.maxTags) {
    fail(errors, `tags must be an array of at most ${limits.maxTags} strings`);
  } else {
    tags.forEach((t, i) => {
      if (typeof t !== "string" || !t.trim() || t.trim().length > limits.maxTagChars) {
        fail(errors, `tag ${i + 1} must be a non-empty string of at most ${limits.maxTagChars} characters`, `tags[${i}]`);
      }
    });
  }

  const skills = manifest.skills ?? [];
  if (!Array.isArray(skills) || skills.length > limits.maxSkills) {
    fail(errors, `skills must be an array of at most ${limits.maxSkills} entries`, undefined, "skills_too_many");
  } else {
    const seen = new Set();
    skills.forEach((s, i) => {
      const entry = `skills[${i}]`;
      if (!s || typeof s !== "object") {
        fail(errors, "skill entry must be an object", entry, "skill_entry_invalid");
        return;
      }
      if (typeof s.name !== "string" || !NAME_RE.test(s.name)) {
        fail(errors, "skill name must match [A-Za-z0-9._-], 1-64 chars", entry, "skill_name_invalid");
      } else if (seen.has(s.name)) {
        fail(errors, `duplicate skill name '${s.name}'`, entry, "skill_name_duplicate");
      } else {
        seen.add(s.name);
      }
      if (typeof s.description !== "string" || !s.description.trim() || s.description.length > 300) {
        fail(errors, "skill description must be a non-empty string of at most 300 characters", entry, "skill_description_invalid");
      }
      // add-skill-supply-annotations: optional zh base display name; declaring
      // it obliges every i18n locale block to carry skills['<name>'].name.
      if ("title" in s && (typeof s.title !== "string" || !s.title.trim() || s.title.length > 60)) {
        fail(errors, "skill title must be a non-empty string of at most 60 characters", `${entry}.title`, "skill_title_invalid");
      }
      if (typeof s.content !== "string" || !s.content.trim() || s.content.length > limits.maxSkillBodyChars) {
        fail(errors, `skill content must be a non-empty string of at most ${limits.maxSkillBodyChars} characters`, entry, "skill_content_invalid");
      }
      // Package shape (add-packaged-skills): files/frontmatter ride the same
      // entry the two gates (facet publish, cell install) already validate.
      for (const err of validateSkillFiles(s, i, limits)) {
        errors.push(err);
      }
    });
  }

  const mcpServers = manifest.mcpServers ?? [];
  if (!Array.isArray(mcpServers) || mcpServers.length > limits.maxMcpRefs) {
    fail(errors, `mcpServers must be an array of at most ${limits.maxMcpRefs} entries`, undefined, "mcp_too_many");
  } else {
    mcpServers.forEach((m, i) => {
      const entry = `mcpServers[${i}]`;
      if (!m || typeof m !== "object") {
        fail(errors, "MCP entry must be an object", entry, "mcp_entry_invalid");
        return;
      }
      const forbidden = MCP_FORBIDDEN_KEYS.filter((k) => m[k] !== undefined);
      if (forbidden.length > 0) {
        fail(errors, `MCP entries may only reference registry servers (found forbidden key(s): ${forbidden.join(", ")})`, entry, "mcp_forbidden_keys");
        return;
      }
      if (typeof m.registryName !== "string" || !NAME_RE.test(m.registryName)) {
        fail(errors, "MCP entry needs a registryName matching [A-Za-z0-9._-], 1-64 chars", entry, "mcp_needs_registry_name");
      }
      // Explicit tool face (pack-tool-declaration-gate D3): a reference either
      // narrows to a name list or declares the whole surface with a reason.
      // "Neither" stays shape-valid on purpose — this validator is shared with
      // the install path, and legacy published versions must keep installing.
      // The publish gate, not shape, is where a published version must have
      // made the choice (gateway/packs.js).
      if (m.allowTools !== undefined && m.fullSurface !== undefined) {
        fail(errors, "allowTools and fullSurface are mutually exclusive; declare the tools or mark the reference full-surface, not both", entry, "allowtools_conflict");
      }
      if (m.fullSurface !== undefined) {
        if (m.fullSurface !== true) {
          fail(errors, "fullSurface must be true when present (omit the key instead of setting it false)", entry, "fullsurface_false");
        } else if (
          typeof m.fullSurfaceReason !== "string" ||
          !m.fullSurfaceReason.trim() ||
          m.fullSurfaceReason.length > limits.maxNotesChars
        ) {
          fail(errors, `fullSurface requires a non-empty fullSurfaceReason of at most ${limits.maxNotesChars} characters`, entry, "fullsurface_needs_reason");
        }
      } else if (m.fullSurfaceReason !== undefined) {
        fail(errors, "fullSurfaceReason requires fullSurface: true", entry, "reason_needs_fullsurface");
      }
      // Tool allowlist (add-mcp-tool-scoping D3): names-only narrowing of this
      // reference — a declaration, never configuration. Absent = the server's
      // full tool surface (the pre-change behavior); present-but-empty is a
      // no-op declaration and rejected like every other empty filter here.
      if (m.allowTools !== undefined) {
        if (!Array.isArray(m.allowTools) || m.allowTools.length === 0 || m.allowTools.length > limits.maxToolsPerMcp) {
          fail(errors, `allowTools must be a non-empty array of at most ${limits.maxToolsPerMcp} tool leaf names`, entry, "allowtools_invalid");
        } else {
          const seenTools = new Set();
          for (const t of m.allowTools) {
            if (typeof t !== "string" || !TOOL_LEAF_NAME_RE.test(t)) {
              fail(errors, `allowTools entries must be tool leaf names matching [A-Za-z0-9._-], 1-128 chars`, entry);
            } else if (seenTools.has(t)) {
              fail(errors, `allowTools declares '${t}' twice`, entry);
            } else {
              seenTools.add(t);
            }
          }
        }
      }
      if (m.requiredGroup != null && (typeof m.requiredGroup !== "string" || !m.requiredGroup.trim() || m.requiredGroup.length > 64)) {
        fail(errors, "MCP entry requiredGroup must be a non-empty string of at most 64 characters", entry);
      }
      // Optional display description (add-mcp-annotation-overlay): the zh MAIN
      // track text for what this referenced server is for — display only, it
      // never reaches the runtime tool face (connection config stays
      // registryName + tool-face declaration). The locale overlay covers it
      // per declared registryName (LOCALE_OVERLAY_KEYS mcpServers).
      if (m.description !== undefined && (typeof m.description !== "string" || !m.description.trim() || m.description.length > MCP_DESC_CHARS)) {
        fail(errors, `MCP entry description must be a non-empty string of at most ${MCP_DESC_CHARS} characters`, entry);
      }
    });
  }

  const agents = manifest.agents ?? [];
  if (!Array.isArray(agents) || agents.length > limits.maxAgents) {
    fail(errors, `agents must be an array of at most ${limits.maxAgents} entries`, undefined, "agents_too_many");
  } else {
    const seen = new Set();
    agents.forEach((a, i) => {
      const entry = `agents[${i}]`;
      if (!a || typeof a !== "object") {
        fail(errors, "agent entry must be an object", entry, "agent_entry_invalid");
        return;
      }
      const forbidden = AGENT_FORBIDDEN_KEYS.filter((k) => a[k] !== undefined);
      if (forbidden.length > 0) {
        fail(errors, `agent entries are persona-only (found forbidden key(s): ${forbidden.join(", ")})`, entry, "agent_forbidden_keys");
        return;
      }
      if (typeof a.id !== "string" || !NAME_RE.test(a.id)) {
        fail(errors, "agent id must match [A-Za-z0-9._-], 1-64 chars", entry, "agent_id_invalid");
      } else if (a.id.startsWith("user.")) {
        // Reserved namespace (add-custom-presets D6): ids under `user.` belong
        // to the cell's server-assigned custom presets — a pack may never
        // collide with one going forward (installs additionally skip via the
        // foreign-owner backstop for ids that predate this rule).
        fail(errors, `agent id '${a.id}' falls under the reserved "user." namespace (custom presets)`, entry);
      } else if (seen.has(a.id)) {
        fail(errors, `duplicate agent id '${a.id}'`, entry, "agent_id_duplicate");
      } else {
        seen.add(a.id);
      }
      if (typeof a.name !== "string" || !a.name.trim() || a.name.length > 60) {
        fail(errors, "agent name must be a non-empty string of at most 60 characters", entry, "agent_name_invalid");
      }
      // Memory constitution (add-agent-self-iteration): the agent's own
      // declaration of what it records and when — optional free text, ≤600
      // chars, composed into the persona's tail at preset build time.
      if (a.memory !== undefined) {
        const mem = a.memory;
        const guidance = typeof mem === "object" && mem !== null ? mem.guidance : undefined;
        if (typeof guidance !== "string" || !guidance.trim() || guidance.length > 600) {
          fail(errors, "agent memory.guidance must be a non-empty string of at most 600 characters", entry);
        }
      }
      if (typeof a.persona !== "string" || !a.persona.trim() || a.persona.length > limits.maxPersonaChars) {
        fail(errors, `agent persona must be a non-empty string of at most ${limits.maxPersonaChars} characters`, entry, "agent_persona_invalid");
      }
      // Resource declaration (add-persona-resource-sets D2): an optional
      // per-role subset of the pack's OWN skills / MCP references. Dimension
      // independent — absent dimension = whole-pack set for it, present-but-
      // empty = none. Foreign names and duplicates are rejected naming the
      // role, so publish and install enforce identical semantics.
      // add-mcp-tool-scoping adds a third dimension: mcpTools maps the pack's
      // own MCP references to tool leaf names, narrowing only (a role may
      // never widen a pack-level allowTools).
      if (a.resources !== undefined) {
        if (!a.resources || typeof a.resources !== "object" || Array.isArray(a.resources)) {
          fail(errors, "agent resources must be an object of optional skills/mcpServers/mcpTools", entry);
        } else {
          const ownSkills = new Set(
            (Array.isArray(skills) ? skills : []).map((s) => s?.name).filter((n) => typeof n === "string"),
          );
          const ownMcp = new Set(
            (Array.isArray(mcpServers) ? mcpServers : []).map((m) => m?.registryName).filter((n) => typeof n === "string"),
          );
          // Pack-level allowlists, for the narrowing-only rule below.
          const packAllow = new Map(
            (Array.isArray(mcpServers) ? mcpServers : [])
              .filter((m) => m && Array.isArray(m.allowTools))
              .map((m) => [m.registryName, new Set(m.allowTools)]),
          );
          for (const [dim, own] of [["skills", ownSkills], ["mcpServers", ownMcp]]) {
            const declared = a.resources[dim];
            if (declared === undefined) continue; // absent dimension = whole-pack
            if (!Array.isArray(declared) || declared.some((n) => typeof n !== "string" || !NAME_RE.test(n))) {
              fail(errors, `agent resources.${dim} must be an array of names matching [A-Za-z0-9._-], 1-64 chars`, entry);
              continue;
            }
            const seenDecl = new Set();
            for (const name of declared) {
              if (seenDecl.has(name)) {
                fail(errors, `agent '${a.id}' declares '${name}' twice in resources.${dim}`, entry);
              } else if (!own.has(name)) {
                fail(errors, `agent '${a.id}' declares '${name}' in resources.${dim}, which the pack itself does not declare`, entry);
              } else {
                seenDecl.add(name);
              }
            }
          }
          // mcpTools (add-mcp-tool-scoping): a map dimension — each key is one
          // of the pack's own MCP references, each value the role's tool leaf
          // set for it. Absent map (or absent key) = the reference's pack-level
          // allowlist applies; a present-but-empty array = no tools of that
          // server for this role. When the pack declares an allowlist for the
          // reference, every role name must be within it (narrowing only).
          if (a.resources.mcpTools !== undefined) {
            const mt = a.resources.mcpTools;
            if (!mt || typeof mt !== "object" || Array.isArray(mt)) {
              fail(errors, "agent resources.mcpTools must be an object mapping MCP references to tool leaf name arrays", entry);
            } else {
              for (const [srv, tools] of Object.entries(mt)) {
                const tentry = `${entry}.resources.mcpTools['${srv}']`;
                if (!ownMcp.has(srv)) {
                  fail(errors, `agent '${a.id}' declares '${srv}' in resources.mcpTools, which the pack itself does not declare`, entry);
                  continue;
                }
                if (!Array.isArray(tools) || tools.some((t) => typeof t !== "string" || !TOOL_LEAF_NAME_RE.test(t))) {
                  fail(errors, `resources.mcpTools['${srv}'] must be an array of tool leaf names matching [A-Za-z0-9._-], 1-128 chars (empty array = no tools of this server for the role)`, tentry);
                  continue;
                }
                const allow = packAllow.get(srv);
                const seenT = new Set();
                for (const t of tools) {
                  if (seenT.has(t)) {
                    fail(errors, `agent '${a.id}' declares '${t}' twice in resources.mcpTools['${srv}']`, tentry);
                  } else if (allow && !allow.has(t)) {
                    fail(errors, `agent '${a.id}' declares '${t}' in resources.mcpTools['${srv}'], outside the reference's pack-level allowTools (roles may only narrow)`, tentry);
                  } else {
                    seenT.add(t);
                  }
                }
              }
            }
          }
          for (const key of Object.keys(a.resources)) {
            if (key !== "skills" && key !== "mcpServers" && key !== "mcpTools") {
              fail(errors, `agent resources has unknown dimension '${key}' (only skills, mcpServers, mcpTools)`, entry);
            }
          }
        }
      }
      // Serving contract (add-a2a-agent-serving D1): optional declaration that
      // the role is deployable as an Agent Service over A2A. Absent contract ⇒
      // every pre-existing rule applies verbatim. `card.skills` entries are
      // capability DECLARATIONS for the A2A card — same word as the pack's
      // skill files, different meaning; they never reference the files.
      if (a.serving !== undefined) {
        const sentry = `${entry}.serving`;
        if (!a.serving || typeof a.serving !== "object" || Array.isArray(a.serving)) {
          fail(errors, "serving must be an object of { protocol, card? }", entry);
        } else {
          const forbidden = SERVING_CONTRACT_FORBIDDEN_KEYS.filter((k) => a.serving[k] !== undefined);
          if (forbidden.length > 0) {
            fail(errors, `serving declares exposure, not runtime configuration (found forbidden key(s): ${forbidden.join(", ")})`, sentry);
          }
          for (const key of Object.keys(a.serving)) {
            if (!SERVING_KEYS.includes(key)) {
              fail(errors, `serving has unknown key '${key}' (only ${SERVING_KEYS.join(", ")})`, sentry);
            }
          }
          if (typeof a.serving.protocol !== "string" || a.serving.protocol !== "a2a") {
            fail(errors, 'serving.protocol must be "a2a" (v1 exposes the A2A protocol only)', sentry);
          }
          // Harness declaration (add-harness-adapter D5): a NAME the target
          // runner's allowlist resolves — shape only here; whether a runner
          // hosts it is the deploy gate's check (HARNESS_NOT_HOSTED).
          if (a.serving.harness !== undefined && (typeof a.serving.harness !== "string" || !a.serving.harness.trim() || a.serving.harness.length > 64)) {
            fail(errors, "serving.harness must be a harness name (non-empty string, at most 64 chars)", sentry);
          }
          // Tool-face tier (add-serving-tool-face): a declared REDUCTION of
          // the built-in tool surface, materialized as row disables. Enum
          // here; the runner refuses an unknown tier at materialization.
          if (a.serving.toolFace !== undefined && !SERVING_TOOL_FACES.includes(a.serving.toolFace)) {
            fail(errors, `serving.toolFace must be one of ${SERVING_TOOL_FACES.join(", ")}`, sentry);
          }
          // Model lane declaration (ADR-0019): an optional default model and a
          // narrowing whitelist. Constraints, not configuration — the deploy
          // surface still gates every actual choice against the deployer's
          // own billing-key lanes (openspec: agent-service-config).
          if (a.serving.model !== undefined) {
            const err = modelIdError(a.serving.model);
            if (err) fail(errors, `serving.${err}`, sentry);
          }
          if (a.serving.modelWhitelist !== undefined) {
            const wentry = `${sentry}.modelWhitelist`;
            if (!Array.isArray(a.serving.modelWhitelist) || a.serving.modelWhitelist.length === 0 || a.serving.modelWhitelist.length > limits.maxModelWhitelist) {
              fail(errors, `serving.modelWhitelist must be a non-empty array of at most ${limits.maxModelWhitelist} model identifiers`, wentry);
            } else {
              const seenModels = new Set();
              for (const m of a.serving.modelWhitelist) {
                const err = modelIdError(m);
                if (err) {
                  fail(errors, `serving.modelWhitelist entries must be model identifiers (${err})`, wentry);
                } else if (seenModels.has(m)) {
                  fail(errors, `serving.modelWhitelist declares '${m}' twice`, wentry);
                } else {
                  seenModels.add(m);
                }
              }
            }
          }
          if (a.serving.model !== undefined && Array.isArray(a.serving.modelWhitelist) && !a.serving.modelWhitelist.includes(a.serving.model)) {
            fail(errors, "serving.model must be within serving.modelWhitelist when both are declared", sentry);
          }
          const card = a.serving.card;
          if (card !== undefined) {
            const centry = `${sentry}.card`;
            if (!card || typeof card !== "object" || Array.isArray(card)) {
              fail(errors, "serving.card must be an object of optional manual card fields", sentry);
            } else {
              const cardForbidden = SERVING_FORBIDDEN_KEYS.filter((k) => card[k] !== undefined);
              if (cardForbidden.length > 0) {
                fail(errors, `serving.card may not carry runtime configuration (found forbidden key(s): ${cardForbidden.join(", ")})`, centry);
              }
              for (const key of Object.keys(card)) {
                if (!CARD_KEYS.includes(key)) {
                  fail(errors, `serving.card has unknown key '${key}' (only ${CARD_KEYS.join(", ")})`, centry);
                }
              }
              if (card.name !== undefined && (typeof card.name !== "string" || !card.name.trim() || card.name.length > limits.maxCardNameChars)) {
                fail(errors, `serving.card.name must be a non-empty string of at most ${limits.maxCardNameChars} characters`, centry);
              }
              if (card.description !== undefined && (typeof card.description !== "string" || card.description.length > limits.maxCardDescriptionChars)) {
                fail(errors, `serving.card.description must be a string of at most ${limits.maxCardDescriptionChars} characters`, centry);
              }
              // Example prompts (add-agent-card-examples): ≤3 one-click
              // starters for discovery surfaces — shape-validated, absent
              // keeps the card byte-identical to the pre-change form.
              if (card.examples !== undefined) {
                if (!Array.isArray(card.examples) || card.examples.length === 0 || card.examples.length > 3) {
                  fail(errors, "serving.card.examples must be an array of 1-3 sample prompts", centry);
                } else {
                  card.examples.forEach((ex, j) => {
                    if (typeof ex !== "string" || !ex.trim() || ex.length > 200) {
                      fail(errors, `serving.card.examples[${j}] must be a non-empty string of at most 200 characters`, centry);
                    }
                  });
                }
              }
              if (card.capabilities !== undefined) {
                if (!card.capabilities || typeof card.capabilities !== "object" || Array.isArray(card.capabilities)) {
                  fail(errors, "serving.card.capabilities must be an object of boolean flags (e.g. streaming)", centry);
                } else {
                  for (const [flag, value] of Object.entries(card.capabilities)) {
                    if (typeof value !== "boolean" || !/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(flag)) {
                      fail(errors, `serving.card.capabilities '${flag}' must map to a boolean (flag names: letters/digits/-/_, ≤40 chars)`, centry);
                    }
                  }
                }
              }
              if (card.skills !== undefined) {
                if (!Array.isArray(card.skills) || card.skills.length > limits.maxCardSkills) {
                  fail(errors, `serving.card.skills must be an array of at most ${limits.maxCardSkills} capability declarations`, centry);
                } else {
                  card.skills.forEach((cs, j) => {
                    const csEntry = `${centry}.skills[${j}]`;
                    if (!cs || typeof cs !== "object") {
                      fail(errors, "capability declaration must be an object of { id, name, description?, tags? }", csEntry);
                      return;
                    }
                    for (const key of Object.keys(cs)) {
                      if (!CARD_SKILL_KEYS.includes(key)) {
                        fail(errors, `capability declaration has unknown key '${key}' (only ${CARD_SKILL_KEYS.join(", ")})`, csEntry);
                      }
                    }
                    if (typeof cs.id !== "string" || !NAME_RE.test(cs.id)) {
                      fail(errors, "capability id must match [A-Za-z0-9._-], 1-64 chars", csEntry);
                    }
                    if (typeof cs.name !== "string" || !cs.name.trim() || cs.name.length > limits.maxCardNameChars) {
                      fail(errors, `capability name must be a non-empty string of at most ${limits.maxCardNameChars} characters`, csEntry);
                    }
                    if (cs.description !== undefined && (typeof cs.description !== "string" || cs.description.length > limits.maxCapabilityDescriptionChars)) {
                      fail(errors, `capability description must be a string of at most ${limits.maxCapabilityDescriptionChars} characters`, csEntry);
                    }
                    if (cs.tags !== undefined) {
                      if (!Array.isArray(cs.tags) || cs.tags.length > limits.maxTags || cs.tags.some((t) => typeof t !== "string" || !t.trim() || t.trim().length > limits.maxTagChars)) {
                        fail(errors, `capability tags must be an array of at most ${limits.maxTags} strings of at most ${limits.maxTagChars} characters`, csEntry);
                      }
                    }
                  });
                }
              }
            }
          }
          // Work rhythm (add-agent-residency D2): the autonomy grant — a
          // contract with rhythm deploys an agent that works on its own
          // cadence; without one it only answers. Declarative cadence only.
          if (a.serving.rhythm !== undefined) {
            for (const err of validateRhythm(a.serving.rhythm, limits)) {
              fail(errors, err.error, err.entry ? `${sentry}.${err.entry}` : sentry);
            }
          }
          // Turn budget (add-serving-budgets D1): the contract's optional
          // per-turn duration ceiling. Declarative duration only.
          if (a.serving.budget !== undefined) {
            for (const err of validateBudget(a.serving.budget, limits)) {
              fail(errors, err.error, err.entry ? `${sentry}.${err.entry}` : sentry);
            }
          }
          // Data workspace (facet-mcp-foundation-v1 3.1): the contract's
          // optional per-deployment data-volume request — the runner
          // materializes a private data dir beside the state files and
          // exports its path to the child. Declarative capacity only.
          if (a.serving.workspace !== undefined) {
            for (const err of validateWorkspace(a.serving.workspace, limits)) {
              fail(errors, err.error, err.entry ? `${sentry}.${err.entry}` : sentry);
            }
          }
        }
      }
    });
  }

  // Bot units (pack-bot-units, design D1/D2): the pack's third content
  // primitive — a generic bot type reference with an optional single mounted
  // skill. Same validation face as everything above: this one function serves
  // the gateway's publish prevalidation and the cell's install check, so the
  // two can never disagree. Never-overwrite/foreign-owner behavior is
  // install-time (pack-store.js); everything structural is decided here.
  const bots = manifest.bots ?? [];
  if (!Array.isArray(bots) || bots.length > limits.maxBots) {
    fail(errors, `bots must be an array of at most ${limits.maxBots} entries`);
  } else {
    const ownSkills = new Set(
      (Array.isArray(skills) ? skills : []).map((s) => s?.name).filter((n) => typeof n === "string"),
    );
    const seenBots = new Set();
    bots.forEach((b, i) => {
      const entry = `bots[${i}]`;
      if (!b || typeof b !== "object") {
        fail(errors, "bot entry must be an object", entry);
        return;
      }
      const forbidden = BOT_FORBIDDEN_KEYS.filter((k) => b[k] !== undefined);
      if (forbidden.length > 0) {
        fail(errors, `bot entries are generic-type references, not channel configurations (found forbidden key(s): ${forbidden.join(", ")})`, entry);
        return;
      }
      for (const key of Object.keys(b)) {
        if (!BOT_KEYS.includes(key)) {
          fail(errors, `bot entry has unknown key '${key}' (only ${BOT_KEYS.join(", ")})`, entry);
        }
      }
      if (typeof b.id !== "string" || !NAME_RE.test(b.id)) {
        fail(errors, "bot id must match [A-Za-z0-9._-], 1-64 chars", entry);
      } else if (b.id.startsWith("user.")) {
        // Same reserved namespace as agent ids: `user.` belongs to the cell's
        // server-assigned entities; a pack may never collide with it.
        fail(errors, `bot id '${b.id}' falls under the reserved "user." namespace`, entry);
      } else if (seenBots.has(b.id)) {
        fail(errors, `duplicate bot id '${b.id}'`, entry);
      } else {
        seenBots.add(b.id);
      }
      if (typeof b.name !== "string" || !b.name.trim() || b.name.length > 60) {
        fail(errors, "bot name must be a non-empty string of at most 60 characters", entry);
      }
      if (typeof b.generic !== "string" || !GENERIC_BOT_TYPE_NAMES.includes(b.generic)) {
        fail(errors, `bot '${b.id ?? i}' references generic type '${String(b.generic)}', which is not in the generic bot type set (${GENERIC_BOT_TYPE_NAMES.join(", ")})`, entry);
      }
      if (typeof b.description !== "string" || !b.description.trim() || b.description.length > 300) {
        fail(errors, "bot description must be a non-empty string of at most 300 characters", entry);
      }
      // The optional skill mount: at most one by shape (a single name), and it
      // must be a skill THIS pack declares — the mount is the pack wiring its
      // own content into the bot's session, never a foreign skill.
      if (b.skill !== undefined) {
        if (typeof b.skill !== "string" || !NAME_RE.test(b.skill)) {
          fail(errors, "bot skill mount must be a skill name matching [A-Za-z0-9._-], 1-64 chars", entry);
        } else if (!ownSkills.has(b.skill)) {
          fail(errors, `bot '${b.id}' mounts skill '${b.skill}', which the pack itself does not declare in skills`, entry);
        }
      }
    });
  }

  // Cluster metadata (agent-cluster-platform): optional cluster declaration that
  // groups pack agents into shareable agent clusters. Absent = the pack is not
  // a cluster template; present = the pack declares its agent composition as a
  // cluster with default and optional agents.
  if (manifest.cluster !== undefined) {
    const c = manifest.cluster;
    const centry = "cluster";
    if (!c || typeof c !== "object" || Array.isArray(c)) {
      fail(errors, "cluster must be an object of { name, description, defaultAgents, optionalAgents?, schedulingPolicy? }", centry);
    } else {
      for (const key of Object.keys(c)) {
        if (!CLUSTER_KEYS.includes(key)) {
          fail(errors, `cluster has unknown key '${key}' (only ${CLUSTER_KEYS.join(", ")})`, centry);
        }
      }
      // name is required, non-empty, at most 100 chars
      if (typeof c.name !== "string" || !c.name.trim() || c.name.length > limits.maxClusterNameChars) {
        fail(errors, `cluster.name must be a non-empty string of at most ${limits.maxClusterNameChars} characters`, `${centry}.name`);
      }
      // description is required, at most 500 chars (can be empty string?)
      if (typeof c.description !== "string" || c.description.length > limits.maxClusterDescriptionChars) {
        fail(errors, `cluster.description must be a string of at most ${limits.maxClusterDescriptionChars} characters`, `${centry}.description`);
      }
      // defaultAgents is required, non-empty array of valid agent ids
      if (c.defaultAgents === undefined) {
        fail(errors, "cluster.defaultAgents is required", `${centry}.defaultAgents`);
      } else if (!Array.isArray(c.defaultAgents) || c.defaultAgents.length === 0) {
        fail(errors, "cluster.defaultAgents must be a non-empty array", `${centry}.defaultAgents`);
      } else {
        const seenDefault = new Set();
        for (const agentId of c.defaultAgents) {
          if (typeof agentId !== "string" || !NAME_RE.test(agentId)) {
            fail(errors, "cluster.defaultAgents entries must match [A-Za-z0-9._-], 1-64 chars", `${centry}.defaultAgents`);
            break;
          } else if (seenDefault.has(agentId)) {
            fail(errors, `cluster.defaultAgents declares '${agentId}' twice`, `${centry}.defaultAgents`);
            break;
          } else {
            seenDefault.add(agentId);
          }
        }
        // Check all defaultAgents are declared in manifest.agents
        const agentIds = new Set((Array.isArray(agents) ? agents : []).map((a) => a?.id).filter((n) => typeof n === "string"));
        for (const agentId of c.defaultAgents) {
          if (!agentIds.has(agentId)) {
            fail(errors, `cluster.defaultAgents references '${agentId}', which is not declared in manifest.agents`, `${centry}.defaultAgents`);
          }
        }
      }
      // optionalAgents is optional, but if present must be array of valid agent ids
      if (c.optionalAgents !== undefined) {
        if (!Array.isArray(c.optionalAgents)) {
          fail(errors, "cluster.optionalAgents must be an array", `${centry}.optionalAgents`);
        } else {
          const seenOptionalLocal = new Set();
          for (const agentId of c.optionalAgents) {
            if (typeof agentId !== "string" || !NAME_RE.test(agentId)) {
              fail(errors, "cluster.optionalAgents entries must match [A-Za-z0-9._-], 1-64 chars", `${centry}.optionalAgents`);
              break;
            } else if (seenOptionalLocal.has(agentId)) {
              fail(errors, `cluster.optionalAgents declares '${agentId}' twice`, `${centry}.optionalAgents`);
              break;
            } else {
              seenOptionalLocal.add(agentId);
            }
          }
          // Check no duplicates between defaultAgents and optionalAgents
          // Rebuild seenDefault since it's scoped to the defaultAgents block
          const seenDefaultLocal = new Set(c.defaultAgents || []);
          for (const agentId of c.optionalAgents) {
            if (seenDefaultLocal.has(agentId)) {
              fail(errors, `cluster.optionalAgents contains '${agentId}' which is also in defaultAgents`, `${centry}.optionalAgents`);
            }
            const agentIds = new Set((Array.isArray(agents) ? agents : []).map((a) => a?.id).filter((n) => typeof n === "string"));
            if (!agentIds.has(agentId)) {
              fail(errors, `cluster.optionalAgents references '${agentId}', which is not declared in manifest.agents`, `${centry}.optionalAgents`);
            }
          }
        }
      }
      // schedulingPolicy is optional
      if (c.schedulingPolicy !== undefined) {
        const sp = c.schedulingPolicy;
        const spe = `${centry}.schedulingPolicy`;
        if (!sp || typeof sp !== "object" || Array.isArray(sp)) {
          fail(errors, "cluster.schedulingPolicy must be an object", spe);
        } else {
          for (const key of Object.keys(sp)) {
            if (!SCHEDULING_POLICY_KEYS.includes(key)) {
              fail(errors, `schedulingPolicy has unknown key '${key}' (only ${SCHEDULING_POLICY_KEYS.join(", ")})`, spe);
            }
          }
          // maxConcurrentRuns is optional, positive int <= 10
          if (sp.maxConcurrentRuns !== undefined) {
            if (!Number.isInteger(sp.maxConcurrentRuns) || sp.maxConcurrentRuns <= 0 || sp.maxConcurrentRuns > limits.maxClusterMaxConcurrentRuns) {
              fail(errors, `cluster.schedulingPolicy.maxConcurrentRuns must be a positive integer at most ${limits.maxClusterMaxConcurrentRuns}`, `${spe}.maxConcurrentRuns`);
            }
          }
          // preferredRunner is optional string
          if (sp.preferredRunner !== undefined && (typeof sp.preferredRunner !== "string" || !sp.preferredRunner.trim())) {
            fail(errors, "cluster.schedulingPolicy.preferredRunner must be a non-empty string when present", `${spe}.preferredRunner`);
          }
        }
      }
    }
  }

  // Facade profile (add-principal-facade): absent = an ordinary pack, every
  // rule above applies verbatim; present = the pack declares itself a
  // principal's conversational front door. Shape-strict like every other
  // block — this one function serves the publish prevalidation and the cell
  // install re-check, so the two can never disagree.
  if (manifest.facade !== undefined) {
    const f = manifest.facade;
    const fentry = "facade";
    if (!f || typeof f !== "object" || Array.isArray(f)) {
      fail(errors, "facade must be an object of { reception, corpus, delegation?, stance? }", fentry);
    } else {
      for (const key of Object.keys(f)) {
        if (!FACADE_KEYS.includes(key)) {
          fail(errors, `facade has unknown key '${key}' (only ${FACADE_KEYS.join(", ")})`, fentry);
        }
      }
      const declaredAgents = Array.isArray(agents) ? agents : [];
      const agentIds = new Set(declaredAgents.map((a) => a?.id).filter((n) => typeof n === "string"));
      // The reception role must be an agent of THIS pack carrying a serving
      // contract — a facade is reached through a deployed Agent Service.
      if (typeof f.reception !== "string" || !NAME_RE.test(f.reception)) {
        fail(errors, "facade.reception must be an agent id matching [A-Za-z0-9._-], 1-64 chars", `${fentry}.reception`);
      } else if (!agentIds.has(f.reception)) {
        fail(errors, `facade.reception references '${f.reception}', which is not declared in manifest.agents`, `${fentry}.reception`);
      } else if (!declaredAgents.some((a) => a?.id === f.reception && a.serving)) {
        fail(errors, `facade.reception '${f.reception}' must carry a serving contract (deployable as an Agent Service)`, `${fentry}.reception`);
      }
      // The corpus is the reception's curated knowledge: a non-empty subset
      // of the pack's OWN skills (versioned with the manifest, the as-of
      // honesty rides the version publish time downstream).
      if (!Array.isArray(f.corpus) || f.corpus.length === 0) {
        fail(errors, "facade.corpus must be a non-empty array of this pack's skill names", `${fentry}.corpus`);
      } else {
        const ownSkills = new Set(
          (Array.isArray(skills) ? skills : []).map((s) => s?.name).filter((n) => typeof n === "string"),
        );
        const seenCorpus = new Set();
        for (const name of f.corpus) {
          if (typeof name !== "string" || !NAME_RE.test(name)) {
            fail(errors, "facade.corpus entries must be skill names matching [A-Za-z0-9._-], 1-64 chars", `${fentry}.corpus`);
          } else if (seenCorpus.has(name)) {
            fail(errors, `facade.corpus declares '${name}' twice`, `${fentry}.corpus`);
          } else if (!ownSkills.has(name)) {
            fail(errors, `facade.corpus references '${name}', which the pack itself does not declare in skills`, `${fentry}.corpus`);
          } else {
            seenCorpus.add(name);
          }
        }
      }
      // The delegation list bounds the reception's specialist face: in-pack
      // roles or existing a2a target refs. Absent or empty = pure reception
      // (no delegation face at all).
      if (f.delegation !== undefined) {
        if (!Array.isArray(f.delegation) || f.delegation.length > limits.maxFacadeDelegations) {
          fail(errors, `facade.delegation must be an array of at most ${limits.maxFacadeDelegations} entries`, `${fentry}.delegation`);
        } else {
          const seenDel = new Set();
          f.delegation.forEach((d, j) => {
            const dentry = `${fentry}.delegation[${j}]`;
            if (!d || typeof d !== "object" || Array.isArray(d)) {
              fail(errors, "delegation entry must be an object of { kind, ref }", dentry);
              return;
            }
            for (const key of Object.keys(d)) {
              if (!FACADE_DELEGATION_KEYS.includes(key)) {
                fail(errors, `delegation entry has unknown key '${key}' (only ${FACADE_DELEGATION_KEYS.join(", ")})`, dentry);
              }
            }
            if (!FACADE_DELEGATION_KINDS.includes(d.kind)) {
              fail(errors, `delegation kind must be one of ${FACADE_DELEGATION_KINDS.join(", ")}`, dentry);
            } else if (typeof d.ref !== "string" || !(d.kind === "a2a" ? FACADE_A2A_REF_RE : NAME_RE).test(d.ref)) {
              fail(errors, `delegation ref must match ${d.kind === "a2a" ? "[A-Za-z0-9._:/-], 1-128 chars (market target ref)" : "[A-Za-z0-9._-], 1-64 chars (pack agent id)"}`, dentry);
            } else if (d.kind === "in-pack" && !agentIds.has(d.ref)) {
              fail(errors, `in-pack delegation references '${d.ref}', which is not declared in manifest.agents`, dentry);
            } else if (d.kind === "in-pack" && d.ref === f.reception) {
              fail(errors, "the reception role may not delegate to itself", dentry);
            } else {
              const dedup = `${d.kind}:${d.ref}`;
              if (seenDel.has(dedup)) {
                fail(errors, `delegation declares '${d.ref}' (${d.kind}) twice`, dentry);
              } else {
                seenDel.add(dedup);
              }
            }
          });
        }
      }
      // Billing stance (v1): hosted only — "my treat" on the chat lane's
      // existing waterfall; caller-pays is the A2A lane's native semantics
      // and needs no declaration. Other values are reserved for the
      // externalized era, not invented here.
      if (f.stance !== undefined && f.stance !== "hosted") {
        fail(errors, 'facade.stance must be "hosted" when present (v1)', `${fentry}.stance`);
      }
    }
  }

  // Locale overlay (add-pack-locale-tracks D1/D4): optional top-level i18n
  // block — secondary-language overrides of display fields. Absent = every
  // rule above applies verbatim and the manifest is byte-identical to the
  // pre-change form (strings are the zh main track).
  if (manifest.i18n !== undefined) {
    validateLocaleOverlay(manifest, errors, limits);
  }

  // Adopted provenance (add-official-adopted-agents D1): optional; shape only.
  validateProvenance(manifest, errors);

  // Display format v2 (overhaul-market-catalog-presentation 4.1): optional
  // structured display fields; an absent field changes nothing.
  validateDisplayFields(manifest, errors);

  // Connector bindings (add-connector-bindings D1): the pack's declaration of
  // which EXTERNAL systems it needs, at `(provider, operationType)` grain.
  // Validated here so publish and install agree, exactly like mcpServers.
  validateConnectorBindings(manifest, errors);

  const partCount = (Array.isArray(skills) ? skills.length : 0)
    + (Array.isArray(mcpServers) ? mcpServers.length : 0)
    + (Array.isArray(agents) ? agents.length : 0)
    + (Array.isArray(bots) ? bots.length : 0);
  if (partCount === 0) fail(errors, "a pack must contain at least one skill, MCP reference, agent, or bot", undefined, "pack_needs_one_reference");

  return errors;
}
