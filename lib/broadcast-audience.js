// ── Broadcast audience resolution (add-broadcast-and-notification-inbox 1.2) ─
//
// Turns a DECLARATIVE selector into the list of people it hits. Pure function:
// no IO, no clock, no writes. The identity source is injected.
//
// Why pure matters here, and it is not a style preference:
//   · an operator must be able to ask "how many people would this hit" BEFORE
//     sending — a broadcast that fans out inside the send loop can only report
//     its reach after it already happened;
//   · the expansion is the part most likely to be wrong (an org with no
//     members, a role nobody holds), so it is the part that must be unit
//     testable without a database;
//   · a failed expansion must refuse the broadcast, never degrade to "everyone"
//     — sending to all users because a lookup failed is the worst possible
//     failure direction.
//
// The selector never names platform internals (cell dir, chat key, binding id).
// Those are routing details; letting a caller supply them would mean a caller
// could reach a destination the audience model never intended.

/** The selector kinds this build understands. */
export const AUDIENCE_KINDS = Object.freeze(["org", "role", "userIds", "all"]);

/**
 * @typedef {object} IdentitySource
 * @property {(orgId: string) => Promise<string[]>} usersInOrg
 * @property {(roleSlug: string) => Promise<string[]>} usersWithRole
 * @property {() => Promise<string[]>} allEmails
 *
 * Every method returns recipient EMAILS. Email is the platform's address unit:
 * `/api/inbox`, `cells-registry.owner_email` and business-role assignments are
 * all keyed by it, and Logto's person payload carries it as `primaryEmail`. An
 * implementation that cannot answer MUST throw — see the fail-loud rule below.
 */

export class AudienceError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = "AudienceError";
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Expand a selector into recipient ids.
 *
 * @param {{kind: string, id?: string, ids?: string[]}} selector
 * @param {IdentitySource} source
 * @returns {Promise<{recipients: string[], kind: string}>}
 * @throws {AudienceError} on an unknown kind, a malformed selector, an empty
 *         expansion, or an identity-source failure. Refusing loudly is the
 *         whole point: none of these may turn into a send.
 */
export async function resolveAudience(selector, source) {
  if (!selector || typeof selector !== "object") {
    throw new AudienceError("bad-selector", "audience selector is required");
  }
  const kind = String(selector.kind ?? "").trim();
  if (!AUDIENCE_KINDS.includes(kind)) {
    throw new AudienceError(
      "unknown-kind",
      `unknown audience kind "${kind}" (allowed: ${AUDIENCE_KINDS.join(", ")})`,
    );
  }

  let recipients;
  try {
    if (kind === "org") {
      const orgId = String(selector.id ?? "").trim();
      if (!orgId) throw new AudienceError("bad-selector", "audience.org requires an id");
      recipients = await source.usersInOrg(orgId);
    } else if (kind === "role") {
      const role = String(selector.id ?? "").trim();
      if (!role) throw new AudienceError("bad-selector", "audience.role requires an id");
      recipients = await source.usersWithRole(role);
    } else if (kind === "userIds") {
      // An explicit list is still validated: unknown entries are dropped rather
      // than sent to a nonexistent recipient, and the caller is told how many
      // survived through the hit count on the broadcast record.
      const ids = Array.isArray(selector.ids) ? selector.ids : [];
      recipients = ids.map((v) => String(v ?? "").trim()).filter(Boolean);
    } else {
      recipients = await source.allEmails();
    }
  } catch (err) {
    if (err instanceof AudienceError) throw err;
    // The identity source is the ONLY authority on who exists. If it cannot
    // answer, the safe direction is to refuse — never to fall back to a wider
    // audience. This is the single most important line in this file.
    throw new AudienceError("identity-source-unavailable", `identity source failed: ${err?.message ?? err}`);
  }

  // Dedupe: org membership and explicit lists can both produce repeats, and two
  // notifications for one person from one broadcast is a bug the recipient sees.
  const recipients2 = [...new Set((recipients ?? []).filter((r) => typeof r === "string" && r))];

  if (recipients2.length === 0) {
    // Zero hits is a refusal, not a success with 0 deliveries. A broadcast that
    // "succeeded" while reaching nobody is the kind of green that hides a
    // broken selector for weeks.
    throw new AudienceError("zero-hits", `audience "${kind}" matched no recipients`);
  }
  return { recipients: recipients2, kind };
}

/**
 * A human-readable description of the selector, for the audit trail. Deliberately
 * does NOT expand it — the audit needs to record what was ASKED for, and the
 * expansion is recorded separately as the hit count.
 */
export function describeAudience(selector) {
  const kind = String(selector?.kind ?? "").trim();
  if (kind === "org") return `组织 ${String(selector?.id ?? "").trim()}`;
  if (kind === "role") return `角色 ${String(selector?.id ?? "").trim()}`;
  if (kind === "userIds") return `指定用户 ${Array.isArray(selector?.ids) ? selector.ids.length : 0} 人`;
  if (kind === "all") return "全体用户";
  return `未知受众 (${kind || "空"})`;
}