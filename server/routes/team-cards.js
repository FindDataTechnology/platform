// server/routes/team-cards.js — the cell side of the team directory (openspec:
// add-agent-team-directory, tasks 2.1–2.2).
//
// Two jobs, both owner-scoped:
//   • the WRITE face the owner drives from the cockpit (publish / patch /
//     withdraw), and
//   • the SAMPLING face the platform gateway reads (`GET /api/teams/cards`).
//
// The sampling face deliberately returns the same payload shape the gateway
// projects ({v, sampledAt, cards[]}) so "what the gateway sees" is inspectable
// with curl on one cell — the same shape `gateway/fleet-board.js` established.
//
// Disclosure discipline (design D6 + 附录 A): a fleet that is not yours, and a
// fleet that does not exist, answer with the SAME 404 body. The existing fleet
// routes answer 403 for "not yours"; that is their contract and must not be
// copied here — an existence oracle is exactly what a directory must not be.
//
// `cellId` is this cell's owner email. The gateway keys its directory by
// `cell.email`, so the two agree without either side inventing an id.

import { getFleetDatabase } from "./fleets-db.js";
import {
  ensureTeamCardsTable,
  publishCard,
  deleteCard,
  getPublication,
  deriveCard,
  listPublications,
  validatePublication,
  cellIdFor,
  HANDLE_PATTERN,
} from "../team-card.js";
import { createTeamServing } from "../team-serving.js";
import {
  ensureTeamApprovalsTable,
  requestApproval,
  listPendingApprovals,
  listApprovals,
  approveCaller,
  rejectCaller,
  approvalStateFor,
} from "../team-approvals.js";
import { createPlatformCallerIdentity } from "../caller-identity.js";

const NOT_FOUND = { error: "not found" };

function identity(req) {
  return req.ssoUser || req.user || null;
}

// Two handles on the same sqlite file: the fleet facade (`getFleet`,
// `listMembers`) and the raw better-sqlite3 handle the card tables use. Kept in
// one place so a future caller cannot mix them up.
function stores() {
  const fleetDb = getFleetDatabase();
  return { fleetDb, cards: fleetDb.db };
}

