// ── Resolve a fleet's serving members (fix-zhiyu-summon-serving-face 2.2) ────
//
// "Which of this team's seats can actually answer when someone walks in?" is
// one question asked from two places: the room's summon button, and — since
// add-zhiyu-team-account — a team account opening a room on demand. Keeping two
// copies of the answer would let them drift, and the failure mode is silent:
// a room that opens with no seats looks exactly like a room whose seats are
// thinking.
//
// The answer is a JOIN of two facts that live in different processes:
//   · the fleet's formation, which the owner's CELL reports (a2a posts carry a
//     `servingPath` string), and
//   · the deployment ledger, which says which of those paths actually has a
//     live deployment (`packId:agentId`, plus who deployed it).
// A post with no matching ledger row is honestly EXCLUDED — an external a2a url
// or an undeployed post cannot be seated in a room.
//
// Every seam is injectable and every absence degrades to "nothing summonable"
// rather than an error: the caller is usually a message path, and a room that
// fails to open is worse than a room that opens empty-but-honest.

export function createServingResolver({ sampleFleets, servingDeployments }) {
  /**
   * @returns {Promise<{ fleet: object|null, serving: Array<{ref,title,onBehalfOf}>, cockpitOnly: string[] }>}
   *   `fleet` is null when the owner's cell has no such fleet (caller decides
   *   whether that is a 404 or an honest empty room).
   */
  async function resolve(ownerEmail, fleetId) {
    let overview = null;
    try {
      overview = await sampleFleets?.(ownerEmail);
    } catch {
      overview = null;
    }
    const fleet = (overview?.fleets ?? []).find((f) => f.id === fleetId) ?? null;
    if (!fleet) return { fleet: null, serving: [], cockpitOnly: [] };

    // Two kinds of seat, and they answer the SAME question ("who can reply when
    // someone walks in") over different plumbing:
    //
    //   a2a posts      — a market deployment; the ledger says whether it is live
    //                    and the seat ref is `${packId}:${agentId}`.
    //   persona/auditor — a post running on THIS cell's runtime. No deployment
    //                    exists and none is needed: the turn runs in the owner's
    //                    own cell over the gateway's sync-turn endpoint.
    //
    // The second kind used to be excluded here, which made "unpublished team"
    // mean "unusable team" — a team a human built locally could not be summoned
    // into their own room. Visibility governs OUTSIDE callers; it must not
    // govern who may speak inside a room the owner is already in.
    const members = fleet.formation?.members ?? [];
    const a2aCandidates = members.filter((m) => m.targetKind === "a2a" && m.servingPath);
    const localCandidates = members.filter((m) => m.targetKind === "persona" || m.targetKind === "auditor");
    let serving = [];
    if (a2aCandidates.length > 0) {
      let rows = null;
      try {
        rows = (await servingDeployments?.()) ?? null;
      } catch {
        rows = null; // ledger face unavailable → degrade honestly, never throw
      }
      const byPath = new Map((rows ?? []).map((d) => [d.agentPath, d]));
      serving = a2aCandidates.flatMap((m) => {
        const d = byPath.get(m.servingPath);
        return d
          ? [{
              ref: `${d.packId}:${d.agentId}`,
              title: m.title,
              targetId: m.targetId ?? null,
              onBehalfOf: d.deployedBy,
              // 播报音色（add-room-voice-and-catalog）：岗位声明随席位携带，召唤时
              // 写进座席；未声明为 null，召唤侧据此不写该字段。
              voice: m.voice ?? null,
            }]
          : [];
      });
    }
    // Local posts: a seat whose ref names the post, not a deployment. The lane
    // that answers it (gateway/zhiyu/persona-lane.js) forwards to the cell's
    // sync-turn endpoint, so nothing here needs a ledger row.
    const localSeats = localCandidates.map((m) => ({
      ref: `persona:${fleetId}:${m.id ?? m.ref ?? ""}`,
      title: m.title,
      targetId: m.targetId ?? null,
      // The team owner is who the turn runs as — the room is theirs, and the
      // cell re-checks ownership on every turn anyway. Taken from the resolver's
      // own argument: the sampled fleet object does not always carry it, and a
      // seat with a null principal could never be invited.
      onBehalfOf: ownerEmail,
      voice: m.voice ?? null,
      targetKind: m.targetKind,
    })).filter((s) => s.ref !== `persona:${fleetId}:`);
    serving = [...serving, ...localSeats];

    // Members that are NOT serving seats still need naming for the honest
    // "this team has posts, but none of them can answer" message. Stream titles
    // are reported verbatim: a title may legitimately appear both here and in
    // the seats (the seat resolved a deployment, the stream sampled the post),
    // and silently de-duplicating would change what callers already read.
    const cockpitOnly = (fleet.stream ?? []).map((s) => s.title).filter(Boolean);
    return { fleet, serving, cockpitOnly };
  }

  return { resolve };
}
