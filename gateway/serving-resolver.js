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

    const candidates = (fleet.formation?.members ?? []).filter(
      (m) => m.targetKind === "a2a" && m.servingPath,
    );
    let serving = [];
    if (candidates.length > 0) {
      let rows = null;
      try {
        rows = (await servingDeployments?.()) ?? null;
      } catch {
        rows = null; // ledger face unavailable → degrade honestly, never throw
      }
      const byPath = new Map((rows ?? []).map((d) => [d.agentPath, d]));
      serving = candidates.flatMap((m) => {
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
    // Members that are NOT serving seats still need naming for the honest
    // "this team has posts, but none of them can answer" message.
    const cockpitOnly = (fleet.stream ?? []).map((s) => s.title).filter(Boolean);
    return { fleet, serving, cockpitOnly };
  }

  return { resolve };
}
