// ── Memory declaration (openspec: add-pack-memory-declaration) ──────────────
//
// A pack may declare how its team remembers things:
//
//   "memory": {
//     "store":   { "home": "member" },
//     "read":    { "scope": "own+shared", "budget": 1200 },
//     "write":   { "authority": "shared" },
//     "process": { "distill": "on", "promote_after": 3, "cold_after_days": 90 }
//   }
//
// Four axes because they answer four different questions, and because they used
// to share one name: this repo shipped `memory_scope` (write authority) into a
// host key whose value domain is a storage location, and the host rejected every
// such definition. A single field cannot carry all four without inviting that
// mistake back.
//
// Two rules that are NOT ordinary shape checks:
//
//   · `store.home` is an ENUM, never an address. A pack is a distributable
//     artifact; letting it name a root key or a path would let it write into
//     someone else's store. Addresses get their own code so the refusal reads as
//     a boundary, not a typo.
//   · `knowledge.memory` and `memory.read` are the same axis under two names, so
//     they must AGREE. A disagreement is refused instead of resolved by picking
//     one — picking one silently is exactly how the same word came to mean two
//     things in three places.
//
// This module is pure and imports nothing: it is enforced by the publish gate
// (gateway process, no cell state) and by the cell's install gate, and the two
// must never disagree about what a declaration means.
//
// Inheritance is NOT resolved here. The four-axis vocabulary and its resolver
// live in the repository root's add-agent-memory-declaration
// (fd-agent-graph/memory_decl.py and fd-memory/src/policy.ts, compared by a
// shared fixture). Adding a third implementation would guarantee a third answer.

/** The four axes. Closed set: an unknown axis is named, never ignored. */
export const MEMORY_AXES = Object.freeze(["store", "read", "write", "process"]);

/** Keys allowed per axis. Closed for the same reason. */
export const MEMORY_AXIS_KEYS = Object.freeze({
  store: Object.freeze(["home"]),
  read: Object.freeze(["scope", "budget"]),
  write: Object.freeze(["authority"]),
  process: Object.freeze(["distill", "promote_after", "cold_after_days"]),
});

/**
 * Storage granularity. `member` = this team's per-member partition, `fleet` =
 * the team's shared partition, `person` = the owner's person root. The enum maps
 * to a namespace through identity at materialization time — never through a
 * string a pack wrote.
 */
export const STORE_HOMES = Object.freeze(["fleet", "member", "person"]);

/** Read visibility. Mirrors KNOWLEDGE_SCOPE_VALUES in server/knowledge-profile.js. */
export const READ_SCOPES = Object.freeze(["own+shared", "shared", "off"]);

/** Write authority: is this role's conclusion authoritative for others? */
export const WRITE_AUTHORITIES = Object.freeze(["private", "shared"]);

/** Processor switch. `inherit` keeps climbing the chain. */
export const DISTILL_VALUES = Object.freeze(["on", "off", "inherit"]);

/** Same bounds as the read face: the memory service clamps at 2000. */
export const MEMORY_BUDGET_MIN = 64;
export const MEMORY_BUDGET_MAX = 2000;

/**
 * Shapes that mean "an address". Checked BEFORE the enum so the error can
 * explain the rule instead of just listing three allowed words.
 */
const ADDRESS_HINT = /(\/|\\|:\/\/|^[du]-|\.sqlite\b|\.db\b)/;

const isPlainObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/**
 * Keys an AGENT's `memory` block may carry beyond the four axes.
 *
 * `guidance` predates this change (add-agent-self-iteration): a ≤600-char prose
 * constitution of what the role records, composed into the persona tail. It is
 * not an axis — it answers "what do I write down", while `write.authority`
 * answers "does my conclusion count for others" — so it lives beside the axes
 * rather than inside one. Refusing it here would break every pack that already
 * declares it, which is the one thing this change promised not to do.
 *
 * Deliberately agent-only: a pack-level `memory.guidance` has no consumer, and
 * accepting a key nothing reads is how a declaration becomes decoration.
 */
export const AGENT_MEMORY_EXTRA_KEYS = Object.freeze(["guidance"]);

/**
 * Validate one four-axis block.
 *
 * @param {unknown} raw         the declared block, or null/undefined (= none)
 * @param {string} at           path prefix for errors ("memory" or "agents[2].memory")
 * @param {{extraKeys?: readonly string[]}} [options]  keys allowed beside the axes
 * @returns {{error: string, path?: string, code: string}[]}
 */
