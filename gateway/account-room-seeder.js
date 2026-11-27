// ── Seat a team's serving members into a room (add-zhiyu-team-account) ──────
//
// A team account opens rooms on demand: one per IM chat, one per visiting site,
// whatever the door was. Such a room MUST arrive with the team's seats in it —
// otherwise "the team's outward address" is an address nobody answers at, and
// the visitor cannot tell that from an agent that is simply slow.
//
// Two callers use this (the widget lane and the IM bridge), which is exactly why
// it lives in one place: two copies would drift, and they would drift silently
// (an empty room and a thinking room look identical from outside).
//
// Seats are seated through the SAME invite handshake the room UI uses, so their
// authorization, on-behalf-of attribution and history grant match a human
// summoning them by hand.
//
// Idempotent twice over: an already-active seat is skipped, and the seeding
// itself is remembered per room so a burst of messages does not re-ask the cell.

export function createAccountRoomSeeder({ store, resolveServing }) {
  const seeded = new Set(); // roomId

  /**
   * Seat `account`'s team into `room`. Never throws: a failed seat is logged and
   * the room still opens (a room with one fewer seat beats no room at all).
   * @returns {Promise<{seated: number, empty: boolean}>}
   */
  async function seat(account, room) {
    if (seeded.has(room.id)) return { seated: 0, empty: false };
    seeded.add(room.id);

    let resolved = null;
    try {
      resolved = await resolveServing?.(account.ownerEmail, account.fleetId);
    } catch {
      resolved = null;
    }
    const serving = resolved?.serving ?? [];

    if (!serving.length) {
      // Honest emptiness beats silence. A SYSTEM row, not an agent message:
      // nothing here is pretending to think, and nothing will answer later
      // unless someone deploys a seat.
      const names = (resolved?.cockpitOnly ?? []).filter(Boolean).slice(0, 6);
      // Say it once per room, not once per process: a pod restart re-seeds,
      // and repeating "nobody can answer" on every restart is noise in a
      // transcript whose whole job is to be trustworthy.
      const alreadySaid = (store.messagesAfter?.(room.id, 0, {}) ?? []).some(
        (m) => m.meta?.event === "no_serving_seats",
      );
      if (alreadySaid) return { seated: 0, empty: true };
      try {
        store.messageAppend({
          roomId: room.id,
          kind: "system",
          content: names.length
            ? `本团队当前没有可接待的席位（${names.join("、")} 尚未部署为服务）。消息已记录，待有人值守后会看到。`
            : `本团队当前没有可接待的席位。消息已记录，待有人值守后会看到。`,
          meta: { event: "no_serving_seats", fleetId: account.fleetId, cockpitOnly: names },
        });
      } catch (err) {
        console.error(`[zhiyu] failed to write no-seat notice in ${room.id}:`, err.message);
      }
      return { seated: 0, empty: true };
    }

    let seated = 0;
    for (const seat of serving) {
      try {
        if (store.memberFor(room.id, "agent", seat.ref)?.state === "active") continue;
        store.memberAdd({
          roomId: room.id,
          kind: "agent",
          ref: seat.ref,
          // The DEPLOYER, not the account owner: the seat lane resolves the
          // deployment by packId:agentId AND deployedBy === onBehalfOf.
          onBehalfOf: seat.onBehalfOf ?? account.ownerEmail,
          display: seat.title ?? seat.ref,
          historyGrant: "join_from",
          invitedBy: account.ownerEmail,
        });
        seated += 1;
      } catch (err) {
        console.error(`[zhiyu] failed to seat ${seat.ref} in ${room.id}:`, err.message);
      }
    }
    if (seated > 0) {
      // One system row so the room's own history says who joined and why —
      // a visitor who opens the transcript should not find seats that simply
      // "were always there".
      try {
        store.messageAppend({
          roomId: room.id,
          kind: "system",
          content: `本团队的值守席位已入席：${serving.map((s) => s.title ?? s.ref).join("、")}。`,
          meta: { event: "serving_seated", fleetId: account.fleetId, refs: serving.map((s) => s.ref) },
        });
      } catch { /* the rows above are what matter */ }
    }
    return { seated, empty: false };
  }

  return { seat };
}
