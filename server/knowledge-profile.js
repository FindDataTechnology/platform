// Member knowledge profile (add-member-knowledge-profile) — pure module.
//
// Zero IO, zero DB: everything here is a pure function over plain objects.
// The blueprint author declares a cell-level default, the deployment may
// override it, and the runtime effective profile is computed by deep-ish
// merge below. DB resolution (does `library:<id>` exist and is it visible to
// this deployment?) stays behind an injected `resolveCollection` callback —
// the same seam blueprint-validate.js uses for dataSources (resolveLibrary),
// so the storage layer can wire both from one DB-backed check.
//
// 为什么纯函数：同一份 normalize 同时服务蓝图校验面（错误要逐字段指名）与
// 运行时装配面（要一个可直接落库/落 prompt 的干净画像）——两个消费方必须
// 对「什么合法」零分歧，唯一办法就是同一份代码。IO 一旦混进来，校验面就
// 会在存储抖动时误拒蓝图。

// Scope vocabulary (exported so callers build UI/enums off it instead of
// re-typing strings): own+shared = the member reads its own memory plus the
// fleet's shared memory; shared = shared only; off = memory surface closed.
//
// `own` (own-only) is NOT offered, and the reason is measured rather than
// stylistic: `@finddatatechnology/yongyi-client`'s readDigest branches only on
// `scope === "own+shared"`, so any other value skips the own-partition probe and
// still reads shared. A declared `own` would therefore read MORE than it says —
// a silent wrong reading, which is worse than a loud refusal. Adding it needs an
// own-only branch in the client first; until then the enum stops short.
export const KNOWLEDGE_SCOPE_VALUES = ["own+shared", "shared", "off"];

// Documented defaults. A member with NO knowledge declaration behaves exactly
// like this — 缺省即默认，作者不写不报错. budget=1200 sits under the fd-memory
// /digest server-side clamp (2000), leaving deployments room to raise without
// tripping the upstream ceiling.
export const KNOWLEDGE_DEFAULTS = {
  memory: { enabled: true, scope: "own+shared", budget: 1200 },
  collections: [],
};

// Same shape contract as LIBRARY_REF_RE in blueprint-validate.js: a knowledge
// collection pinned by logical id. Kept as a literal here (not imported) so
// this module stays dependency-free; the two must stay in sync — a ref valid
// in one place but not the other would make validation and resolution disagree.
const COLLECTION_REF_RE = /^library:([A-Za-z0-9_-]{1,64})$/;

// Budget bounds: 64 floors out degenerate "0 tokens" configs that would starve
// the digest into noise; 2000 mirrors the fd-memory /digest server clamp, so a
// profile that passes here never needs silent re-clamping downstream.
export const KNOWLEDGE_BUDGET_MIN = 64;
export const KNOWLEDGE_BUDGET_MAX = 2000;

// Known top-level and memory-level keys. Closed on purpose: a typo'd key
// (e.g. `memory.budgt`) that silently did nothing is worse than a loud
// rejection — same 零第二造 discipline as the v1-dialect gate.
//
// `read` (add-pack-memory-declaration) is the four-axis vocabulary's name for
// the axis `memory` has always meant. Both spellings are accepted because the
// existing one is in packs, blueprints and UI copy; they must AGREE when both
// are present, and a disagreement is rejected rather than resolved by picking
// one — picking one silently is how "the same word meant two things" happened in
// the first place.
const PROFILE_KEYS = new Set(["memory", "read", "collections"]);
const MEMORY_KEYS = new Set(["enabled", "scope", "budget"]);

// Fresh-copy the defaults: callers (and the DB layer that will persist the
// effective profile) must never receive a reference into this module's
// constants — one mutation there would poison every later normalize(null).
function defaultProfile() {
  return { memory: { ...KNOWLEDGE_DEFAULTS.memory }, collections: [] };
}

/**
 * Validate + normalize a knowledge profile declaration.
 *
 * @param {*} raw - the declared profile, or null/undefined (= defaults).
 * @param {{ resolveCollection?: (id: string) => boolean | string }} [opts]
 *   resolveCollection: injected visibility check. true = visible, string =
 *   why not (surfaced verbatim), false = dangling/invisible. When absent,
 *   only the SHAPE is checked — no collection is refused for being unknown.
 * @returns {{ ok: true, profile } | { ok: false, errors: Array<{path, code, message}> }}
 *   profile is canonical: `{ memory: { enabled, scope, budget }, collections: ["library:<id>", …] }`.
 *
 * Error codes:
 *   profile_invalid        raw is present but not a plain object
 *   unknown_key            key outside the closed shape (top level or memory)
 *   memory_invalid         memory is present but not a plain object
 *   memory_enabled_invalid memory.enabled not a boolean
 *   memory_scope_invalid   memory.scope not in KNOWLEDGE_SCOPE_VALUES
 *   memory_budget_invalid  memory.budget not an integer in 64..2000
 *   collections_invalid   collections present but not an array
 *   collection_ref_invalid element not matching `library:<id>` shape
 *   collection_unresolved  resolver refused the id (invisible/dangling), named
 */