export function validateMemoryBlock(raw, at = "memory", { extraKeys = [] } = {}) {
  if (raw === undefined || raw === null) return [];
  if (!isPlainObject(raw)) {
    return [{ error: `${at} must be an object of ${MEMORY_AXES.join(", ")} (or omitted entirely)`, path: at, code: "memory_not_object" }];
  }

  const errors = [];
  for (const [axis, value] of Object.entries(raw)) {
    const axisPath = `${at}.${axis}`;
    if (extraKeys.includes(axis)) continue;
    if (!MEMORY_AXES.includes(axis)) {
      errors.push({
        error: `${axisPath} is not a memory axis (known: ${[...MEMORY_AXES, ...extraKeys].join(", ")})`,
        path: axisPath,
        code: "memory_axis_unknown",
      });
      continue;
    }
    if (!isPlainObject(value)) {
      errors.push({
        error: `${axisPath} must be an object of ${MEMORY_AXIS_KEYS[axis].join(", ")}`,
        path: axisPath,
        code: "memory_axis_invalid",
      });
      continue;
    }
    for (const [key, sub] of Object.entries(value)) {
      const path = `${axisPath}.${key}`;
      if (!MEMORY_AXIS_KEYS[axis].includes(key)) {
        errors.push({
          error: `${path} is not a known ${axis} key (known: ${MEMORY_AXIS_KEYS[axis].join(", ")})`,
          path,
          code: "memory_key_unknown",
        });
        continue;
      }
      const failure = checkValue(axis, key, sub, path);
      if (failure) errors.push(failure);
    }
  }
  return errors;
}

function checkValue(axis, key, value, path) {
  if (axis === "store" && key === "home") {
    if (typeof value !== "string") {
      return { error: `${path} must be one of ${STORE_HOMES.join(", ")}`, path, code: "store_home_invalid" };
    }
    if (!STORE_HOMES.includes(value) && ADDRESS_HINT.test(value)) {
      return {
        error: `${path} = ${JSON.stringify(value)} looks like an address; a declaration may only name which store (${STORE_HOMES.join(", ")}). The namespace is resolved from identity, because a distributable pack that can name an address can write into someone else's store`,
        path,
        code: "store_home_addressed",
      };
    }
    if (!STORE_HOMES.includes(value)) {
      return { error: `${path} must be one of ${STORE_HOMES.join(", ")} (got ${JSON.stringify(value)})`, path, code: "store_home_invalid" };
    }
    return null;
  }

  if (axis === "read" && key === "scope") {
    if (!READ_SCOPES.includes(value)) {
      // `own` reads as a real option and is refused for a measured reason, so it
      // says so instead of hiding behind "unknown value".
      if (value === "own") {
        return {
          error: `${path} = 'own' has no consumer that executes it (the read face only distinguishes 'own+shared'), so it would read shared too — more than declared; use one of ${READ_SCOPES.join(", ")}`,
          path,
          code: "read_scope_unexecutable",
        };
      }
      return { error: `${path} must be one of ${READ_SCOPES.join(", ")}`, path, code: "read_scope_invalid" };
    }
    return null;
  }

  if (axis === "read" && key === "budget") {
    if (!Number.isInteger(value) || value < MEMORY_BUDGET_MIN || value > MEMORY_BUDGET_MAX) {
      return {
        error: `${path} must be an integer in ${MEMORY_BUDGET_MIN}..${MEMORY_BUDGET_MAX} (got ${JSON.stringify(value)}); an out-of-range budget is refused rather than clamped, because a silent clamp makes the declared value and the effective one differ`,
        path,
        code: "read_budget_invalid",
      };
    }
    return null;
  }

  if (axis === "write" && key === "authority") {
    if (!WRITE_AUTHORITIES.includes(value)) {
      return {
        error: `${path} must be one of ${WRITE_AUTHORITIES.join(", ")} — this is write authority, not a storage location (locations live on store.home)`,
        path,
        code: "write_authority_invalid",
      };
    }
    return null;
  }

  if (axis === "process" && key === "distill") {
    if (!DISTILL_VALUES.includes(value)) {
      return { error: `${path} must be one of ${DISTILL_VALUES.join(", ")}`, path, code: "process_distill_invalid" };
    }
    return null;
  }

  if (axis === "process" && key === "promote_after") {
    if (!Number.isInteger(value) || value < 1) {
      return { error: `${path} must be an integer >= 1`, path, code: "process_promote_after_invalid" };
    }
    return null;
  }

  if (axis === "process" && key === "cold_after_days") {
    if (!Number.isInteger(value) || value < 0) {
      return { error: `${path} must be an integer >= 0 (0 = never cold-store)`, path, code: "process_cold_after_days_invalid" };
    }
    return null;
  }

  return { error: `${path} is not a known key`, path, code: "memory_key_unknown" };
}

