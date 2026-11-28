// Role versions + guidance patches over HTTP (agent-as-employee-model 1.4 / 2.2 / 2.3).
//
// Decision authority = fleet owner (same rule as every other fleet write).
// The author of a human-submitted patch is the request identity, never a body
// field: a body-supplied author would let any caller sign as anyone.

import { Router } from "express";
import { getFleetDatabase } from "./fleets-db.js";
import { project, AUDIENCES } from "../../lib/audience-projection.js";
import { deriveCapabilities } from "../../lib/capability-layer.js";
import * as dbModule from "../../db.js";

export function createRoleGuidanceRoutes(app, ctx = null, { mount = "/api/fleets" } = {}) {
  const resolveUser = (req) =>
    req.user ?? (ctx?.authEnabled ? null : { email: ctx?.cellUserEmail || "owner@local", groups: [] });
  const router = Router();

  const owned = (req, res) => {
    const user = resolveUser(req);
    if (!user) { res.status(401).json({ error: "Authentication required" }); return null; }
    const fleet = getFleetDatabase().getFleet(req.params.id);
    if (!fleet) { res.status(404).json({ error: "Fleet not found" }); return null; }
    if (fleet.ownerEmail !== user.email) { res.status(403).json({ error: "Not your fleet" }); return null; }
    return { user, fleet };
  };
  const status = (r) => (r.error === "not found" ? 404 : r.code === "stale-base" || r.code === "self-approval" ? 409 : 400);

  router.get("/:id/members/:memberId/role/versions", (req, res) => {
    const o = owned(req, res); if (!o) return;
    const source = typeof req.query.source === "string" ? req.query.source : null;
    const db = getFleetDatabase();
    res.json({
      current: db.currentRoleVersion(o.fleet.id, req.params.memberId),
      versions: db.listRoleVersions(o.fleet.id, req.params.memberId, { source }),
    });
  });

  router.post("/:id/members/:memberId/guidance", (req, res) => {
    const o = owned(req, res); if (!o) return;
    const b = req.body ?? {};
    const r = getFleetDatabase().submitGuidancePatch({
      fleetId: o.fleet.id, memberId: req.params.memberId,
      baseVersion: b.baseVersion, organ: b.organ, content: b.content, reason: b.reason,
      author: { kind: "human", id: o.user.email },
    });
    if (r.error) return res.status(status(r)).json(r);
    res.status(201).json(r);
  });

  router.get("/:id/guidance", (req, res) => {
    const o = owned(req, res); if (!o) return;
    const state = typeof req.query.state === "string" ? req.query.state : null;
    res.json({ patches: getFleetDatabase().listGuidancePatches({ fleetId: o.fleet.id, state }) });
  });

  const patchInFleet = (o, id, res) => {
    const p = getFleetDatabase().getGuidancePatch(id);
    if (!p || p.fleetId !== o.fleet.id) { res.status(404).json({ error: "not found" }); return null; }
    return p;
  };

  router.post("/:id/guidance/:patchId/merge", (req, res) => {
    const o = owned(req, res); if (!o) return;
    if (!patchInFleet(o, req.params.patchId, res)) return;
    const r = getFleetDatabase().mergeGuidancePatch(req.params.patchId, { by: { kind: "human", id: o.user.email } });
    if (r.error) return res.status(status(r)).json(r);
    res.json(r);
  });

  router.post("/:id/guidance/:patchId/reject", (req, res) => {
    const o = owned(req, res); if (!o) return;
    if (!patchInFleet(o, req.params.patchId, res)) return;
    const r = getFleetDatabase().rejectGuidancePatch(req.params.patchId, { by: { kind: "human", id: o.user.email }, reason: req.body?.reason });
    if (r.error) return res.status(status(r)).json(r);
    res.json(r);
  });

  // Bind / unbind a member's tenure to a task (agent-as-employee-model 4.3).
  router.put("/:id/members/:memberId/bound-task", (req, res) => {
    const o = owned(req, res); if (!o) return;
    const db = getFleetDatabase();
    const m = db.getMember(req.params.memberId);
    if (!m || m.fleetId !== o.fleet.id) return res.status(404).json({ error: "member not found" });
    const taskId = req.body?.taskId ?? null;
    if (taskId !== null && (typeof taskId !== "string" || !taskId.trim())) return res.status(400).json({ error: "taskId must be a non-empty string or null" });
    db.updateMember(m.id, { boundTaskId: taskId });
    res.json({ member: db.getMember(m.id) });
  });

  // Promotion payload preview (agent-as-employee-model 3.3): what a role would
  // contribute to a new genome version — declarations + active competence refs,
  // never memory entries. Creating the genome version stays the studio's job.
  router.get("/:id/members/:memberId/role/promotion", (req, res) => {
    const o = owned(req, res); if (!o) return;
    const r = getFleetDatabase().promotionPayload(o.fleet.id, req.params.memberId, { actor: o.user.email });
    if (r.error) return res.status(404).json(r);
    res.json(r);
  });

  // Clone a role into another fleet/member (agent-as-employee-model 3.2).
  // Authorization: the caller must own BOTH fleets — the source holds the memory
  // being copied, the target receives it.
  router.post("/:id/members/:memberId/role/clone", (req, res) => {
    const o = owned(req, res); if (!o) return;
    const db = getFleetDatabase();
    const toFleetId = req.body?.toFleetId;
    const toMemberId = req.body?.toMemberId;
    if (typeof toFleetId !== "string" || typeof toMemberId !== "string") {
      return res.status(400).json({ error: "toFleetId and toMemberId are required" });
    }
    const target = db.getFleet(toFleetId);
    if (!target) return res.status(404).json({ error: "target fleet not found" });
    if (target.ownerEmail !== o.user.email) return res.status(403).json({ error: "not your target fleet" });
    const toMember = db.getMember(toMemberId);
    if (!toMember || toMember.fleetId !== toFleetId) return res.status(404).json({ error: "target member not found" });
    const r = db.cloneRole({
      from: { fleetId: o.fleet.id, memberId: req.params.memberId },
      to: { fleetId: toFleetId, memberId: toMemberId },
      authorizedBy: o.user.email,
    });
    if (r.error) return res.status(r.error.includes("not found") ? 404 : 409).json(r);
    res.status(201).json(r);
  });

  // Growth trail for the whole fleet (agent-as-employee-model 1.4/2.x):
  // one row per post — current version, the latest change's source and who made
  // it, and how many patches await the owner. Reads only; no new state.
  // 团队能力视图（capability-layer scope=team）：这个团队各岗实际拿到什么。
  //
  // 数据来自**已装 pack 的 manifest**，不是运行时状态——能力的真源是包，
  // 舰队只是它的一个实例。查不到来源包或 manifest 读不出时如实说明，
  // 不返回空表（空表会让读者以为这个团队没有能力）。
  router.get("/:id/capabilities", (req, res) => {
    const o = owned(req, res); if (!o) return;
    const packId = o.fleet.sourceTemplate?.packId ?? null;
    if (!packId) {
      return res.json({ fleetId: o.fleet.id, ok: false, reason: "this team was not built from a pack" });
    }
    let manifest = null;
    try {
      manifest = dbModule.getInstalledPack(packId)?.manifest ?? null;
      if (typeof manifest === "string") manifest = JSON.parse(manifest);
    } catch {
      manifest = null;
    }
    if (!manifest) {
      return res.json({ fleetId: o.fleet.id, ok: false, packId, reason: `pack '${packId}' manifest is not readable on this cell` });
    }
    const memberRef = typeof req.query.memberRef === "string" ? req.query.memberRef : null;
    const derived = deriveCapabilities(manifest, { scope: "team", memberRef });
    if (derived?.error) return res.status(400).json(derived);
    // 只回能力表与 skills 的未解析项：团队视角不需要把 pillars 整块搬过来
    // （那是 pack 详情面的活），多带一份会让两个面各说一套。
    return res.json({
      fleetId: o.fleet.id,
      ok: true,
      packId,
      memberRef,
      capabilities: derived.capabilities,
      unresolvedSkills: derived.skills?.unresolved ?? [],
    });
  });

  router.get("/:id/roles", (req, res) => {
    const o = owned(req, res); if (!o) return;
    const db = getFleetDatabase();
    const pending = db.listGuidancePatches({ fleetId: o.fleet.id, state: "pending" });
    const roles = db.listRoleStates(o.fleet.id).map((r) => {
      const versions = db.listRoleVersions(o.fleet.id, r.memberId);
      const latest = versions.at(-1) ?? null;
      return {
        memberId: r.memberId,
        title: db.getMember(r.memberId)?.title ?? null,
        currentVersion: db.currentRoleVersion(o.fleet.id, r.memberId),
        latestSource: latest?.source ?? null,
        latestActor: latest?.actor ?? null,
        latestAt: latest?.createdAt ?? null,
        changes: versions.length,
        pendingPatches: pending.filter((p) => p.memberId === r.memberId).length,
      };
    });
    res.json({ roles });
  });

  // Audience views (agent-as-employee-model 5.2-5.3). Each source is read
  // independently so one failing source degrades only its own fields.
  const attempt = (fn) => { try { return { ok: true, value: fn() }; } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 200) }; } };
  router.get("/:id/views/:audience", (req, res) => {
    const o = owned(req, res); if (!o) return;
    const { audience } = req.params;
    if (!AUDIENCES.includes(audience)) return res.status(400).json({ error: `audience must be one of ${AUDIENCES.join("|")}` });
    const memberId = typeof req.query.memberId === "string" ? req.query.memberId : null;
    const db = getFleetDatabase();
    if (memberId) {
      const m = db.getMember(memberId);
      if (!m || m.fleetId !== o.fleet.id) return res.status(404).json({ error: "member not found" });
    }
    const fid = o.fleet.id;
    const facts = {
      spend: attempt(() => db.spendProjection(fid)),
      turns: attempt(() => db.listFleetTurnEvents(fid, { limit: 50 }).filter((t) => !memberId || t.memberId === memberId)),
      reports: attempt(() => [...db.latestReports(fid).values()].filter((r) => audience !== "self" || r.memberId === memberId)),
      openDecisions: attempt(() => db.listDecisions({ fleetId: fid, state: "open", ...(audience === "self" ? { memberId } : {}) })),
      ...(memberId ? {
        role: attempt(() => db.getRoleState(fid, memberId) ?? (() => { throw new Error("no role state"); })()),
        member: attempt(() => db.getMember(memberId)),
      } : {}),
      // teamNotices / memoryScope: no source wired yet — reported as undeclared, not faked.
    };
    const view = project(audience, facts, { memberId });
    if (view.error) return res.status(400).json(view);
    res.json({ fleetId: fid, sampledAt: Date.now(), ...view });
  });

  app.use(mount, router);
}