export function normalizeKnowledgeProfile(raw, { resolveCollection } = {}) {
  // 缺省即默认：absent declaration is the common case for blueprints written
  // before this change — it must stay legal and mean the defaults, not an error.
  if (raw === undefined || raw === null) return { ok: true, profile: defaultProfile() };

  const errors = [];
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      errors: [
        {
          path: "",
          code: "profile_invalid",
          message: "knowledge must be an object of { memory?, read?, collections? } (or omitted entirely for the defaults)",
        },
      ],
    };
  }

  // Closed top-level shape: name every unknown key, keep scanning the rest so
  // one report shows ALL the problems (author fixes them in one round trip).
  for (const key of Object.keys(raw)) {
    if (!PROFILE_KEYS.has(key)) {
      errors.push({
        path: key,
        code: "unknown_key",
        message: `knowledge.${key} is not a known knowledge-profile key (known: memory, read, collections)`,
      });
    }
  }

  const profile = defaultProfile();

  // ── memory / read (the same axis, two spellings) ──────────────────────────
  // `memory` is wholesale in the merge contract, but internally each field is
  // validated on its own and missing fields fall back to the defaults — so a
  // partial `memory: { budget: 800 }` still yields a complete, prompt-ready
  // memory config.
  //
  // `read` is an alias of the same axis. Resolution order (add-pack-memory-
  // declaration D2): validate each spelling on its own, compare where both
  // speak, reject on disagreement, and take the union where only one speaks.
  const segments = [];
  for (const spelling of ["memory", "read"]) {
    const rawSegment = raw[spelling];
    if (rawSegment === undefined || rawSegment === null) continue;
    if (typeof rawSegment !== "object" || Array.isArray(rawSegment)) {
      errors.push({
        path: spelling,
        code: spelling === "memory" ? "memory_invalid" : "read_invalid",
        message: `knowledge.${spelling} must be an object of { enabled?, scope?, budget? }`,
      });
      continue;
    }
    for (const key of Object.keys(rawSegment)) {
      if (!MEMORY_KEYS.has(key)) {
        errors.push({
          path: `${spelling}.${key}`,
          code: "unknown_key",
          message: `knowledge.${spelling}.${key} is not a known ${spelling} key (known: enabled, scope, budget)`,
        });
      }
    }
    segments.push({ spelling, raw: rawSegment });
  }

  if (segments.length === 2) {
    // Both spellings present: every key both of them mention must agree. A
    // disagreement is a conflict, not a precedence question.
    const [a, b] = segments;
    for (const key of MEMORY_KEYS) {
      if (a.raw[key] === undefined || b.raw[key] === undefined) continue;
      if (a.raw[key] !== b.raw[key]) {
        errors.push({
          path: `${b.spelling}.${key}`,
          code: "read_memory_conflict",
          message: `knowledge.${a.spelling}.${key} is ${JSON.stringify(a.raw[key])} but knowledge.${b.spelling}.${key} is ${JSON.stringify(b.raw[key])}; they name the same axis and must agree (keep one)`,
        });
      }
    }
  }

  for (const { spelling, raw: m } of segments) {
    if (m.enabled !== undefined) {
      if (typeof m.enabled !== "boolean") {
        errors.push({ path: `${spelling}.enabled`, code: "memory_enabled_invalid", message: `knowledge.${spelling}.enabled must be a boolean` });
      } else {
        profile.memory.enabled = m.enabled;
      }
    }
    if (m.scope !== undefined) {
      if (!KNOWLEDGE_SCOPE_VALUES.includes(m.scope)) {
        errors.push({
          path: `${spelling}.scope`,
          code: "memory_scope_invalid",
          message: `knowledge.${spelling}.scope must be one of ${KNOWLEDGE_SCOPE_VALUES.join(", ")}`,
        });
      } else {
        profile.memory.scope = m.scope;
      }
    }
    if (m.budget !== undefined) {
      // Integer only: a fractional budget would either floor silently
      // somewhere downstream or round inconsistently across consumers.
      if (!Number.isInteger(m.budget) || m.budget < KNOWLEDGE_BUDGET_MIN || m.budget > KNOWLEDGE_BUDGET_MAX) {
        errors.push({
          path: `${spelling}.budget`,
          code: "memory_budget_invalid",
          message: `knowledge.${spelling}.budget must be an integer between ${KNOWLEDGE_BUDGET_MIN} and ${KNOWLEDGE_BUDGET_MAX} (the fd-memory digest clamp)`,
        });
      } else {
        profile.memory.budget = m.budget;
      }
    }
  }

  // One switch, one verdict (add-pack-memory-declaration): `enabled` and
  // `scope` could disagree — enabled=true with scope=off, or enabled=false with
  // scope=own+shared — which is exactly the two-switches-one-verdict trap. The
  // canonical profile keeps them consistent, resolving any disagreement to OFF:
  // that is the stricter reading, and it is what every consumer already did with
  // the value it happened to check first.
  if (profile.memory.enabled === false) profile.memory.scope = "off";
  if (profile.memory.scope === "off") profile.memory.enabled = false;

  // ── collections ───────────────────────────────────────────────────────────
  if (raw.collections !== undefined && raw.collections !== null) {
    if (!Array.isArray(raw.collections)) {
      errors.push({
        path: "collections",
        code: "collections_invalid",
        message: "knowledge.collections must be an array of knowledge-collection refs (library:<id>)",
      });
    } else {
      raw.collections.forEach((entry, i) => {
        const match = typeof entry === "string" ? entry.match(COLLECTION_REF_RE) : null;
        if (!match) {
          errors.push({
            path: `collections[${i}]`,
            code: "collection_ref_invalid",
            message: `knowledge.collections[${i}] '${entry}' must be a knowledge-collection ref of the form library:<id> (1-64 chars of letters, digits, _ or -)`,
          });
          return;
        }
        // Resolution is BY NAME (悬空引用指名拒绝): when the caller can check
        // visibility, an invisible/dangling id names itself and the reason.
        // Without a resolver this module is shape-only — it must not guess
        // whether an id exists, that's the DB-backed caller's fact.
        if (typeof resolveCollection === "function") {
          const verdict = resolveCollection(match[1]);
          if (verdict !== true) {
            errors.push({
              path: `collections[${i}]`,
              code: "collection_unresolved",
              message: `knowledge.collections[${i}] 'library:${match[1]}' does not name a collection you can see${typeof verdict === "string" ? ` (${verdict})` : ""}`,
            });
            return;
          }
        }
        profile.collections.push(`library:${match[1]}`);
      });
    }
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, profile };
}

