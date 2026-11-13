// ── Member identity for a preset, off live task records ─────────────────────
//
// A cron fire carries `sourceTag` { fleetId, memberId } straight off the task
// record, so the member is already known — no config scan needed. That is why
// the member-patch branch (and the per-post MCP trimming inside it) can run for
// fleet fires at all: the preset→member scan returns null unless attribution is
// a unique "preset" match (see server/fleet-reports.js:resolveAttribution).
//
// Only `running` / `queued` records count: a finished fire must not lend its
// identity to a later chat turn on the same persona.
//
// ── Fail-closed on ambiguity (decision 2026-11-10) ──────────────────────────
//
// The same preset can legitimately be on the books twice — one persona holding
// posts in two fleets. The first version returned the FIRST match, which meant
// a round could be handed ANOTHER post's `memberId`. That id flows into
// `memberTokenFor({ packId, memberId, … })` and lands in the private MCP
// patch's `Authorization` header, i.e. a wrong member's deployment token baked
// into this worker.
//
// Losing an identity is recoverable — the caller falls back to the shared
// patch, which is the documented pre-change behavior (see worker-slots.js:
// "any compose failure falls back to the shared patch"). Wearing someone else's
// token is not. So: exactly one distinct (fleetId, memberId) pair returns that
// pair; zero or more than one returns null.
//
// Distinctness is keyed on `fleetId:memberId`, NOT on record count: a post whose
// own retry left two queued rows for the same member is NOT ambiguous.

/**
 * @param {Array<{preset?: string, state?: string, sourceTag?: {fleetId?: string, memberId?: string}}>} records
 * @param {string|null} presetId
 * @returns {{ identity: {fleetId: string, memberId: string} | null, candidates: Array<{fleetId: string, memberId: string}> }}
 *   `candidates` is the deduped list actually seen — length > 1 means the caller
 *   should surface an ambiguity (and this function returned `identity: null`).
 */
export function pickMemberIdentity(records, presetId) {
  if (!presetId || !Array.isArray(records)) return { identity: null, candidates: [] };
  const byPair = new Map(); // "fleetId:memberId" -> { fleetId, memberId }
  for (const rec of records) {
    if (!rec || rec.preset !== presetId) continue;
    if (rec.state !== "running" && rec.state !== "queued") continue;
    const tag = rec.sourceTag;
    if (!tag?.fleetId || !tag?.memberId) continue;
    byPair.set(`${tag.fleetId}:${tag.memberId}`, { fleetId: tag.fleetId, memberId: tag.memberId });
  }
  const candidates = [...byPair.values()];
  return { identity: candidates.length === 1 ? candidates[0] : null, candidates };
}

/** Compact "fleetId:memberId, …" rendering for a warn line. */
export function describeCandidates(candidates) {
  return (Array.isArray(candidates) ? candidates : [])
    .map((c) => `${c?.fleetId}:${c?.memberId}`)
    .join(", ");
}