/**
 * Validate one agent entry's memory declaration together with its shorthand.
 *
 * `memory_scope` (private|shared) is the legacy spelling of
 * `memory.write.authority`. Both are accepted; when both are given they must
 * agree, and each is normalized onto the other so downstream readers see one
 * field.
 *
 * @param {unknown} memory      the agent's `memory` block (optional)
 * @param {unknown} memoryScope the agent's `memory_scope` string (optional)
 * @param {string} at           path prefix for errors
 */
export function validateAgentMemory(memory, memoryScope, at = "memory") {
  // `guidance` rides along: it is the pre-existing prose constitution, not an
  // axis, and refusing it would break every pack that already declares it.
  const errors = validateMemoryBlock(memory, at, { extraKeys: AGENT_MEMORY_EXTRA_KEYS });
  const scope = typeof memoryScope === "string" ? memoryScope.trim() : "";

  if (memoryScope !== undefined && memoryScope !== null && typeof memoryScope !== "string") {
    errors.push({ error: `${at} shorthand memory_scope must be a string`, path: at, code: "memory_scope_invalid" });
    return errors;
  }
  if (scope && !WRITE_AUTHORITIES.includes(scope)) {
    errors.push({
      error: `memory_scope must be one of ${WRITE_AUTHORITIES.join(", ")}`,
      path: at.replace(/\.memory$/, ".memory_scope"),
      code: "memory_scope_invalid",
    });
    return errors;
  }
  if (scope && isPlainObject(memory) && isPlainObject(memory.write) && memory.write.authority !== undefined) {
    if (memory.write.authority !== scope) {
      errors.push({
        error: `memory_scope is ${JSON.stringify(scope)} but ${at}.write.authority is ${JSON.stringify(memory.write.authority)}; they name the same axis and must agree (keep one)`,
        path: `${at}.write.authority`,
        code: "memory_authority_conflict",
      });
    }
  }
  return errors;
}

// ── the four-column read face (openspec: add-pack-memory-declaration 3.3) ───
//
// One row per sub-key, four columns:
//
//   declared        what a LEVEL wrote (null when every level stayed silent)
//   inherited_from  which level supplied the effective value
//   effective       the value in force
//   executed        whether this version has a consumer for that sub-key
//
// The last column is the whole point: `process.cold_after_days` resolves to a
// number and NOTHING acts on it, so a reader must not be told cold storage is in
// force. Resolving to a value and being honoured are different facts.
//
// The algorithm is copied from the root change's memory_decl.resolve_effective
// on purpose rather than invented here — paas is the third implementation and the
// shared fixture (fd-memory/fixtures/memory-policy-cases.json) is the contract.
// The parity gate runs THIS function against that fixture, so a local
// "improvement" to the resolution order turns the gate red instead of silently
// making the pack preview and the memory service disagree.

/** Every sub-key, in axis order. Closed set: an unknown one is refused. */
export const MEMORY_SUBKEYS = Object.freeze([
  "store.home",
  "read.scope",
  "read.budget",
  "write.authority",
  "process.distill",
  "process.promote_after",
  "process.cold_after_days",
]);

/**
 * Where an undeclared axis lands when nothing in the chain sets it. Mirrors
 * PLATFORM_DEFAULTS in the root module; no `write.authority` default exists
 * because "whose conclusion counts" is not a question a platform answers for an
 * agent.
 */
export const PLATFORM_MEMORY_DEFAULTS = Object.freeze({
  store: Object.freeze({ home: "fleet" }),
  read: Object.freeze({ scope: "own+shared", budget: 1200 }),
  write: Object.freeze({}),
  process: Object.freeze({ distill: "on", promote_after: 3, cold_after_days: 0 }),
});

/**
 * Sub-keys this version has a consumer for.
 *
 * `store`/`read`/`write` are consumed by injection and host reconciliation;
 * `distill` is consumed by the memory service's scheduler once the team's policy
 * row is written. `promote_after` has no per-page evidence counter to threshold
 * and `cold_after_days` has no eviction pass, so both are declared, resolved and
 * reported as NOT executed rather than wired to a nearby-looking field.
 */
export const EXECUTED_MEMORY_SUBKEYS = Object.freeze(
  new Set(["store.home", "read.scope", "read.budget", "write.authority", "process.distill"]),
);

const isDecl = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/**
 * Resolve an inheritance chain into one row per sub-key.
 *
 * @param {Array<[string, object]>} levels most-specific first — each
 *   `[label, declaration]` where declaration is a four-axis block (may be partial
 *   and unvalidated; this function only reads what is there).
 * @param {{deploymentDefaults?: object}} [options] `deploymentDefaults` is NOT a
 *   level: it fills `effective` without ever becoming anyone's `declared` value,
 *   because a deployment default is not a declaration.
 * @returns {Record<string, {declared: *, inherited_from: string|null, effective: *, executed: boolean}>}
 */
