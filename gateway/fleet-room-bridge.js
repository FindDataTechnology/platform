// ── Fleet ↔ Zhiyu room bridge (add-zhiyu-team-memory 刀B) ───────────────────
//
// A room SUBSCRIBES to one of its principal's fleets; three fact classes flow
// in as kind=system event rows (report digest / decision opened / health
// transition), each carrying a cockpit deep link. PULL-based: on each tick the
// bridge samples the OWNER'S OWN cell (/api/fleets/overview over the same
// forged-identity channel the projection lane uses — no new uplink fields,
// no push channel into cells), and appends only what the subscription's
// PERSISTED watermark has not seen yet. Rate control merges dense windows into
// one count+sample line; circuit-open drops count silently toward the next
// line's "N dropped" note (spec: 熔断期丢弃不补发、恢复后标注丢失量).
//
// Why the watermark lives in the store and not here (fix-zhiyu-room-lifecycle-
// and-bridge-watermark): the previous cursor was a private property written on
// the freshly-sampled overview objects. Every tick replaces those objects, so
// any path that lost the baseline re-emitted the same report — production
// accumulated 1018 copies of four reports in one room, one every couple of
// minutes, long after the room had ended. A durable per-subscription cursor
// makes "an event flows in at most once" independent of process lifetime,
// sample identity and tick overlap.
//
// This module is a pure sample+consume worker; storage rides the zhiyu store's
// subscription table (zy_fleet_subs) and fleetSubConsume. Summon (一键召唤:
// batch-invite the fleet's serving members + subscribe) is a route here too —
// it lists serving members from the same overview sample and creates the
// invites through the store's inviteCreate, so the handshake/policy machinery
// is the existing one.

import express from "express";
import { randomUUID } from "node:crypto";

const RATE_WINDOW_MS = 60 * 60 * 1000; // dense-window merge window (1h,防洪同款)
const MAX_PER_WINDOW = 10; // beyond this, merge into one count+sample line
const MAX_SUBS_PER_ROOM = 5;
const DROPS_NOTE_MIN = 1;

function systemRow(store, roomId, content, meta) {
  return store.messageAppend({
    roomId,
    kind: "system",
    fromAgent: 0,
    visibility: "shared",
    content,
    meta,
    provenance: "fleet-room-bridge",
  });
}

// One fleet's CURRENT fact state, read verbatim off the overview sample. No
// comparison happens here: "is this new?" is answered by the subscription's
// persisted watermark inside fleetSubConsume, so a baseline can never be lost
// with a sample object. Multiple facts are candidates every tick; the consume
// callback decides which of them are still unknown to the room.
function candidateFor(f) {
  const newest = (f.stream ?? [])[0];
  const dCount = f.openDecisions?.count ?? 0;
  const top = f.openDecisions?.top?.[0] ?? null;
  return {
    fleetId: f.id,
    fleetName: f.name,
    report: newest?.at ? { at: newest.at, memberTitle: newest.title, summary: newest.summarySnip ?? "", metrics: newest.metrics ?? {} } : null,
    decisions: {
      count: dCount,
      question: top?.question ?? "",
      severity: top?.severity ?? "normal",
      memberTitle: top?.memberTitle ?? null,
    },
    abnormal: (f.counts?.missing ?? 0) + (f.counts?.vacant ?? 0) + (f.counts?.failing ?? 0),
  };
}

