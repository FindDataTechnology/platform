// ── Team roster: the org chart a pack declares (openspec: team-derivation) ──
//
// ONE derivation, many surfaces — the same rule `lib/pack-pillars.js` follows
// for an agent's three pillars, applied to a TEAM's composition.
//
// What this is NOT: a fourth pillar. Pillars answer "what does this agent
// remember / wield / show"; this answers "how is this team staffed". They read
// the same manifest at different levels, and the roster REFERS to each post's
// pillar projection — it never recomputes memory, tools, or console. A test
// asserts `deriveTeam()` returns no toolkit/memory value fields at all, so a
// later implementer cannot quietly fold pillars in here.
//
// Why a separate module instead of extending derivePillars: a pillar consumer
// would then have to understand staffing, and every surface that renders three
// pillars would carry roster data it does not use. Two derivations, two
// consumers, one manifest.
//
// The export gap this closes (2026-11-18): a `category: fleet` pack exported to
// Claude Code / WorkBuddy delivered its skills, MCP entries and memory wiring,
// but `fleet.members`, each member's `cadence`, its `kpiSlots`, and the
// orchestration edges vanished — the user installed "a pile of roles" instead of
// "a team". 33 fleet packs (100 posts) had this structure and no surface could
// read it.

export const ROSTER_STATE = Object.freeze({
  /** The pack declares `fleet.members` and they read cleanly. */
  PRESENT: "present",
  /** The pack carries no `fleet` block at all — it is not a team. */
  UNDECLARED: "undeclared",
  /** It declares a roster but the host has no instance of it (no team built). */
  NOT_INSTANTIATED: "not-instantiated",
  /** The declaration is malformed — `errors` names every path. */
  INVALID: "invalid",
});

const isObj = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const asArray = (v) => (Array.isArray(v) ? v : []);