export function registerTeamCardRoutes(ctx) {
  const { app } = ctx;
  const cellId = () => cellIdFor(ctx.cellUserEmail);

  // Boot-time DDL: a cell that never publishes still gets the (empty) tables, so
  // an upgrade cannot fail on first write.
  try {
    ensureTeamCardsTable(stores().cards);
    ensureTeamApprovalsTable(stores().cards);
  } catch (err) {
    console.warn(`[team-cards] table init deferred: ${err?.message || err}`);
  }

  // Cells are single-owner: the sampling face may only ever be answered for the
  // cell's own owner (the gateway forwards that identity). Any other signed-in
  // identity gets the same 404 an unknown card produces — a non-owner must not
  // be able to read another tenant's published cards, and must not learn that
  // they exist.
  const requireOwner = (req, res) => {
    if (!ctx.authEnabled) return { email: ctx.cellUserEmail || "owner@local" };
    const user = identity(req);
    if (!user?.email) {
      res.status(401).json({ error: "Authentication is required" });
      return null;
    }
    const owner = ctx.cellUserEmail ? String(ctx.cellUserEmail).trim().toLowerCase() : null;
    if (owner && String(user.email).trim().toLowerCase() !== owner) {
      res.status(404).json(NOT_FOUND);
      return null;
    }
    return user;
  };

  // ── sampling face (gateway reads this) ────────────────────────────────────
  app.get("/api/teams/cards", (req, res) => {
    const user = requireOwner(req, res);
    if (!user) return;
    try {
      const { fleetDb, cards: db } = stores();
      ensureTeamCardsTable(db);
      const fleetsById = new Map();
      const membersByFleet = new Map();
      const now = Date.now();
      const cards = [];
      for (const publication of listPublications(db)) {
        // `private` never leaves the cell, not even to the platform sampler.
        if (publication.visibility === "private") continue;
        let fleet = fleetsById.get(publication.fleetId);
        if (fleet === undefined) {
          fleet = fleetDb.getFleet(publication.fleetId);
          fleetsById.set(publication.fleetId, fleet);
        }
        if (!fleet) continue; // team deleted behind the card → it stops appearing
        let members = membersByFleet.get(publication.fleetId);
        if (members === undefined) {
          members = fleetDb.listMembers(publication.fleetId);
          membersByFleet.set(publication.fleetId, members);
        }
        const card = deriveCard({ fleet, members, publication, now });
        cards.push({
          handle: publication.handle,
          // Published policy, not internal data: a caller has to know whether
          // calling needs the owner's approval (`listed`) or not (`open`).
          visibility: publication.visibility,
          target: { kind: "fleet", id: publication.fleetId },
          card,
        });
      }
      res.json({ v: 1, sampledAt: now, cards });
    } catch (err) {
      console.error(`[team-cards] sample failed: ${err?.message || err}`);
      res.status(500).json({ error: "team cards unavailable" });
    }
  });

  // ── a2a call door (add-team-as-a2a-agent 3.3) ─────────────────────────────
  //
  // Registered only when the cell can actually DISPATCH (task 3.4 wires the
  // existing fleet dispatch). A door that accepts a call and cannot answer it
  // would burn the caller's quota to produce an internal error — so the honest
  // state until then is "this cell does not serve team calls", which the
  // gateway reports as `not_serving` rather than 500 (task 6.3).
  if (typeof ctx.teamDispatch === "function") {
    const identityFor = () =>
      createPlatformCallerIdentity({
        resolveSession: ({ headers }) => {
          const auth = headers?.authorization;
          if (typeof auth === "string" && auth.startsWith("Bearer ") && typeof ctx.appAuth?.sessionEligibleToken === "function") {
            // Same credential polity as every other door: steward tokens are
            // reporting-only and never speak for the account here.
            return ctx.appAuth.sessionEligibleToken(auth.slice(7));
          }
          return null;
        },
      });
    let serving = null;
    const getServing = () => {
      if (!serving) {
        const { fleetDb, cards: db } = stores();
        ensureTeamCardsTable(db);
        ensureTeamApprovalsTable(db);
        serving = createTeamServing({
          db,
          fleetDb,
          cellId,
          ownerEmail: ctx.cellUserEmail ?? null,
          callerIdentity: identityFor(),
          dispatch: ctx.teamDispatch,
          approvalsFor: (handle) => listApprovals(db, { cellId: cellId(), handle }),
          onNeedsApproval: ({ handle, caller }) => requestApproval(db, { cellId: cellId(), handle, caller }),
          deliver: typeof ctx.teamDeliver === "function" ? ctx.teamDeliver : null,
          ...(Number.isFinite(ctx.teamSyncWindowMs) ? { syncWindowMs: ctx.teamSyncWindowMs } : {}),
        });
      }
      return serving;
    };
    app.post("/api/teams/:handle/a2a", (req, res) => void getServing().handlePost(req, res));
    app.get("/api/teams/:handle/a2a", (req, res) => getServing().handleGet(req, res));
    // 7.1: the `listed` callers' door. It only records intent — the call itself
    // still goes through the a2a endpoint after the owner decides.
    app.post("/api/teams/:handle/request", async (req, res) => {
      const { cards: db } = stores();
      ensureTeamApprovalsTable(db);
      const resolved = await identityFor().resolve({ headers: req.headers, session: identity(req) });
      if (!resolved.ok) return res.status(401).json({ error: "unauthorized" });
      const handle = String(req.params.handle || "").trim().toLowerCase();
      const publication = getPublication(db, cellId(), handle);
      if (!publication || publication.visibility === "private") return res.status(404).json(NOT_FOUND);
      const out = requestApproval(db, { cellId: cellId(), handle, caller: resolved.caller.subject });
      if (!out.ok) return res.status(400).json({ error: out.error });
      res.json({ state: out.status });
    });
    app.get("/api/teams/:handle/request", async (req, res) => {
      const { cards: db } = stores();
      ensureTeamApprovalsTable(db);
      const resolved = await identityFor().resolve({ headers: req.headers, session: identity(req) });
      if (!resolved.ok) return res.status(401).json({ error: "unauthorized" });
      const handle = String(req.params.handle || "").trim().toLowerCase();
      const publication = getPublication(db, cellId(), handle);
      if (!publication || publication.visibility === "private") return res.status(404).json(NOT_FOUND);
      res.json({ state: approvalStateFor(db, { cellId: cellId(), handle, caller: resolved.caller.subject }) });
    });

    // 5.3: a converted-to-async call must be CHECKABLE by the party that made
    // it — otherwise "we'll notify you" is an unverifiable promise.
    app.get("/api/teams/calls/:callId", async (req, res) => {
      const resolved = await identityFor().resolve({ headers: req.headers, session: identity(req) });
      if (!resolved.ok) return res.status(401).json({ error: "unauthorized" });
      const row = getServing().getCallFor(resolved.caller.subject, String(req.params.callId || ""));
      if (!row) return res.status(404).json(NOT_FOUND);
      res.json({ call: row });
    });
  }

  // ── write face (owner) ────────────────────────────────────────────────────

  // Dry run behind the publish dialog's live preview ("所见即所发"): the SAME
  // derivation the write performs, with the SAME validation, and zero writes.
  // A client that re-implemented the card here would drift from the server the
  // first time a field changes; a client that saved-then-previewed would leak a
  // write the owner never confirmed.
  app.post("/api/teams/cards/preview", (req, res) => {
    const user = requireOwner(req, res);
    if (!user) return;
    try {
      const { fleetDb, cards: db } = stores();
      ensureTeamCardsTable(db);
      const { fleetId, ...publication } = req.body ?? {};
      const fleet = typeof fleetId === "string" ? fleetDb.getFleet(fleetId) : null;
      if (!fleet || fleet.ownerEmail !== user.email) return res.status(404).json(NOT_FOUND);
      const existing = listPublications(db).find((p) => p.fleetId === fleet.id) ?? null;
      const validity = validatePublication(publication, existing);
      if (!validity.ok) return res.status(400).json({ error: validity.error, code: "bad_request", field: validity.field });
      const now = Date.now();
      const draft = {
        cellId: cellId(),
        handle: validity.normalized.handle ?? existing?.handle ?? "",
        fleetId: fleet.id,
        ...validity.normalized,
        publishedBy: user.email,
        publishedAt: existing?.publishedAt ?? now,
        updatedAt: now,
      };
      res.json({
        card: deriveCard({ fleet, members: fleetDb.listMembers(fleet.id), publication: draft, now }),
        fallbacks: validity.fallbacks,
      });
    } catch (err) {
      console.error(`[team-cards] preview failed: ${err?.message || err}`);
      res.status(500).json({ error: "preview failed" });
    }
  });

  // Publish or update. `fleetId` is required on the first publish; a later patch
  // may omit it and keep the existing team.
  const write = (req, res) => {
    const user = requireOwner(req, res);
    if (!user) return;
    const handle = String(req.params.handle || "").trim().toLowerCase();
    if (!HANDLE_PATTERN.test(handle)) return res.status(404).json(NOT_FOUND);
    try {
      const { fleetDb, cards: db } = stores();
      ensureTeamCardsTable(db);
      const existing = getPublication(db, cellId(), handle);
      // `fleetId` addresses the team; it is not a publication field, and
      // `validatePublication` refuses unknown keys (a typo must not silently do
      // nothing), so it is stripped here rather than whitelisted there.
      const { fleetId: bodyFleetId, ...publication } = req.body ?? {};
      const fleetId = typeof bodyFleetId === "string" ? bodyFleetId : existing?.fleetId;
      const fleet = fleetId ? fleetDb.getFleet(fleetId) : null;
      // Not-yours and unknown are the same answer.
      if (!fleet || fleet.ownerEmail !== user.email) return res.status(404).json(NOT_FOUND);
      if (req.method === "PATCH" && !existing) return res.status(404).json(NOT_FOUND);

      const result = publishCard(db, {
        cellId: cellId(),
        fleet,
        members: fleetDb.listMembers(fleet.id),
        owner: user.email,
        input: { ...publication, handle },
      });
      if (!result.ok) {
        if (result.code === "not_owner" || result.code === "not_found") return res.status(404).json(NOT_FOUND);
        return res.status(400).json({ error: result.error, code: result.code });
      }
      res.status(req.method === "POST" ? 201 : 200).json({
        publication: result.publication,
        card: result.card,
        fallbacks: result.fallbacks,
        servingPosts: result.servingPosts,
      });
    } catch (err) {
      console.error(`[team-cards] publish failed: ${err?.message || err}`);
      res.status(500).json({ error: "publish failed" });
    }
  };
  app.post("/api/teams/cards/:handle", write);
  app.patch("/api/teams/cards/:handle", write);

  app.delete("/api/teams/cards/:handle", (req, res) => {
    const user = requireOwner(req, res);
    if (!user) return;
    const handle = String(req.params.handle || "").trim().toLowerCase();
    if (!HANDLE_PATTERN.test(handle)) return res.status(404).json(NOT_FOUND);
    try {
      const { fleetDb, cards: db } = stores();
      ensureTeamCardsTable(db);
      const existing = getPublication(db, cellId(), handle);
      if (!existing) return res.status(404).json(NOT_FOUND);
      const fleet = fleetDb.getFleet(existing.fleetId);
      const result = deleteCard(db, {
        cellId: cellId(),
        handle,
        owner: user.email,
        fleet,
        isAdmin: Boolean(ctx.isAdminUser?.(user)),
      });
      if (!result.ok) return res.status(404).json(NOT_FOUND);
      res.json({ ok: true, handle });
    } catch (err) {
      console.error(`[team-cards] withdraw failed: ${err?.message || err}`);
      res.status(500).json({ error: "withdraw failed" });
    }
  });

  // The cockpit's own read (add-agent-team-directory 4.3): "is this team
  // published, and as what?" — including a `private` card, which the sampling
  // face deliberately hides. Kept separate from `GET /api/teams/cards` so the
  // payload the gateway samples never depends on a UI convenience.
  app.get("/api/teams/cards/for-fleet/:fleetId", (req, res) => {
    const user = requireOwner(req, res);
    if (!user) return;
    const fleetId = String(req.params.fleetId || "");
    try {
      const { fleetDb, cards: db } = stores();
      ensureTeamCardsTable(db);
      const fleet = fleetDb.getFleet(fleetId);
      // Not-yours and unknown are the same answer, exactly like the write face.
      if (!fleet || fleet.ownerEmail !== user.email) return res.status(404).json(NOT_FOUND);
      const publication = listPublications(db).find((p) => p.fleetId === fleetId) ?? null;
      res.json({
        publication,
        card: publication ? deriveCard({ fleet, members: fleetDb.listMembers(fleet.id), publication }) : null,
      });
    } catch (err) {
      console.error(`[team-cards] cockpit read failed: ${err?.message || err}`);
      res.status(500).json({ error: "read failed" });
    }
  });

  // The owner's approval queue (7.2). Owner-only like every other cockpit read;
  // a caller never sees who else asked.
  app.get("/api/teams/cards/:handle/approvals", (req, res) => {
    const user = requireOwner(req, res);
    if (!user) return;
    const handle = String(req.params.handle || "").trim().toLowerCase();
    if (!HANDLE_PATTERN.test(handle)) return res.status(404).json(NOT_FOUND);
    try {
      const { cards: db } = stores();
      ensureTeamApprovalsTable(db);
      const publication = getPublication(db, cellId(), handle);
      if (!publication) return res.status(404).json(NOT_FOUND);
      res.json({
        pending: listPendingApprovals(db, { cellId: cellId(), handle }),
        approved: listApprovals(db, { cellId: cellId(), handle }),
      });
    } catch (err) {
      console.error(`[team-cards] approvals read failed: ${err?.message || err}`);
      res.status(500).json({ error: "read failed" });
    }
  });

  app.post("/api/teams/cards/:handle/approvals", (req, res) => {
    const user = requireOwner(req, res);
    if (!user) return;
    const handle = String(req.params.handle || "").trim().toLowerCase();
    if (!HANDLE_PATTERN.test(handle)) return res.status(404).json(NOT_FOUND);
    const caller = String(req.body?.caller || "").trim();
    if (!caller) return res.status(400).json({ error: "caller required", field: "caller" });
    const expiresAt = req.body?.expiresAt == null ? null : Number(req.body.expiresAt);
    if (expiresAt != null && !Number.isFinite(expiresAt)) {
      return res.status(400).json({ error: "expiresAt must be an epoch ms or null", field: "expiresAt" });
    }
    try {
      const { cards: db } = stores();
      ensureTeamApprovalsTable(db);
      const publication = getPublication(db, cellId(), handle);
      if (!publication) return res.status(404).json(NOT_FOUND);
      const out = approveCaller(db, { cellId: cellId(), handle, caller, by: user.email, expiresAt });
      if (!out.ok) return res.status(404).json(NOT_FOUND);
      res.json({ ok: true, caller: caller.toLowerCase(), expiresAt });
    } catch (err) {
      console.error(`[team-cards] approve failed: ${err?.message || err}`);
      res.status(500).json({ error: "approve failed" });
    }
  });

  app.delete("/api/teams/cards/:handle/approvals/:caller", (req, res) => {
    const user = requireOwner(req, res);
    if (!user) return;
    const handle = String(req.params.handle || "").trim().toLowerCase();
    if (!HANDLE_PATTERN.test(handle)) return res.status(404).json(NOT_FOUND);
    try {
      const { cards: db } = stores();
      ensureTeamApprovalsTable(db);
      const publication = getPublication(db, cellId(), handle);
      if (!publication) return res.status(404).json(NOT_FOUND);
      const out = rejectCaller(db, { cellId: cellId(), handle, caller: String(req.params.caller || ""), by: user.email });
      if (!out.ok) return res.status(404).json(NOT_FOUND);
      res.json({ ok: true });
    } catch (err) {
      console.error(`[team-cards] reject failed: ${err?.message || err}`);
      res.status(500).json({ error: "reject failed" });
    }
  });

  // Single-card read for the owner's cockpit (never used for discovery).
  app.get("/api/teams/cards/:handle", (req, res) => {
    const user = requireOwner(req, res);
    if (!user) return;
    const handle = String(req.params.handle || "").trim().toLowerCase();
    if (!HANDLE_PATTERN.test(handle)) return res.status(404).json(NOT_FOUND);
    try {
      const { fleetDb, cards: db } = stores();
      ensureTeamCardsTable(db);
      const publication = getPublication(db, cellId(), handle);
      if (!publication) return res.status(404).json(NOT_FOUND);
      const fleet = fleetDb.getFleet(publication.fleetId);
      if (!fleet || fleet.ownerEmail !== user.email) return res.status(404).json(NOT_FOUND);
      res.json({
        publication,
        card: deriveCard({ fleet, members: fleetDb.listMembers(fleet.id), publication }),
      });
    } catch (err) {
      console.error(`[team-cards] read failed: ${err?.message || err}`);
      res.status(500).json({ error: "read failed" });
    }
  });
}

// Re-exported for the gateway-side tests that pin the closed sets.
export { validatePublication };
