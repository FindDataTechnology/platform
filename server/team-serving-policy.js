// server/team-serving-policy.js — the one decision function for a team call
// (openspec: add-team-as-a2a-agent, 2.3–2.4).
//
// Everything about "may this call proceed" lives in ONE pure function returning
// a code from ONE closed set. That is what keeps the error surface honest: a
// route that re-derives its own refusals grows a different answer per endpoint,
// and `internal_error` starts covering reasons that were perfectly decidable.
//
// The matrix is pinned by tests/test-team-serving-policy.mjs, cell by cell
// (visibility × caller × quota), and a source scan asserts no module invents a
// code outside SERVING_ERROR_CODES.
//
// Red line from the spec: a refusal MUST NOT leak team internals. `detail` is
// therefore limited to the quota FIELD that ran out (a published number, the
// caller already knows it) — never a prompt, a member, a key, or a structure.

/** The closed set. Nothing outside this may reach a caller. */
export const SERVING_ERROR_CODES = Object.freeze([
  "unauthorized",
  "not_found",
  "not_listed",
  "needs_approval",
  "quota_exceeded",
  "depth_exceeded",
  "no_reception",
  "team_paused",
  // Gateway-side (add-team-as-a2a-agent 6.3): the target cell has no team a2a
  // door at all (an older image). A distinct code, because the caller's next
  // step differs from every other refusal: retry later / use another team.
  "not_serving",
  "internal_error",
]);

/** Quota fields, in the order the card prints them. */
export const QUOTA_FIELDS = Object.freeze(["calls", "tokens", "usd"]);

/** HTTP status per code — one mapping, so endpoints cannot drift. */
export const SERVING_HTTP_STATUS = Object.freeze({
  unauthorized: 401,
  not_found: 404,
  not_listed: 403,
  needs_approval: 403,
  quota_exceeded: 429,
  depth_exceeded: 400,
  no_reception: 409,
  team_paused: 409,
  not_serving: 503,
  internal_error: 500,
});

/** Readable, diagnostic English. The UI maps `code` to localized copy. */
const MESSAGES = Object.freeze({
  unauthorized: "Caller identity could not be resolved",
  not_found: "Team not found",
  not_listed: "This caller is not on the team's allow-list",
  needs_approval: "The team owner must approve this caller first",
  quota_exceeded: "Daily quota exhausted",
  depth_exceeded: "Delegation depth limit reached",
  no_reception: "This team has not declared a reception post",
  team_paused: "This team is paused",
  not_serving: "This deployment cannot serve team calls yet",
  internal_error: "Internal error",
});

export function servingError(code, extra = {}) {
  if (!SERVING_ERROR_CODES.includes(code)) {
    // A code outside the set is a programming error; still never leak it as an
    // invented value — degrade to the honest generic refusal.
    return { ok: false, code: "internal_error", message: MESSAGES.internal_error, ...extra };
  }
  return { ok: false, code, message: MESSAGES[code], ...extra };
}

function quotaExhausted(quota, usage) {
  if (!quota) return null;
  const used = usage ?? {};
  if (Number.isFinite(quota.callsPerDay) && (used.calls ?? 0) >= quota.callsPerDay) return "calls";
  if (Number.isFinite(quota.tokensPerDay) && (used.tokens ?? 0) >= quota.tokensPerDay) return "tokens";
  if (Number.isFinite(quota.usdPerDay) && (used.usd ?? 0) >= quota.usdPerDay) return "usd";
  return null;
}

/**
 * @param {object} input
 * @param {object|null} input.publication the publication row (null = nothing published)
 * @param {{subject?: string}|null} input.caller resolved caller (null = unresolved)
 * @param {string} [input.fleetState] "active" | "paused" | "archived"
 * @param {string} [input.ownerEmail] the team owner (publication.publishedBy)
 * @param {{calls?:number,tokens?:number,usd?:number}} [input.usage] today's counters
 * @param {Array<{subject:string, expiresAt?:number|null}>} [input.approvals]
 * @param {number} [input.depth] inbound delegation depth (0/absent = a human)
 * @param {number} [input.maxDepth] the deployment's bound
 * @param {() => number} [input.now]
 * @returns {{ok:true} | {ok:false, code:string, message:string, detail?:object}}
 */
export function decideServing(input) {
  const {
    publication,
    caller,
    fleetState = "active",
    ownerEmail,
    usage,
    approvals = [],
    depth = 0,
    maxDepth = Number.POSITIVE_INFINITY,
    now = () => Date.now(),
  } = input ?? {};

  // 1. Nothing published, and `private` — SAME answer. A directory that
  //    distinguishes them is an existence oracle (spec: 未发布/已撤回/private 同形).
  if (!publication || publication.visibility === "private") return servingError("not_found");

  // 2. An archived team is as good as gone; a paused one is paused. Two
  //    different facts, two different codes — the caller's next step differs.
  if (fleetState === "archived") return servingError("not_found");
  if (fleetState !== "active") return servingError("team_paused");

  // 3. Identity AFTER existence/paused: a stranger learns nothing about the
  //    team before proving who they are, but an authenticated caller learns
  //    why their own call was refused.
  if (!caller?.subject) return servingError("unauthorized");

  // 4. The entry point must be declared, or the team cannot be called at all.
  if (!publication.reception) return servingError("no_reception");

  // 5. Authorization. The owner is never gated by their own allow-list — they
  //    are the party paying for it.
  const isOwner = !!ownerEmail && caller.subject === ownerEmail;
  if (!isOwner) {
    const allowed = Array.isArray(publication.callers) && publication.callers.includes(caller.subject);
    if (!allowed) {
      if (publication.visibility === "open") {
        // An empty (or non-matching) allow-list means NOBODY can call — the
        // spec explicitly forbids reading empty as "everyone".
        return servingError("not_listed");
      }
      const approved = approvals.some(
        (a) => a && a.subject === caller.subject && (a.expiresAt == null || a.expiresAt > now()),
      );
      if (!approved) return servingError("needs_approval");
    }
  }

  // 6. Depth before quota: a chain that is too deep is not allowed to spend the
  //    team's budget just to be refused one step later.
  if (Number.isFinite(maxDepth) && depth >= maxDepth) {
    return servingError("depth_exceeded", { detail: { max: maxDepth } });
  }

  // 7. Quota. The field that ran out is published on the card, so naming it
  //    leaks nothing.
  const exhausted = quotaExhausted(publication.quota, usage);
  if (exhausted) return servingError("quota_exceeded", { detail: { field: exhausted } });

  return { ok: true };
}

/** The natural-day reset instant the card and the call response both report. */
export function quotaResetAt(now = Date.now()) {
  const d = new Date(now);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
  return next;
}
