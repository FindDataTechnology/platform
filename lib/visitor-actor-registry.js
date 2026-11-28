// ── Visitor → actor registration (add-served-agent-connector-access D4) ─────
//
// A served (facade) agent's connector calls must run as the person on the other
// end of the conversation. The runner never learns who that is: the facade
// hashes the visitor's subject into a 32-hex `visitor_scope` and sends only
// that (constraint C2 — "the raw sub never travels to the serving plane").
// This module holds the single mapping the serving plane needs — scope → actor
// — for the life of a turn and nothing longer.
//
// Three states, deliberately distinct:
//
//   registered  the facade said WHO this scope is        → act as that actor
//   anonymous   the facade said "this scope has nobody"  → deployer fallback, stated out loud
//   missing     nobody said anything                     → the link is broken, fail closed
//
// Collapsing `missing` into `anonymous` is the one mistake that matters: it
// turns "the registration channel is down" into "run as the deployer", which is
// exactly the false success this change exists to remove. Likewise `anonymous`
// must never be inferred from an absent entry.
//
// Registrations are keyed by deployment as well as scope. A visitor's scope is
// derived from their subject alone, so the same person carries the same scope
// into every deployment they talk to; keying by deployment keeps one
// deployment's registration from answering for another's turn.

/** The facade's scope shape: sha256(...).slice(0, 32) — opaque, not a raw id. */
export const VISITOR_SCOPE_RE = /^[A-Za-z0-9_-]{16,64}$/;

/** Longest actor subject accepted. OIDC `sub` values are far shorter in practice. */
export const VISITOR_ACTOR_MAX = 200;

/**
 * How long a registration lives.
 *
 * A registration is refreshed at every turn start, so the TTL only has to
 * outlast ONE turn. It is set above the longest turn budget a deployment can
 * configure: expiring mid-turn would silently drop a live conversation into
 * `missing` (fail closed — correct, but a self-inflicted outage).
 */
export const DEFAULT_VISITOR_ACTOR_TTL_MS = 2 * 60 * 60_000;

/** Bound on distinct live registrations, so a broken caller cannot grow the map forever. */
export const DEFAULT_VISITOR_ACTOR_MAX_ENTRIES = 20_000;

export function isVisitorScope(value) {
  return typeof value === "string" && VISITOR_SCOPE_RE.test(value);
}

/**
 * The map key. `agentPath` disambiguates two deployments of the same
 * (pack, agent) pair — the same rule the matters route uses, and for the same
 * reason: (pack, agent) alone is ambiguous across deployers.
 */
export function visitorActorKey({ packId, agentId, agentPath = "", scope }) {
  return [String(packId ?? ""), String(agentId ?? ""), String(agentPath ?? ""), String(scope ?? "")].join("\u0000");
}

export function createVisitorActorRegistry({
  ttlMs = DEFAULT_VISITOR_ACTOR_TTL_MS,
  maxEntries = DEFAULT_VISITOR_ACTOR_MAX_ENTRIES,
  now = () => Date.now(),
} = {}) {
  /** scope-key → { actor: string | null, expiresAt: number } */
  const rows = new Map();

  const sweep = (at) => {
    for (const [key, row] of rows) {
      if (row.expiresAt <= at) rows.delete(key);
    }
  };

  return {
    /**
     * Record (or refresh) who a scope is.
     *
     * `actor: null` is a positive statement — "this visitor has no identity" —
     * and is stored as such. It is never equivalent to not calling this at all.
     *
     * @returns {{ok: true} | {ok: false, code: string}}
     */
    register({ packId, agentId, agentPath = "", scope, actor }) {
      if (!packId || !agentId) return { ok: false, code: "deployment_identity_required" };
      if (!isVisitorScope(scope)) return { ok: false, code: "invalid_scope" };
      if (actor !== null && actor !== undefined) {
        if (typeof actor !== "string") return { ok: false, code: "invalid_actor" };
        const trimmed = actor.trim();
        if (!trimmed) return { ok: false, code: "invalid_actor" };
        if (trimmed.length > VISITOR_ACTOR_MAX) return { ok: false, code: "invalid_actor" };
        actor = trimmed;
      } else {
        actor = null;
      }

      const at = now();
      // Re-inserting moves the key to the end of Map order, which is what the
      // eviction rule below reads as "most recently touched".
      const key = visitorActorKey({ packId, agentId, agentPath, scope });
      rows.delete(key);
      if (rows.size >= maxEntries) {
        sweep(at);
        if (rows.size >= maxEntries) {
          const oldest = rows.keys().next();
          if (!oldest.done) rows.delete(oldest.value);
        }
      }
      rows.set(key, { actor, expiresAt: at + ttlMs });
      return { ok: true };
    },

    /**
     * Who is this scope, for this deployment, right now?
     *
     * @returns {{state: "registered", actor: string} | {state: "anonymous"} | {state: "missing"}}
     */
    lookup({ packId, agentId, agentPath = "", scope }) {
      const key = visitorActorKey({ packId, agentId, agentPath, scope });
      const row = rows.get(key);
      if (!row) return { state: "missing" };
      if (row.expiresAt <= now()) {
        rows.delete(key);
        return { state: "missing" };
      }
      return row.actor === null ? { state: "anonymous" } : { state: "registered", actor: row.actor };
    },

    /** Drop one registration (turn end, when the facade can say so). */
    forget({ packId, agentId, agentPath = "", scope }) {
      rows.delete(visitorActorKey({ packId, agentId, agentPath, scope }));
    },

    /** Test/ops visibility only — never a lookup path. */
    get size() {
      return rows.size;
    },
  };
}

/**
 * The process-wide registry.
 *
 * One gateway process serves every runner, so one map answers every mediated
 * call. Routes and services take an optional override (tests inject their own);
 * production reads this.
 */
export const sharedVisitorActors = createVisitorActorRegistry();