export function registerFleetRoomBridge(app, {
  store, // the zhiyu store (subscription table + messageAppend)
  resolveUser,
  rejectUnauthenticated,
  // The pull channel: (ownerEmail) => { fleets } — the wired default samples
  // the owner's own cell over the forged-identity channel; tests inject.
  sampleFleets,
  // The deployment ledger seam (fix-zhiyu-summon-serving-face 2.1):
  // async () => [{ packId, agentId, agentPath, deployedBy }] | null — the packs
  // internal deployments rows, same source the zhiyu agent-lane resolves seats
  // against. null (or a throw) = face unavailable → summonable honestly empty.
  // The bridge itself never does HTTP; the wired seam lives in gateway/index.js.
  servingDeployments = null,
  cockpitBase = "",
  // Health transitions are debounced (debounce-zhiyu-fleet-health-events): a
  // member that flips missing↔ok every few minutes used to append two rows per
  // flip (production: 193 rows in three days, 65% of flips < 10 min). A
  // transition now flows only after it has held for this window; flaps inside
  // it are counted and noted on the next real line.
  healthSettleMs = Number(process.env.ZHIYU_HEALTH_SETTLE_MS) || 10 * 60 * 1000,
  // Injectable clock so tests can advance the settle window without sleeping.
  nowMs = () => Date.now(),
}) {
  // ── subscription management (owner- or authorized-member-gated) ──────────

  const requireMember = (req, res) => {
    const user = resolveUser(req);
    if (!user) {
      rejectUnauthenticated(req, res);
      return null;
    }
    return user;
  };

  const authzFor = (roomId, email) => {
    const room = store.roomGet(roomId);
    if (!room) return { ok: false, status: 404 };
    if (room.ownerEmail === email) return { ok: true, room };
    const members = store.membersOf(roomId) ?? [];
    const me = members.find((m) => m.kind === "user" && m.ref === email && m.presence !== "removed");
    // An active user member may subscribe their OWN fleet into the room (the
    // spec: 订阅一支订阅者自己拥有的团队); only the owner lists/unlists all.
    return me ? { ok: true, room, member: me } : { ok: false, status: 404 };
  };

  app.get("/api/zhiyu/rooms/:id/fleet-subscriptions", (req, res) => {
    const user = requireMember(req, res);
    if (!user) return;
    const authz = authzFor(req.params.id, user.email);
    if (!authz.ok) return res.status(authz.status).json({ error: "not found" });
    res.json({ subscriptions: store.fleetSubsOf(req.params.id) });
  });

  app.post("/api/zhiyu/rooms/:id/fleet-subscriptions", express.json({ limit: "4kb" }), async (req, res) => {
    const user = requireMember(req, res);
    if (!user) return;
    const authz = authzFor(req.params.id, user.email);
    if (!authz.ok) return res.status(authz.status).json({ error: "not found" });
    const fleetId = String(req.body?.fleetId ?? "").trim();
    const fleetName = String(req.body?.fleetName ?? "").trim().slice(0, 120);
    if (!fleetId) return res.status(400).json({ error: "fleetId is required" });
    // OWNERSHIP: the subscriber must own the fleet — verified against the
    // live sample (the cell answers /overview for its owner only). A fleet
    // the caller does not own is indistinguishable from a nonexistent one
    // (probing teaches nothing).
    const overview = await sampleFleets(user.email);
    const fleet = (overview?.fleets ?? []).find((f) => f.id === fleetId);
    if (!fleet) return res.status(404).json({ error: "not found" });
    if (store.fleetSubsOf(req.params.id).length >= MAX_SUBS_PER_ROOM) {
      return res.status(409).json({ error: `a room subscribes at most ${MAX_SUBS_PER_ROOM} fleets` });
    }
    const sub = store.fleetSubAdd({ roomId: req.params.id, fleetId, fleetName: fleetName || fleet.name, ownerEmail: user.email });
    systemRow(store, req.params.id, `已订阅团队「${sub.fleetName}」——报数与关键动态将流入本空间（可在订阅区解除）。`, { fleetId, bridge: "subscribed" });
    res.status(201).json({ subscription: sub });
  });

  app.delete("/api/zhiyu/rooms/:id/fleet-subscriptions/:subId", (req, res) => {
    const user = requireMember(req, res);
    if (!user) return;
    const authz = authzFor(req.params.id, user.email);
    if (!authz.ok) return res.status(authz.status).json({ error: "not found" });
    const removed = store.fleetSubRemove(req.params.id, req.params.subId);
    if (!removed) return res.status(404).json({ error: "not found" });
    systemRow(store, req.params.id, `已解除对团队「${removed.fleetName}」的订阅——流入停止，已流入的记录保留。`, { fleetId: removed.fleetId, bridge: "unsubscribed" });
    res.json({ ok: true });
  });

  // ── 一键召唤 (spec: batch-invite serving members + subscribe) ─────────────
  // Serves a PLAN first (what CAN be summoned vs what is persona-only), then
  // executes on confirm — the preview is what makes "如实呈现" honest.
  app.post("/api/zhiyu/rooms/:id/fleet-summon", express.json({ limit: "8kb" }), async (req, res) => {
    const user = requireMember(req, res);
    if (!user) return;
    const authz = authzFor(req.params.id, user.email);
    if (!authz.ok) return res.status(authz.status).json({ error: "not found" });
    const fleetId = String(req.body?.fleetId ?? "").trim();
    const overview = await sampleFleets(user.email);
    const fleet = (overview?.fleets ?? []).find((f) => f.id === fleetId);
    if (!fleet) return res.status(404).json({ error: "not found" });

    // Serving members (fix-zhiyu-summon-serving-face 2.2): a2a posts from the
    // overview's formation, joined to REAL pack deployments on the registry
    // agent path (cell reports servingPath; the ledger carries agentPath —
    // the same string minted at deploy time). The seat ref the zhiyu agent
    // lane resolves is `${packId}:${agentId}` with onBehalfOf = the deployer.
    // No aligned row (external a2a url, undeployed post) → honestly excluded;
    // ledger face unavailable (null/throw) → summonable empty, plan still 200.
    // (The old wiring called `.servingMembers?.(fleetId)` on the overview JSON
    // — a function that never existed on any HTTP payload, so summonable was
    // permanently empty in production while tests only asserted the degraded
    // shape. Same "tests green, production unreachable" class as O0.)
    let serving = [];
    const servingCandidates = (fleet.formation?.members ?? []).filter(
      (m) => m.targetKind === "a2a" && m.servingPath,
    );
    if (servingCandidates.length > 0) {
      try {
        const rows = (await servingDeployments?.()) ?? null;
        const byPath = new Map((rows ?? []).map((d) => [d.agentPath, d]));
        serving = servingCandidates.flatMap((m) => {
          const d = byPath.get(m.servingPath);
          return d ? [{ ref: `${d.packId}:${d.agentId}`, title: m.title, targetId: m.targetId ?? null, onBehalfOf: d.deployedBy }] : [];
        });
      } catch {
        serving = []; // ledger face unavailable → degrade honestly
      }
    }
    const plan = {
      fleetId,
      fleetName: fleet.name,
      summonable: serving,
      cockpitOnly: (fleet.stream ?? []).map((s) => s.title),
    };
    if (req.body?.dryRun) return res.json({ plan });

    const results = [];
    for (const member of plan.summonable) {
      try {
        // Already seated → honest no-op (kernel invite route's 409 semantics),
        // not a junk invite row for a member who is already in the room.
        if (store.memberFor(req.params.id, "agent", member.ref)?.state === "active") {
          results.push({ ref: member.ref, ok: false, error: "already a member" });
          continue;
        }
        // idemKey is NOT NULL UNIQUE in the invites table — the kernel's own
        // invite route keys `${roomId}:${kind}:${ref}` and bumps with a
        // timestamp on collision; the bridge follows the same convention.
        // (Execution could never have run without it: the old code path died
        // on the NOT NULL constraint, masked by serving always being empty.)
        const idemBase = `${req.params.id}:agent:${member.ref}`;
        const idemKey = store
          .invitesForRoom(req.params.id)
          .some((v) => v.idemKey === idemBase)
          ? `${idemBase}:${Date.now().toString(36)}`
          : idemBase;
        const inv = store.inviteCreate({
          id: randomUUID(),
          roomId: req.params.id,
          kind: "agent",
          ref: member.ref,
          display: member.title ?? member.ref,
          // The deployer, not the summoner (fix-zhiyu-summon-serving-face):
          // the seat lane resolves the deployment by packId:agentId AND
          // deployedBy === onBehalfOf, so the invite must carry the ledger's
          // deployer or the seat could never speak. Self-deployed posts
          // (the common case) are the summoner themself — unchanged there.
          onBehalfOf: member.onBehalfOf ?? user.email,
          historyGrant: "join_from",
          invitedBy: user.email,
          state: "pending",
          idemKey,
          createdAt: Date.now(),
        });
        results.push({ ref: member.ref, ok: true, inviteId: inv.invite?.id ?? inv.id ?? inv.inviteId ?? null });
      } catch (err) {
        results.push({ ref: member.ref, ok: false, error: err.message });
      }
    }
    // Summon carries the subscription with it (spec: 召唤=邀请+订阅两层效果).
    if (!store.fleetSubsOf(req.params.id).some((s) => s.fleetId === fleetId)) {
      store.fleetSubAdd({ roomId: req.params.id, fleetId, fleetName: fleet.name, ownerEmail: user.email });
    }
    res.json({ plan, results });
  });

  // ── the pull tick: sample → consume (watermark) → rate-merge → append ────
  let running = false; // single-flight (D3): a slow sample must not stack ticks
  let circuitOpen = false;
  let droppedWhileOpen = 0;
  const perWindow = new Map(); // subKey -> count in this window
  let windowStarted = 0;

  // Rate control only shapes the DISPLAY density of genuinely-new items; it
  // never decides novelty (the watermark does). Losing a counter therefore
  // costs at most one extra merged line, never a re-emitted report.
  function rateLimited(sub, items) {
    if (items.length === 0) return [];
    const key = `${sub.roomId}|${sub.fleetId}`;
    if (Date.now() - windowStarted > RATE_WINDOW_MS) {
      windowStarted = Date.now();
      perWindow.clear();
    }
    let count = perWindow.get(key) ?? 0;
    const out = [];
    for (const item of items) {
      count += 1;
      if (count > MAX_PER_WINDOW) {
        if (!perWindow.get(`${key}|merged`)) {
          perWindow.set(`${key}|merged`, true);
          const last = item;
          const sample = last.kind === "report" ? last.summary || "(无摘要)" : last.question || last.to;
          out.push({
            kind: "system",
            content: `「${sub.fleetName}」动态密集（近 1 小时 ${count} 条）——已合并呈现；最新：${sample}`,
            meta: { fleetId: sub.fleetId, bridge: "merged", count },
          });
        }
        continue;
      }
      out.push(item);
    }
    perWindow.set(key, count);
    return out;
  }

  const renderItem = (sub, item, drops) =>
    item.kind === "system"
      ? { kind: "system", content: item.content, meta: item.meta }
      : item.kind === "report"
        ? {
            kind: "system",
            content: `「${sub.fleetName}」${item.memberTitle} 报数：${item.summary || "(无摘要)"}${drops}`,
            meta: { fleetId: sub.fleetId, bridge: "report", at: item.at, deepLink: `${cockpitBase}/fleets/${sub.fleetId}` },
          }
        : item.kind === "decision"
          ? {
              kind: "system",
              content: `「${sub.fleetName}」等你拍板：${item.question}${item.memberTitle ? `（${item.memberTitle}）` : ""}｜严重度 ${item.severity}${drops}`,
              meta: { fleetId: sub.fleetId, bridge: "decision", severity: item.severity, deepLink: `${cockpitBase}/fleets/${sub.fleetId}` },
            }
          : {
              kind: "system",
              content: `「${sub.fleetName}」健康状态${item.to === "abnormal" ? `异常（${item.abnormal} 岗）` : "恢复"}${item.flaps ? `（其间抖动 ${item.flaps} 次已合并）` : ""}${drops}`,
              meta: { fleetId: sub.fleetId, bridge: "health", to: item.to, ...(item.flaps ? { flaps: item.flaps } : {}), deepLink: `${cockpitBase}/fleets/${sub.fleetId}` },
            };

  async function tick() {
    if (running) return; // D3: the previous round is still sampling — skip, don't stack
    running = true;
    try {
      const subs = store.fleetSubsAll();
      if (subs.length === 0) return;
      // One sample per OWNER (subscriptions are owner-scoped by construction).
      // NOTE: ended rooms are sampled too — their watermark must keep moving,
      // otherwise the first tick after reactivation would flush everything
      // that happened while the room was dark (spec: 断流期事件不补发).
      const byOwner = new Map();
      for (const sub of subs) {
        if (!byOwner.has(sub.ownerEmail)) byOwner.set(sub.ownerEmail, []);
        byOwner.get(sub.ownerEmail).push(sub);
      }
      const samples = new Map();
      for (const [ownerEmail] of byOwner) {
        samples.set(ownerEmail, await sampleFleets(ownerEmail));
      }
      for (const [ownerEmail, ownerSubs] of byOwner) {
        const next = samples.get(ownerEmail);
        const byFleet = new Map((next?.fleets ?? []).map((f) => [f.id, f]));
        for (const sub of ownerSubs) {
          const fleet = byFleet.get(sub.fleetId);
          if (!fleet) continue;
          // D4: an ended room is a real gate — the subscription row stays, it
          // just stops FLOWING while its watermark keeps advancing.
          const flowing = sub.roomStatus === "active";
          const cand = candidateFor(fleet);
          const res = store.fleetSubConsume(sub.roomId, sub.fleetId, (wm) => {
            if (wm === null) {
              // First sight: baseline silently (spec: 订阅基线, no history dump)
              return {
                rows: [],
                next: {
                  reportAt: cand.report?.at ?? 0,
                  decisionsCount: cand.decisions.count,
                  abnormalCount: cand.abnormal,
                  healthPending: null,
                  healthFlaps: 0,
                },
              };
            }
            const committed = wm.abnormalCount ?? 0;
            const items = [];
            if (cand.report && cand.report.at > (wm.reportAt ?? 0)) items.push({ kind: "report", ...cand.report });
            if (cand.decisions.count > (wm.decisionsCount ?? 0)) items.push({ kind: "decision", ...cand.decisions });

            // Health is debounced (spec: 健康状态迁移以持续态为准). The watermark
            // keeps the COMMITTED state; a deviation is only observed until it
            // holds for healthSettleMs. Flipping back inside the window is a
            // flap: nothing flows, the flap is counted and reported later.
            let healthPending = wm.healthPending ?? null;
            let healthFlaps = wm.healthFlaps ?? 0;
            let committedHealth = committed;
            let healthTo = null;
            if (cand.abnormal !== committed) {
              const now = nowMs();
              if (healthPending && healthPending.value === cand.abnormal) {
                if (now - (healthPending.since ?? now) >= healthSettleMs) {
                  healthTo = cand.abnormal > committed ? "abnormal" : "recovered";
                  committedHealth = cand.abnormal;
                  healthPending = null;
                } else {
                  healthPending = { value: cand.abnormal, since: healthPending.since ?? now };
                }
              } else {
                // New deviation, or the previous observation flipped again
                // (which is itself a suppressed transition).
                if (healthPending) healthFlaps += 1;
                healthPending = { value: cand.abnormal, since: now };
              }
            } else if (healthPending) {
              // Back to the committed state inside the window: a flap.
              healthFlaps += 1;
              healthPending = null;
            }
            if (healthTo) {
              items.push({
                kind: "health",
                to: healthTo,
                abnormal: cand.abnormal,
                flaps: healthFlaps,
              });
              healthFlaps = 0;
            }

            const advanced = {
              reportAt: Math.max(wm.reportAt ?? 0, cand.report?.at ?? 0),
              decisionsCount: cand.decisions.count,
              abnormalCount: committedHealth,
              healthPending,
              healthFlaps,
            };
            // Ended room (or a dangling room row): advance, never render — and
            // drop any observation in progress so reactivation starts from the
            // current state instead of replaying the dark period (spec: 重开清空).
            // This normalization must happen BEFORE the empty-items return:
            // an ended room has to commit the current state even on a tick that
            // would otherwise render nothing, or the pending observation would
            // survive the dark period and fire on reactivation.
            const next = flowing
              ? advanced
              : { ...advanced, abnormalCount: cand.abnormal, healthPending: null, healthFlaps: 0 };
            if (items.length === 0) return { rows: [], next };
            if (!flowing) return { rows: [], next };
            // Circuit open: drop and COUNT, but advance the watermark — the
            // spec says dropped events are never replayed, only reported.
            if (circuitOpen) {
              droppedWhileOpen += items.length;
              return { rows: [], next };
            }
            const drops = droppedWhileOpen > 0 ? `（此前熔断期丢弃 ${droppedWhileOpen} 条）` : "";
            const rows = rateLimited(sub, items).map((item) => renderItem(sub, item, drops));
            return { rows, next };
          });
          if (res.ok && res.written > 0 && droppedWhileOpen >= DROPS_NOTE_MIN) droppedWhileOpen = 0;
        }
      }
    } catch {
      // The bridge failing must only mute the bridge — rooms and fleets run on
      // (spec: 桥故障只哑桥). A failure streak opens the circuit; the next
      // successful line carries the dropped count.
      droppedWhileOpen += 1;
      if (droppedWhileOpen >= 3) circuitOpen = true;
      return;
    } finally {
      running = false;
    }
    circuitOpen = false;
  }

  return { tick, candidateFor };
}
