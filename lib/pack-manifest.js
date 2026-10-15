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

// Design D11 defaults; callers may override via env for ops/testing.
// Turn budget cap (add-serving-budgets D1): the platform's ceiling on a
// serving contract's declared per-turn duration.
export const BUDGET_MAX_MINUTES = 120;

export const PACK_LIMITS = {
  maxSkills: 10,
  maxSkillBodyChars: 64 * 1024,
  maxAgents: 3,
  maxMcpRefs: 5,
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
};

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

// Keys a pack MCP entry must NOT carry — anything endpoint- or command-shaped
// would break the v1 security boundary.
const MCP_FORBIDDEN_KEYS = ["url", "command", "args", "env", "headers", "config", "configTemplate"];

// Keys a pack agent entry must NOT carry — pack agents are local personas,
// never a forwarded endpoint.
const AGENT_FORBIDDEN_KEYS = ["baseUrl", "model", "apiKey", "apiKeyEnv", "local", "url"];

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
const SERVING_KEYS = ["protocol", "card", "rhythm", "budget", "workspace", "model", "modelWhitelist", "harness"];
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

function fail(errors, error, entry) {
  errors.push(entry ? { error, entry } : { error });
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

// Validate a pack manifest. Returns an array of { error, entry? } — empty
// means valid. `entry` names the offending item so the editor can point at it.
export function validatePackManifest(manifest, limits = PACK_LIMITS) {
  const errors = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return [{ error: "manifest must be an object" }];
  }

  const name = manifest.name;
  if (typeof name !== "string" || !name.trim() || name.trim().length > limits.maxNameChars) {
    fail(errors, `name must be a non-empty string of at most ${limits.maxNameChars} characters`);
  }

  if (manifest.description != null && (typeof manifest.description !== "string" || manifest.description.length > limits.maxDescriptionChars)) {
    fail(errors, `description must be a string of at most ${limits.maxDescriptionChars} characters`);
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
    fail(errors, `skills must be an array of at most ${limits.maxSkills} entries`);
  } else {
    const seen = new Set();
    skills.forEach((s, i) => {
      const entry = `skills[${i}]`;
      if (!s || typeof s !== "object") {
        fail(errors, "skill entry must be an object", entry);
        return;
      }
      if (typeof s.name !== "string" || !NAME_RE.test(s.name)) {
        fail(errors, "skill name must match [A-Za-z0-9._-], 1-64 chars", entry);
      } else if (seen.has(s.name)) {
        fail(errors, `duplicate skill name '${s.name}'`, entry);
      } else {
        seen.add(s.name);
      }
      if (typeof s.description !== "string" || !s.description.trim() || s.description.length > 300) {
        fail(errors, "skill description must be a non-empty string of at most 300 characters", entry);
      }
      if (typeof s.content !== "string" || !s.content.trim() || s.content.length > limits.maxSkillBodyChars) {
        fail(errors, `skill content must be a non-empty string of at most ${limits.maxSkillBodyChars} characters`, entry);
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
    fail(errors, `mcpServers must be an array of at most ${limits.maxMcpRefs} entries`);
  } else {
    mcpServers.forEach((m, i) => {
      const entry = `mcpServers[${i}]`;
      if (!m || typeof m !== "object") {
        fail(errors, "MCP entry must be an object", entry);
        return;
      }
      const forbidden = MCP_FORBIDDEN_KEYS.filter((k) => m[k] !== undefined);
      if (forbidden.length > 0) {
        fail(errors, `MCP entries may only reference registry servers (found forbidden key(s): ${forbidden.join(", ")})`, entry);
        return;
      }
      if (typeof m.registryName !== "string" || !NAME_RE.test(m.registryName)) {
        fail(errors, "MCP entry needs a registryName matching [A-Za-z0-9._-], 1-64 chars", entry);
      }
      // Tool allowlist (add-mcp-tool-scoping D3): names-only narrowing of this
      // reference — a declaration, never configuration. Absent = the server's
      // full tool surface (the pre-change behavior); present-but-empty is a
      // no-op declaration and rejected like every other empty filter here.
      if (m.allowTools !== undefined) {
        if (!Array.isArray(m.allowTools) || m.allowTools.length === 0 || m.allowTools.length > limits.maxToolsPerMcp) {
          fail(errors, `allowTools must be a non-empty array of at most ${limits.maxToolsPerMcp} tool leaf names`, entry);
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
    });
  }

  const agents = manifest.agents ?? [];
  if (!Array.isArray(agents) || agents.length > limits.maxAgents) {
    fail(errors, `agents must be an array of at most ${limits.maxAgents} entries`);
  } else {
    const seen = new Set();
    agents.forEach((a, i) => {
      const entry = `agents[${i}]`;
      if (!a || typeof a !== "object") {
        fail(errors, "agent entry must be an object", entry);
        return;
      }
      const forbidden = AGENT_FORBIDDEN_KEYS.filter((k) => a[k] !== undefined);
      if (forbidden.length > 0) {
        fail(errors, `agent entries are persona-only (found forbidden key(s): ${forbidden.join(", ")})`, entry);
        return;
      }
      if (typeof a.id !== "string" || !NAME_RE.test(a.id)) {
        fail(errors, "agent id must match [A-Za-z0-9._-], 1-64 chars", entry);
      } else if (a.id.startsWith("user.")) {
        // Reserved namespace (add-custom-presets D6): ids under `user.` belong
        // to the cell's server-assigned custom presets — a pack may never
        // collide with one going forward (installs additionally skip via the
        // foreign-owner backstop for ids that predate this rule).
        fail(errors, `agent id '${a.id}' falls under the reserved "user." namespace (custom presets)`, entry);
      } else if (seen.has(a.id)) {
        fail(errors, `duplicate agent id '${a.id}'`, entry);
      } else {
        seen.add(a.id);
      }
      if (typeof a.name !== "string" || !a.name.trim() || a.name.length > 60) {
        fail(errors, "agent name must be a non-empty string of at most 60 characters", entry);
      }
      if (typeof a.persona !== "string" || !a.persona.trim() || a.persona.length > limits.maxPersonaChars) {
        fail(errors, `agent persona must be a non-empty string of at most ${limits.maxPersonaChars} characters`, entry);
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

  const partCount = (Array.isArray(skills) ? skills.length : 0)
    + (Array.isArray(mcpServers) ? mcpServers.length : 0)
    + (Array.isArray(agents) ? agents.length : 0);
  if (partCount === 0) fail(errors, "a pack must contain at least one skill, MCP reference, or agent");

  return errors;
}