/**
 * Merge the cell-level default with the deployment-level override.
 *
 * Merge contract (整体替换, not deep-merge):
 *   - Both sides are normalized first (WITHOUT resolveCollection — this is a
 *     pure function; visibility is re-checked by whoever owns the DB).
 *   - A top-level key PRESENT in the override replaces the base segment
 *     wholesale: `memory` does not deep-merge, `collections` does not concat.
 *     Fields the override's memory omits fall back to PLATFORM defaults via
 *     normalize, never to the cell's — a deployment override is a complete
 *     statement about the segments it mentions, so it can always tighten but
 *     never silently depends on a half-remembered cell state.
 *   - Keys the override never mentions inherit the base (which may itself be
 *     the platform defaults when the cell declares nothing).
 *   - An explicit `null` segment counts as present and resets that segment to
 *     platform defaults (same semantics as normalize(null)).
 *
 * @returns {{ ok: true, profile } | { ok: false, errors }}
 */
export function effectiveProfile(cellDefault, deploymentOverride) {
  const base = normalizeKnowledgeProfile(cellDefault ?? null);
  if (!base.ok) return base;
  // No override at all: the cell default (or the platform default) IS the
  // effective profile — the common deployment, stated explicitly here so the
  // merge path below can assume an override object exists.
  if (deploymentOverride === undefined || deploymentOverride === null) {
    return { ok: true, profile: base.profile };
  }
  const override = normalizeKnowledgeProfile(deploymentOverride);
  if (!override.ok) return { ok: false, errors: override.errors };
  const mentioned = (key) =>
    deploymentOverride !== null && typeof deploymentOverride === "object" && Object.hasOwn(deploymentOverride, key) && deploymentOverride[key] !== undefined;
  // Either spelling mentions the read axis; a deployment writing `read` intends
  // to override what a cell wrote as `memory`.
  const mentionsRead = mentioned("memory") || mentioned("read");
  return {
    ok: true,
    profile: {
      memory: mentionsRead ? override.profile.memory : base.profile.memory,
      collections: mentioned("collections") ? override.profile.collections : base.profile.collections,
    },
  };
}