function text(v) {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

// ── one post ───────────────────────────────────────────────────────────────

// A roster row is a POINTER to the post's pillar projection plus the staffing
// facts. `pillarsRef` is deliberately an identity, not a copy: the pillar
// derivation owns those values and this module must not become a second source
// of them.
function deriveRow(member, index, errors, path) {
  const ref = text(member?.ref) ?? text(member?.title) ?? `#${index}`;
  const target = isObj(member?.target) ? member.target : null;
  if (!target) errors.push(`${path}[${index}] '${ref}' 缺 target（岗位没指向任何执行体）`);

  const kind = text(target?.kind);
  const presetId = text(target?.presetId);
  const packId = text(target?.packId);

  // Cadence: absent is a legitimate answer for some posts (an auditor is driven
  // by the decision queue, not a clock — see fleet-packs' E6 gate). So a missing
  // cadence is recorded as `declared: false`, never invented.
  const cad = isObj(member?.cadence) ? member.cadence : null;
  const cadence = cad && text(cad.cron)
    ? { declared: true, cron: text(cad.cron), tz: text(cad.tz), turnTimeoutMs: cad.turnTimeoutMs ?? null }
    : { declared: false };

  // KPI slots: the declared keys are the contract a report is scored against.
  // An empty array is an explicit "this post reports no counters"; a missing
  // key is a declaration gap the publish gate refuses (fleet-roster-hygiene).
  const rawSlots = member?.kpiSlots;
  const slots = asArray(rawSlots)
    .filter(isObj)
    .map((s) => ({ key: text(s.key), label: text(s.label) ?? null, unit: text(s.unit) ?? null }))
    .filter((s) => s.key);
  if (rawSlots === undefined) {
    errors.push(`${path}[${index}] '${ref}' 缺 kpiSlots（无量可报要显式登记空集并附理由）`);
  }

  return {
    ref,
    title: text(member?.title) ?? ref,
    parentRef: text(member?.parentRef),
    target: { kind, presetId, packId },
    // The pointer: the post's pillar projection lives in derivePillars(manifest,
    // { agentId: presetId }). Consumers pair the two; neither copies the other.
    pillarsRef: presetId ? { agentId: presetId, packId } : null,
    cadence,
    kpiSlots: slots,
    kpiSlotsDeclared: rawSlots !== undefined,
  };
}

// ── edges ──────────────────────────────────────────────────────────────────

// Orchestration edges are facts about who triggers/dispatches/hands off to whom.
// They are returned verbatim (kind + from/to) — NOT reordered or expanded. A
// surface that re-derived them from parentRef would disagree with the manifest
// the moment a fleet declares an edge the tree does not imply.
function deriveEdges(manifest, errors, path) {
  const orch = isObj(manifest?.fleet?.orchestration) ? manifest.fleet.orchestration : null;
  return asArray(orch?.edges)
    .filter(isObj)
    .map((e, i) => {
      const kind = text(e.kind);
      if (!kind) errors.push(`${path}.edges[${i}] 缺 kind`);
      return { kind, from: text(e.from) ?? null, to: text(e.to) ?? null };
    });
}

// ── acceptance ─────────────────────────────────────────────────────────────

// Acceptance assertions are part of what was released (fleet-team-release: the
// release object is a unit). They are surfaced as contract-level facts (kind +
// target), never with the free-text rubric — that stays behind the release面.
function deriveAcceptance(manifest) {
  return asArray(manifest?.acceptance)
    .filter(isObj)
    .map((a, i) => ({
      id: text(a.id) ?? `a${i + 1}`,
      kind: text(a.kind),
      target: text(a.target),
      expect: typeof a.expect === "number" ? a.expect : null,
    }))
    .filter((a) => a.kind);
}

// ── the derivation ─────────────────────────────────────────────────────────

/**
 * Derive a team's composition from a pack manifest.
 *
 * Pure: same manifest in, same object out. Reads no install state, no database,
 * no local config — a caller can run it on a manifest fetched from anywhere.
 *
 * @param {object} manifest  a pack manifest (published or draft)
 * @param {object} [opts]
 * @param {string|null} [opts.memberRef]  scope to one post (null = whole roster)
 * @param {boolean} [opts.instantiated]   does the host have a team from this pack?
 * @returns {{state: string, roster?: object[], edges?: object[], acceptance?: object[], errors?: string[]}}
 */
export function deriveTeam(manifest, { memberRef = null, instantiated = null } = {}) {
  const m = isObj(manifest) ? manifest : {};
  const path = "fleet";

  // No fleet block ⇒ not a team. This is the normal state for the 36 non-team
  // packs in the repo (single-skill packs, adopted skill packs) — a surface must
  // render "this pack declares no team composition", not an empty table.
  if (!isObj(m.fleet)) return { state: ROSTER_STATE.UNDECLARED };

  const members = asArray(m.fleet.members);
  if (members.length === 0) {
    return { state: ROSTER_STATE.INVALID, errors: [`${path}.members 为空——团队至少要有一个岗`] };
  }

  const errors = [];
  let rows = members.map((mem, i) => deriveRow(mem, i, errors, `${path}.members`));

  // Scope: a memberRef that names a post this pack does not carry is a real
  // answer (that post is not here), not a silent fallback to the whole roster —
  // falling back would show a caller somebody else's composition.
  if (memberRef != null) {
    const want = String(memberRef);
    rows = rows.filter((r) => r.ref === want);
    if (rows.length === 0) {
      return { state: ROSTER_STATE.INVALID, errors: [`${path}.members 里没有 ref '${want}'`] };
    }
  }

  if (errors.length) return { state: ROSTER_STATE.INVALID, errors };

  // `instantiated` is the caller's knowledge (a cell either has a team built
  // from this pack or it does not). This module must not guess it — reading
  // install state would make the derivation impure. Three-valued on purpose:
  // `null` means the caller did not say, and we report the roster without
  // claiming either instantiation state.
  let state = ROSTER_STATE.PRESENT;
  if (instantiated === false && memberRef == null) state = ROSTER_STATE.NOT_INSTANTIATED;

  return {
    state,
    roster: rows,
    // Edges and acceptance describe the whole team; with a member scope the
    // caller gets the post's row only (edges are between posts, so a scoped
    // answer cannot carry them without lying about who else is on the team).
    edges: memberRef == null ? deriveEdges(m, errors, path) : [],
    acceptance: memberRef == null ? deriveAcceptance(m) : [],
  };
}

/** The roster segment order every surface must render, fixed here once. */
export const ROSTER_ORDER = Object.freeze(["roster", "edges", "acceptance"]);
