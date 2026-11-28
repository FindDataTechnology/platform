// Facet fleet organization API (facet-owns-its-fleets 2.x).
//
// Everything here reads and writes the facet's OWN store (fleet-db.js →
// FACET_DATA_ROOT/fleets.db). There is deliberately no outbound call: the
// facet-platform spec's independence requirement means the fleet list and a
// team's organization detail must answer with 壹座 entirely down (task 2.1's
// check greps this file for a cross-domain URL).
//
// Boundaries kept here:
//   · organization only — no dispatch, no runner, no turn. The console view
//     model always carries `executor: null` and its posts are `vacant`
//     ("no executor attached"), never a runtime status (spec: 只管不跑).
//   · `origin` decides writability — a fleet mirrored from the platform
//     ('platform') answers 409 for every write, with the reason in the body.
//   · the shared console view model is the same wire shape the 壹座 console
//     serves, so the same TeamConsole/ConsoleBody renderers mount unchanged.

import path from "node:path";
import { Router } from "express";
import { createFleetDatabase } from "./fleets-db.js";

const CONSOLE_SLUG_MAX = 40;

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// Same derivation discipline as the platform's console slug: derived from the
// team name (never user-typed), NFKD-folded, Chinese kept readable.
function slugBase(name) {
  return Array.from(
    String(name ?? "")
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, ""),
  )
    .slice(0, CONSOLE_SLUG_MAX)
    .join("");
}

function deriveConsoleSlug(db, fleet) {
  const base = slugBase(fleet.name) || "team";
  const tail = String(fleet.id).replace(/[^a-z0-9]/gi, "").slice(-4).toLowerCase() || "team";
  for (const candidate of [base, `${base}-${tail}`]) {
    const owner = db.getFleetByConsoleSlug(candidate);
    if (!owner || owner.id === fleet.id) return candidate;
  }
  return `${base}-${tail}-${Date.now().toString(36)}`;
}

// ── Console view model ──────────────────────────────────────────────────────
// The organization projection of the shared ConsoleViewModel. Blocks whose
// data source is an execution plane (reports, runs, spend) are ABSENT with
// their honest reason — never a zero and never a fabricated status.
function buildFleetConsoleView({ db, fleet, surface }) {
  const now = Date.now();
  const members = db.listMembers(fleet.id);
  const edges = db.listEdges(fleet.id);
  // The owner's approval queue is an owner-side surface; a share page renders
  // organization only.
  const decisions = surface === "share" ? [] : db.listDecisions({ fleetId: fleet.id, state: "open" });

  const statusCounts = {};
  for (const _ of members) statusCounts.vacant = (statusCounts.vacant ?? 0) + 1;

  const blocks = [
    members.length
      ? {
          block: "team",
          state: "ready",
          data: {
            fleet: { id: fleet.id, name: fleet.name, state: fleet.state },
            statusCounts,
            members: members.map((m) => ({
              id: m.id,
              title: m.title,
              parentId: m.parentId,
              targetKind: null,
              // No executor is attached in the facet: the honest state is
              // "vacant", with the machine-readable reason riding along.
              status: "vacant",
              statusReason: "no_executor",
              kpiSlots: m.kpiSlots ?? [],
              cadence: m.cadence ?? null,
              latestReportAt: null,
              missedRounds: 0,
              skippedRounds: 0,
            })),
            sampledAt: now,
          },
        }
      : { block: "team", state: "absent", absentReason: "no_members" },
    { block: "kpi", state: "absent", absentReason: "no_reported_kpis" },
    decisions.length
      ? {
          block: "decisions",
          state: "ready",
          data: {
            open: decisions.length,
            items: decisions.map((d) => ({
              id: d.id,
              severity: d.severity,
              memberId: d.memberId,
              memberTitle: members.find((m) => m.id === d.memberId)?.title ?? null,
              summary: d.question,
              submittedAt: d.submittedAt,
              expiresAt: null,
            })),
            sampledAt: now,
          },
        }
      : { block: "decisions", state: "absent", absentReason: "no_open_decisions" },
    edges.length
      ? {
          block: "orchestration",
          state: "ready",
          data: {
            declared: { edges: edges.map((e) => ({ kind: e.kind, from: e.from, to: e.to })) },
            expanded: edges.map((e) => ({ kind: e.kind, from: e.from, to: e.to })),
            sampledAt: now,
          },
        }
      : { block: "orchestration", state: "absent", absentReason: "not_declared" },
    { block: "spend", state: "absent", absentReason: "no_run_records" },
  ];

  return {
    v: 1,
    fleet: {
      id: fleet.id,
      name: fleet.name,
      state: fleet.state,
      origin: fleet.origin,
      published: Boolean(fleet.consoleSlug),
      slug: fleet.consoleSlug ?? null,
    },
    surface,
    // Explicit "no executor attached" — the renderer MUST NOT read this as a
    // runtime state (spec: 未接入执行方 is its own state).
    executor: null,
    headline: null,
    blocks,
    sampledAt: now,
  };
}