//: Sub-keys of the read axis this version has a consumer for. Both are consumed
//: by the fleet-context injection ladder, so both are true. The other three axes
//: (store / write / process) are declared on the pack and executed by the memory
//: service; listing them here would report a value nobody in paas reads.
export const EXECUTED_READ_KEYS = Object.freeze(["scope", "budget"]);

/**
 * Describe the read axis with the four columns an operator needs to catch
 * "declared but not in force" without reading code:
 *
 *   declared        what a level actually wrote (null when nobody wrote it)
 *   inherited_from  which level supplied the effective value
 *   effective       the value in force after canonicalization
 *   executed        whether this version has a consumer for that sub-key
 *
 * `declared` is read from the RAW segments, not the normalized profile, for the
 * same reason the root change reports it separately: a default-filled value must
 * never look like a declaration.
 *
 * Chain, most specific first — the words differ from the root spec but the order
 * maps onto it exactly:
 *
 *   agentMemory      the pack's per-role declaration   (root: "agent")
 *   deploymentOverride the operator's fleet setting     (root: "team")
 *   cellDefault      the blueprint/pack author default  (root: "deployment default")
 *   platform         the built-in default
 *
 * Two different merge rules meet here and are NOT harmonized:
 *   · the agent level inherits PER KEY (a role declaring only `budget` keeps the
 *     inherited `scope`);
 *   · the knowledge segment replaces WHOLESALE (an override that mentions the
 *     segment drops the inner one entirely — see effectiveProfile).
 * The table reports both honestly: a key the wholesale winner omitted falls to
 * the platform default and, if an inner level had declared it, the row says
 * `shadowed_by` instead of pretending the inner value is in force.
 */
export function describeKnowledgeProfile({
  agentMemory = null,
  cellDefault = null,
  deploymentOverride = null,
} = {}) {
  const effective = effectiveProfile(cellDefault, deploymentOverride);
  if (!effective.ok) return effective;

  const readRaw = (raw) => {
    if (!raw || typeof raw !== "object") return null;
    const segment = raw.read !== undefined && raw.read !== null ? raw.read : raw.memory;
    return segment && typeof segment === "object" && !Array.isArray(segment) ? segment : null;
  };
  // An agent may literally write `memory: { read: {…} }` (the four-axis block) or
  // the segment directly; both mean the same thing.
  const agentSegment = readRaw(agentMemory) ?? (readRaw({ memory: agentMemory }) ?? null);
  const deploymentSegment = readRaw(deploymentOverride);
  const cellSegment = readRaw(cellDefault);
  const levels = [
    ["agent", agentSegment],
    ["deployment", deploymentSegment],
    ["cell", cellSegment],
  ];

  // Which segment won the axis? effectiveProfile replaces the whole segment when
  // the deployment mentions it, so a key the winner omitted is NOT inherited from
  // the cell — it falls to the platform default. That is a materially different
  // answer from the root change's per-key inheritance, and it is the one that
  // actually runs here, so the table reports it instead of hiding it.
  //
  // The agent level sits ABOVE the wholesale pair and inherits per key, so it is
  // not a participant in that replacement: a role's declaration always wins the
  // keys it names, and the effective value shown is the agent's when it has one.
  const winner = deploymentSegment ? "deployment" : cellSegment ? "cell" : null;

  const rows = {};
  for (const key of EXECUTED_READ_KEYS) {
    let declared = null;
    let source = null;
    for (const [label, segment] of levels) {
      if (segment && segment[key] !== undefined) {
        declared = segment[key];
        source = label;
        break;
      }
    }
    const agentValue = agentSegment ? agentSegment[key] : undefined;
    const row = {
      declared,
      inherited_from: source ?? "platform",
      effective: agentValue !== undefined ? agentValue : effective.profile.memory[key],
      executed: true,
    };
    // A declaration that a wholesale replacement discarded is exactly the case an
    // operator would otherwise never see: the cell's value is written down, the
    // deployment's segment is in force, and the cell's key is simply gone.
    if (declared !== null && source !== "agent" && winner !== null && source !== winner) {
      row.shadowed_by = winner;
      row.inherited_from = "platform";
    }
    rows[`read.${key}`] = row;
  }
  return { ok: true, profile: effective.profile, rows };
}