export function memoryRows(levels = [], { deploymentDefaults = {} } = {}) {
  const defaults = isDecl(deploymentDefaults) ? deploymentDefaults : {};
  const rows = {};
  for (const sub of MEMORY_SUBKEYS) {
    const [axis, key] = sub.split(".");
    let declared = null;
    for (const [, declaration] of levels) {
      const segment = isDecl(declaration) ? declaration[axis] : null;
      if (isDecl(segment) && segment[key] !== undefined) {
        declared = segment[key];
        break;
      }
    }
    let effective = null;
    let source = null;
    for (const [label, declaration] of levels) {
      const segment = isDecl(declaration) ? declaration[axis] : null;
      const value = isDecl(segment) ? segment[key] : undefined;
      // `inherit` is not a value — it is an instruction to keep looking upward.
      if (value === undefined || value === null) continue;
      if (axis === "process" && key === "distill" && value === "inherit") continue;
      effective = value;
      source = label;
      break;
    }
    if (effective === null) {
      const depSegment = isDecl(defaults[axis]) ? defaults[axis] : null;
      const depValue = isDecl(depSegment) ? depSegment[key] : undefined;
      // `null` is "no opinion", not "the value null" — the reference
      // implementation (memory_decl.resolve_effective) skips `None` here, and a
      // default that resolved to null would stop the platform fallback from
      // running, i.e. the same input would yield a different effective value in
      // paas than in the memory service.
      if (depValue !== undefined && depValue !== null) {
        effective = depValue;
        source = "deployment";
      } else {
        const platformSegment = PLATFORM_MEMORY_DEFAULTS[axis];
        const platformValue = platformSegment ? platformSegment[key] : undefined;
        if (platformValue !== undefined) {
          effective = platformValue;
          source = "platform";
        }
      }
    }
    rows[sub] = { declared, inherited_from: source, effective, executed: EXECUTED_MEMORY_SUBKEYS.has(sub) };
  }
  return rows;
}

/**
 * Sub-keys someone DECLARED that nothing will act on.
 *
 * Filtered to declared values on purpose: every row's `executed` flag already
 * tells the truth about every key, including ones resolving from a default. This
 * list is the actionable subset — "you asked for this and no code does it" — so it
 * stays empty until someone declares something this version cannot honour.
 */
export function unexecutedMemory(rows) {
  return MEMORY_SUBKEYS.filter((sub) => rows[sub] && rows[sub].declared !== null && !rows[sub].executed);
}

/**
 * The two spellings of the read axis must agree where both speak.
 *
 * Lives here rather than in the knowledge-profile module because it is a
 * CROSS-FIELD rule of the pack manifest: `knowledge.memory` is one segment and
 * `memory.read` is another, and only a caller holding both can compare them.
 * Keys only one side mentions are not conflicts — they are the normal case of a
 * pack that migrated one key at a time.
 *
 * @param {unknown} knowledgeMemory the `knowledge.memory` segment (optional)
 * @param {unknown} memoryRead      the `memory.read` axis (optional)
 */
export function checkReadSpellingAgreement(knowledgeMemory, memoryRead) {
  const a = isPlainObject(knowledgeMemory) ? knowledgeMemory : null;
  const b = isPlainObject(memoryRead) ? memoryRead : null;
  if (!a || !b) return [];
  const errors = [];
  // `enabled: false` and `scope: "off"` say the same thing, so map before
  // comparing — otherwise a pack writing both legitimately looks like a conflict.
  const readScope = (seg) => (seg.enabled === false ? "off" : seg.scope);
  if (a.enabled !== undefined && b.scope !== undefined && (a.enabled === false) !== (b.scope === "off")) {
    errors.push({
      error: `knowledge.memory.enabled is ${JSON.stringify(a.enabled)} but memory.read.scope is ${JSON.stringify(b.scope)}; they name the same switch and must agree`,
      path: "memory.read.scope",
      code: "read_memory_conflict",
    });
  } else if (a.scope !== undefined && b.scope !== undefined && readScope(a) !== readScope(b)) {
    errors.push({
      error: `knowledge.memory.scope is ${JSON.stringify(a.scope)} but memory.read.scope is ${JSON.stringify(b.scope)}; they name the same axis and must agree (keep one)`,
      path: "memory.read.scope",
      code: "read_memory_conflict",
    });
  }
  if (a.budget !== undefined && b.budget !== undefined && a.budget !== b.budget) {
    errors.push({
      error: `knowledge.memory.budget is ${JSON.stringify(a.budget)} but memory.read.budget is ${JSON.stringify(b.budget)}; they name the same axis and must agree (keep one)`,
      path: "memory.read.budget",
      code: "read_memory_conflict",
    });
  }
  return errors;
}
