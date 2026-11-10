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
const PROFILE_KEYS = new Set(["memory", "collections"]);
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
          message: "knowledge must be an object of { memory?, collections? } (or omitted entirely for the defaults)",
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
        message: `knowledge.${key} is not a known knowledge-profile key (known: memory, collections)`,
      });
    }
  }

  const profile = defaultProfile();

  // ── memory ────────────────────────────────────────────────────────────────
  // memory is wholesale in the merge contract, but internally each field is
  // validated on its own and missing fields fall back to the defaults — so a
  // partial `memory: { budget: 800 }` still yields a complete, prompt-ready
  // memory config.
  if (raw.memory !== undefined && raw.memory !== null) {
    const m = raw.memory;
    if (typeof m !== "object" || Array.isArray(m)) {
      errors.push({
        path: "memory",
        code: "memory_invalid",
        message: "knowledge.memory must be an object of { enabled?, scope?, budget? }",
      });
    } else {
      for (const key of Object.keys(m)) {
        if (!MEMORY_KEYS.has(key)) {
          errors.push({
            path: `memory.${key}`,
            code: "unknown_key",
            message: `knowledge.memory.${key} is not a known memory key (known: enabled, scope, budget)`,
          });
        }
      }
      if (m.enabled !== undefined) {
        if (typeof m.enabled !== "boolean") {
          errors.push({ path: "memory.enabled", code: "memory_enabled_invalid", message: "knowledge.memory.enabled must be a boolean" });
        } else {
          profile.memory.enabled = m.enabled;
        }
      }
      if (m.scope !== undefined) {
        if (!KNOWLEDGE_SCOPE_VALUES.includes(m.scope)) {
          errors.push({
            path: "memory.scope",
            code: "memory_scope_invalid",
            message: `knowledge.memory.scope must be one of ${KNOWLEDGE_SCOPE_VALUES.join(", ")}`,
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
            path: "memory.budget",
            code: "memory_budget_invalid",
            message: `knowledge.memory.budget must be an integer between ${KNOWLEDGE_BUDGET_MIN} and ${KNOWLEDGE_BUDGET_MAX} (the fd-memory digest clamp)`,
          });
        } else {
          profile.memory.budget = m.budget;
        }
      }
    }
  }

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
  return {
    ok: true,
    profile: {
      memory: mentioned("memory") ? override.profile.memory : base.profile.memory,
      collections: mentioned("collections") ? override.profile.collections : base.profile.collections,
    },
  };
}
