// server/caller-identity.js — the identity adapter layer for team endpoints
// (openspec: add-team-as-a2a-agent, 2.1–2.2).
//
// Why an adapter layer at all: phase 1 has exactly one caller kind (a platform
// session), and phase 2 adds registry credentials. Writing `if (session)` now
// and a second `if (registryToken)` later is how a fallback gets discovered in
// production — so the shape from day one is a REGISTRY: each adapter either
// claims a request and answers, or stays out of it, and the fall-through is a
// structured `unauthorized` with NO default identity.
//
// The red line from the spec ("MUST NOT 回落到团队主人、部署身份、匿名或任何服务
// 身份"): there is deliberately no `?? owner`, no `?? "system"`, no catch-all
// branch that returns a caller. `resolve()` can only ever return `{ok:true}`
// from inside an adapter that explicitly claimed the request. The test proves
// it by construction (an empty registry must resolve to ok:false, not to a
// default) as well as by scanning this file for fallback idioms.

/** The closed set of identity failure reasons (diagnostics only, never shown raw). */
export const IDENTITY_FAILURES = Object.freeze(["missing", "malformed", "invalid_or_expired", "no_adapter"]);

export const CALLER_KINDS = Object.freeze(["session", "registry"]);

const UNAUTHORIZED = Object.freeze({ ok: false, code: "unauthorized" });

/**
 * @param {object} deps
 * @param {Array<{id: string, kind: string, resolve: (input: object) => (null | {ok: boolean, caller?: object, reason?: string})>} | undefined} deps.adapters
 */
export function createCallerIdentity({ adapters = [] } = {}) {
  const list = adapters.filter((a) => a && typeof a.resolve === "function");

  return {
    /** Adapter ids in registration order — the only set that can ever authenticate. */
    ids: list.map((a) => a.id),

    /**
     * Resolve the caller. `session` is the already-resolved platform identity
     * (the route's own middleware), `headers` the raw request headers for
     * credentials that carry their own proof.
     *
     * Returns `{ok:true, caller, adapter}` or `{ok:false, code:"unauthorized", reason}`.
     * Never throws: an adapter that throws is a rejected credential, not a 500.
     */
    async resolve({ headers = {}, session = null } = {}) {
      for (const adapter of list) {
        let out;
        try {
          out = await adapter.resolve({ headers, session });
        } catch {
          // An adapter blowing up must not fabricate an identity.
          out = { ok: false, reason: "invalid_or_expired" };
        }
        // `null` = "not my credential, try the next adapter".
        if (out == null) continue;
        if (!out.ok) {
          return { ...UNAUTHORIZED, reason: out.reason ?? "invalid_or_expired", adapter: adapter.id };
        }
        if (!out.caller?.subject) {
          // A claiming adapter that produced no subject is a bug, not a pass.
          return { ...UNAUTHORIZED, reason: "malformed", adapter: adapter.id };
        }
        return { ok: true, caller: out.caller, adapter: adapter.id };
      }
      return { ...UNAUTHORIZED, reason: "no_adapter" };
    },
  };
}

/**
 * Phase 1's only adapter: a platform session.
 *
 * `resolveSession({headers})` is injected because the two topologies resolve a
 * session differently (the gateway from a Logto cookie or an app/mini-program
 * Bearer; a cell from its own middleware). Injecting it keeps this module
 * dependency-free and lets the test drive every failure shape without minting
 * tokens.
 */
export function sessionAdapter({ resolveSession }) {
  return {
    id: "platform-session",
    kind: "session",
    resolve({ headers, session }) {
      // The route already resolved a session (its middleware ran): reuse it
      // rather than re-deriving from headers — one resolution per request.
      if (session?.email) {
        return { ok: true, caller: { kind: "session", subject: String(session.email), groups: session.groups ?? [] } };
      }
      const auth = headers?.authorization;
      if (auth === undefined && !headers?.cookie) return { ok: false, reason: "missing" };
      if (typeof auth === "string" && auth.length > 0 && !/^Bearer\s+\S+/i.test(auth)) {
        // A credential of the wrong shape is not "no credential" — say so.
        return { ok: false, reason: "malformed" };
      }
      const user = typeof resolveSession === "function" ? resolveSession({ headers }) : null;
      if (!user?.email) return { ok: false, reason: "invalid_or_expired" };
      return { ok: true, caller: { kind: "session", subject: String(user.email), groups: user.groups ?? [] } };
    },
  };
}

/** Build the phase-1 registry in one call (the route's only construction path). */
export function createPlatformCallerIdentity({ resolveSession }) {
  return createCallerIdentity({ adapters: [sessionAdapter({ resolveSession })] });
}