function fleetDetail({ db, fleet }) {
  return {
    fleet,
    executor: null,
    members: db.listMembers(fleet.id),
    edges: db.listEdges(fleet.id),
    decisions: db.listDecisions({ fleetId: fleet.id }),
  };
}

/**
 * Mount `/api/fleets*` on an express app.
 *
 * @param {import("express").Express} app
 * @param {object} opts
 * @param {(req: any) => ({email: string, groups?: string[]} | null)} opts.resolveUser
 * @param {string} opts.dataRoot  FACET_DATA_ROOT (fleets.db lives here)
 * @param {object} [opts.fleetDb] test seam
 * @param {string[]} [opts.adminGroups]
 */
export function registerFleetRoutes(app, { resolveUser, dataRoot, fleetDb = null, adminGroups = [] }) {
  const db = fleetDb ?? createFleetDatabase({ file: path.join(dataRoot, "fleets.db") });
  const router = Router();

  const isAdmin = (user) => adminGroups.some((g) => (user?.groups ?? []).includes(g));
  const canSee = (user, fleet) => fleet && (fleet.ownerEmail === user.email || isAdmin(user));

  // 401 for anonymous, 404 for a fleet the caller may not see (existence is not
  // leaked), 403 never: "not yours" and "missing" look identical here.
  const ownFleet = (req, res) => {
    const user = resolveUser(req);
    if (!user) {
      res.status(401).json({ error: "Authentication required", loginUrl: "/auth/login" });
      return null;
    }
    const fleet = db.getFleet(req.params.id);
    if (!canSee(user, fleet)) {
      res.status(404).json({ error: "Fleet not found" });
      return null;
    }
    // D2 origin gate: a platform-mirrored fleet is a read-only copy.
    if (fleet.origin === "platform") {
      res.status(409).json({
        error: "该团队来自平台（origin=platform），谦面只保留只读镜像，不能在谦面修改。请在壹座里管理它，或在本域另建一支团队。",
        code: "FLEET_ORIGIN_READONLY",
      });
      return null;
    }
    return { user, fleet };
  };

  // ── read face ─────────────────────────────────────────────────────────────
  router.get("/", (req, res) => {
    const user = resolveUser(req);
    if (!user) return res.status(401).json({ error: "Authentication required", loginUrl: "/auth/login" });
    const fleets = isAdmin(user) && req.query.all === "1" ? db.listFleets() : db.listFleets({ ownerEmail: user.email });
    res.json({ fleets, executor: null });
  });

  // Share page address: the slug is the only key a visitor has. An
  // unpublished or unknown slug answers exactly the same 404.
  router.get("/by-slug/:slug/console", (req, res) => {
    const fleet = db.getFleetByConsoleSlug(String(req.params.slug ?? "").trim());
    if (!fleet || !fleet.consoleSlug) return res.status(404).json({ error: "Not published" });
    res.json(buildFleetConsoleView({ db, fleet, surface: "share" }));
  });

  router.get("/:id/console", (req, res) => {
    const user = resolveUser(req);
    if (!user) return res.status(401).json({ error: "Authentication required", loginUrl: "/auth/login" });
    const fleet = db.getFleet(req.params.id);
    if (!canSee(user, fleet)) return res.status(404).json({ error: "Fleet not found" });
    if (req.query?.surface === "share" && !fleet.consoleSlug) return res.status(404).json({ error: "Not published" });
    const surface = req.query?.surface === "share" ? "share" : "platform";
    res.json(buildFleetConsoleView({ db, fleet, surface }));
  });

  router.get("/:id", (req, res) => {
    const user = resolveUser(req);
    if (!user) return res.status(401).json({ error: "Authentication required", loginUrl: "/auth/login" });
    const fleet = db.getFleet(req.params.id);
    if (!canSee(user, fleet)) return res.status(404).json({ error: "Fleet not found" });
    res.json(fleetDetail({ db, fleet }));
  });

  // ── create ────────────────────────────────────────────────────────────────
  // A facet-created fleet is born with origin='facet' (writable) and, unless
  // asked otherwise, unpublished — a share link is an explicit act.
  router.post("/", (req, res) => {
    const user = resolveUser(req);
    if (!user) return res.status(401).json({ error: "Authentication required", loginUrl: "/auth/login" });
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (!name) return res.status(400).json({ error: "name is required" });
    const fleet = db.createFleet({ id: newId("flt"), name, ownerEmail: user.email, state: "paused", origin: "facet" });

    const idByRef = new Map();
    for (const [i, m] of (Array.isArray(req.body?.members) ? req.body.members : []).entries()) {
      if (!m || typeof m.title !== "string" || !m.title.trim()) continue;
      const id = newId("fm");
      if (typeof m.ref === "string" && m.ref) idByRef.set(m.ref, id);
      db.createMember({
        id,
        fleetId: fleet.id,
        title: m.title.trim(),
        // parentRef resolves within the same payload; a forward reference is
        // left null rather than guessed.
        parentId: typeof m.parentRef === "string" ? (idByRef.get(m.parentRef) ?? null) : null,
        cadence: m.cadence && typeof m.cadence === "object" ? m.cadence : null,
        kpiSlots: Array.isArray(m.kpiSlots) ? m.kpiSlots : [],
        harness: typeof m.harness === "string" && m.harness ? m.harness : null,
        sortKey: i,
      });
    }
    const memberIds = new Set(db.listMembers(fleet.id).map((m) => m.id));
    for (const [i, e] of (Array.isArray(req.body?.edges) ? req.body.edges : []).entries()) {
      if (!e || typeof e.kind !== "string" || !e.kind) continue;
      const from = idByRef.get(e.from) ?? e.from;
      const to = idByRef.get(e.to) ?? e.to;
      if (!memberIds.has(from) || !memberIds.has(to)) continue;
      db.createEdge({ id: newId("fe"), fleetId: fleet.id, kind: e.kind, from, to, sortKey: i });
    }
    res.status(201).json(fleetDetail({ db, fleet: db.getFleet(fleet.id) }));
  });

  // ── write face ────────────────────────────────────────────────────────────
  router.patch("/:id", (req, res) => {
    const owned = ownFleet(req, res);
    if (!owned) return;
    const { fleet } = owned;
    const updates = {};
    if (typeof req.body?.name === "string" && req.body.name.trim()) updates.name = req.body.name.trim();
    if (typeof req.body?.state === "string") updates.state = req.body.state;
    // Publishing is part of the same row edit: an explicit act that derives the
    // share slug (mirrors the platform's publish gate without a second route).
    if (req.body?.published === true && !fleet.consoleSlug) {
      updates.consoleSlug = deriveConsoleSlug(db, fleet);
      updates.consolePublishedAt = Date.now();
    }
    if (req.body?.published === false) {
      updates.consoleSlug = null;
      updates.consolePublishedAt = null;
    }
    const next = db.updateFleet(fleet.id, updates);
    res.json(fleetDetail({ db, fleet: next }));
  });

  router.delete("/:id", (req, res) => {
    const owned = ownFleet(req, res);
    if (!owned) return;
    res.json(db.deleteFleet(owned.fleet.id));
  });

  // A post's declaration edits: cadence, KPI slots, execution harness (a
  // declaration string, any value accepted — the facet never validates an
  // executor), title.
  router.patch("/:id/members/:memberId", (req, res) => {
    const owned = ownFleet(req, res);
    if (!owned) return;
    const member = db.getMember(req.params.memberId);
    if (!member || member.fleetId !== owned.fleet.id) return res.status(404).json({ error: "Member not found" });
    const updates = {};
    if (typeof req.body?.title === "string" && req.body.title.trim()) updates.title = req.body.title.trim();
    if (Object.hasOwn(req.body ?? {}, "cadence")) {
      updates.cadence = req.body.cadence && typeof req.body.cadence === "object" ? req.body.cadence : null;
    }
    if (Array.isArray(req.body?.kpiSlots)) updates.kpiSlots = req.body.kpiSlots;
    if (Object.hasOwn(req.body ?? {}, "harness")) {
      updates.harness = typeof req.body.harness === "string" && req.body.harness ? req.body.harness : null;
    }
    res.json({ member: db.updateMember(member.id, updates) });
  });

  // Records the owner's ruling. Nothing is dispatched: the answer is a row,
  // and the executor (when one exists) reads it out of band.
  router.post("/:id/decisions/:decisionId/answer", (req, res) => {
    const owned = ownFleet(req, res);
    if (!owned) return;
    const item = db.getDecision(req.params.decisionId);
    if (!item || item.fleetId !== owned.fleet.id) return res.status(404).json({ error: "Decision not found" });
    const choice = req.body?.choice;
    if (choice == null || choice === "") return res.status(400).json({ error: "choice is required" });
    const answered = db.answerDecision(item.id, {
      choice,
      note: typeof req.body?.note === "string" ? req.body.note : null,
      by: owned.user.email,
    });
    if (!answered) return res.status(409).json({ error: `only open decisions can be answered (state: ${db.getDecision(item.id)?.state})` });
    res.json({ decision: answered });
  });

  app.use("/api/fleets", router);
  return { db };
}
