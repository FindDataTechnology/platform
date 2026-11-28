// ── Agent authorization policy (openspec: add-personal-staff-fleet 3b.2/3c.1)
//
// Authorization around agents is a POLICY, not a constant. Two decisions that
// used to be hard-coded are now configurable, resolved through the deployment's
// usual chain (deployment_config key → env → default):
//
//   auditorMayReadDeputyQueue  — may an auditor READ the fleet's deputy decision
//                                queue? It was allowed by the tool-face whitelist
//                                but refused at runtime by `deputyGuard` (403),
//                                so the two口径 disagreed. Default TRUE: reading
//                                a queue is not acting on it, and an auditor that
//                                can see what is pending does better review.
//                                Reading never implies resolving — `decision_resolve`
//                                keeps its own guard, unconditionally.
//
//   delegateMode              — "async" (default) or "sync". `delegate_task` used
//                                to block the initiator's turn on a receipt that
//                                could never arrive: the cell has ONE serial slot
//                                (task-engine.js:917) and both the initiator and
//                                the delegated manual round need it. "async"
//                                returns as soon as the round is queued; "sync"
//                                keeps the old blocking contract for deployments
//                                that want it.
//
//   summonAutoAccept          — does a 一键召唤 admit its LOCAL (persona/auditor)
//                                seats immediately, or leave a pending invite the
//                                owner must accept one by one? Default TRUE:
//                                pressing "召唤" IS the approval, and six posts
//                                meant six extra clicks (2026-11-24, user report).
//                                Market (a2a) seats are unaffected — they keep
//                                the pending handshake (an outside deployment's
//                                deployer is not the summoner).
//
// Dataclass: both values are read at call time (not cached), so flipping them
// takes effect on the next round without a restart.

const KEYS = {
  auditorMayReadDeputyQueue: "agent.policy.auditor_may_read_deputy_queue",
  delegateMode: "agent.policy.delegate_mode",
  summonAutoAccept: "agent.policy.summon_auto_accept",
};

function readConfig(db, key) {
  // `deployment_config` lives on the CELL database. Callers may pass either
  // handle (the fleet DB does not expose it), so an absent reader simply means
  // "nothing stored" and resolution falls through to the env seed.
  try {
    const reader = db?.getDeploymentConfig;
    if (typeof reader !== "function") return null;
    return reader.call(db, key) ?? null;
  } catch {
    return null;
  }
}

const envOf = (name) => {
  const v = process.env[name];
  return v === undefined || v === null || String(v).trim() === "" ? null : String(v).trim();
};

/** True unless explicitly turned off. Reading a queue is not acting on it. */
export function auditorMayReadDeputyQueue(db = null) {
  const raw = readConfig(db, KEYS.auditorMayReadDeputyQueue) ?? envOf("AGENT_AUDITOR_READ_DEPUTY_QUEUE");
  if (raw === null) return true;
  return !["0", "false", "off", "no"].includes(String(raw).toLowerCase());
}

/**
 * "async" | "sync". Anything unrecognised falls back to "async" — the safe
 * direction, because "sync" is the shape that deadlocks on a single slot.
 */
export function delegateMode(db = null) {
  const raw = readConfig(db, KEYS.delegateMode) ?? envOf("AGENT_DELEGATE_MODE");
  const v = raw === null ? "" : String(raw).toLowerCase();
  return v === "sync" ? "sync" : "async";
}

/**
 * Should a summon's LOCAL (persona/auditor) invites be admitted on the spot
 * instead of left pending?
 *
 * The owner pressed "召唤" — asking them to press "接受" once per post is a
 * question they already answered. Default TRUE for local seats; market (a2a)
 * seats keep the pending handshake, because the party being seated is an
 * outside deployment whose deployer is not the summoner.
 *
 * `targetKind` is what splits the two, so "auto-accept summons" stays ONE
 * configurable decision rather than a hard-coded rule per seat kind.
 */
export function summonAutoAccept(db = null) {
  const raw = readConfig(db, KEYS.summonAutoAccept) ?? envOf("AGENT_SUMMON_AUTO_ACCEPT");
  if (raw === null) return true;
  return !["0", "false", "off", "no"].includes(String(raw).toLowerCase());
}

/** Read-only view for the status surface, so an operator can see the policy. */
export function authorizationPolicy(db = null) {
  return {
    auditorMayReadDeputyQueue: auditorMayReadDeputyQueue(db),
    delegateMode: delegateMode(db),
    summonAutoAccept: summonAutoAccept(db),
  };
}

export const AUTHORIZATION_POLICY_KEYS = KEYS;
