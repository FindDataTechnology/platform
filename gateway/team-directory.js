// gateway/team-directory.js — the cross-user directory (openspec:
// add-agent-team-directory, tasks 3.1–3.5).
//
// Why this lives in the gateway and not in a cell: cells are single-owner
// (`server/routes/fleets.js:1289`), so a cross-user read surface cannot live
// inside anyone's cell — that would make availability and authorisation depend
// on the party being read.
//
// Truth stays in the cell (`team_cards` next to the fleet, one transaction
// domain); the gateway stores NO copy and projects on read. A cell that cannot
// answer is DOWN for discovery this cycle, not a fake empty card — that is the
// whole reason there is no gateway-side table to go stale.
//
// Three disciplines inherited from `gateway/fleet-board.js` / `fleet-cells.js`:
//   • `{v, sampledAt}` envelope, so a reader can tell "empty" from "old";
//   • null on sampler failure = honest absence, never an error for the reader;
//   • per-cell timeout budget independent of the rest of the gateway.
// Plus two this file adds: a 60s TTL cache with single-flight that serves the
// previous value marked `stale` on expiry (blocking every reader on a slow cell
// would turn a cosmetic delay into an outage), and an explicit visibility
// matrix in one function so "who may see this" is one readable decision rather
// than an if-chain spread over handlers.

import http from "node:http";
import { forwardedHeaders } from "./proxy.js";

export const DIRECTORY_TTL_MS = 60_000;
export const DIRECTORY_CARD_LIMIT = 200;

const NOT_FOUND = { error: "not found" };
// Gateway-side refusal for a cell that has no team a2a door (an older image).
// Distinct from not_found on purpose: the team may well exist.
const NOT_SERVING = Object.freeze({ error: { code: "not_serving", message: "This deployment cannot serve team calls yet" } });

/** The directory's stable order: most recently published first. */
function compareCards(a, b) {
  const ap = a?.card?.trust?.publishedAt ?? 0;
  const bp = b?.card?.trust?.publishedAt ?? 0;
  if (ap !== bp) return bp - ap;
  if (a.cellId !== b.cellId) return a.cellId < b.cellId ? -1 : 1;
  return a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0;
}

// ── visibility matrix (D4) ──────────────────────────────────────────────────
//
// `private` is as-if-unpublished — the cell already refuses to sample it, and
// this second check is what keeps a future sampling change from leaking it.
// `listed` and `open` differ in the CALL door (approval vs whitelisted direct),
// never in the SEE door: a signed-in viewer sees both. When per-caller
// visibility is introduced, this function is the only place that changes.
export function canSeeCard(entry, viewer) {
  if (!viewer?.email) return false; // anonymous / guest / widget: D6 says no
  // A cell that predates the visibility field still samples only non-private
  // cards, so absence means "visible, door unknown" — conservative for the call
  // door, never for the see door.
  const visibility = entry?.visibility ?? entry?.card?.visibility ?? "listed";
  return visibility === "listed" || visibility === "open";
}

/**
 * @param {object} deps
 * @param {() => Array<{cellId, email?, port, state}>} deps.cells live cells
 * @param {(cell, path) => Promise<any|null>} deps.sampleCell null = unreachable
 * @param {() => number} [deps.now]
 * @param {number} [deps.ttlMs]
 */
export function createTeamDirectory({ cells, sampleCell, now = () => Date.now(), ttlMs = DIRECTORY_TTL_MS }) {
  /** cellId → { at, cards, degraded } */
  const cache = new Map();
  let inflight = null;

  async function sampleOne(cell) {
    const payload = await sampleCell(cell, "/api/teams/cards");
    if (!payload || !Array.isArray(payload.cards)) return { cards: [], degraded: cell.cellId };
    // A card is only trusted if it carries the envelope the cell promises.
    if (payload.v !== 1) return { cards: [], degraded: cell.cellId };
    return { cards: payload.cards, degraded: null };
  }

  function finish({ at, liveIds, degradedCells, stale }) {
    const cards = [];
    for (const id of liveIds) {
      const hit = cache.get(id);
      if (!hit || hit.degraded) continue;
      for (const entry of hit.cards) {
        cards.push({ ...entry, cellId: id, sampledAt: hit.at });
      }
    }
    cards.sort(compareCards);
    return {
      v: 1,
      // `sampledAt` is the OLDEST contributing sample, so a reader never
      // overestimates freshness. `cells` makes "nobody published" and "nothing
      // was sampled" distinguishable without guessing from an empty array.
      sampledAt: Math.min(...liveIds.map((id) => cache.get(id)?.at ?? at)),
      cells: { sampled: liveIds.length - degradedCells.length, degraded: degradedCells.length },
      degradedCells,
      cards,
      stale,
    };
  }

  async function refresh() {
    const live = cells();
    const results = await Promise.all(
      live.map(async (cell) => {
        const sampled = await sampleOne(cell);
        return { cell, ...sampled };
      }),
    );
    const at = now();
    for (const r of results) cache.set(r.cell.cellId, { at, cards: r.cards, degraded: r.degraded });
    // Cells that vanished from the live set drop out entirely.
    const liveIds = new Set(live.map((c) => c.cellId));
    for (const id of [...cache.keys()]) if (!liveIds.has(id)) cache.delete(id);
    const degradedCells = results.filter((r) => r.degraded).map((r) => r.degraded);
    return finish({ at, liveIds: [...liveIds], degradedCells, stale: false });
  }

  async function snapshot() {
    const at = now();
    const liveIds = cells().map((c) => c.cellId);
    if (liveIds.length === 0) {
      return { v: 1, sampledAt: at, cells: { sampled: 0, degraded: 0 }, degradedCells: [], cards: [], stale: false };
    }
    const fresh = liveIds.every((id) => {
      const hit = cache.get(id);
      return hit && at - hit.at < ttlMs;
    });
    const degradedCells = liveIds.filter((id) => cache.get(id)?.degraded ?? !cache.has(id)).filter(Boolean);
    if (fresh) return finish({ at, liveIds, degradedCells, stale: false });

    // Stale-serve: expired cache but something cached → answer now, refresh in
    // the background. Never await the slow cell.
    if (liveIds.some((id) => cache.has(id))) {
      void startRefresh();
      return finish({ at, liveIds, degradedCells, stale: true });
    }

    // Cold: nothing cached. Single-flight so N concurrent readers cost one round
    // of sampling, not N.
    return startRefresh();
  }

  function startRefresh() {
    inflight ??= refresh().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  return {
    snapshot,
    /** Test hook: drop the cache. */
    reset() {
      cache.clear();
      inflight = null;
    },
  };
}

// A list of 200 cards must stay a list, not a download: the listing carries a
// bounded summary (the first posts/skills) and says when it cut them. The deep
// link returns the whole card.
export const SUMMARY_POSTS_MAX = 20;

function summarizeEntry(entry) {
  const card = entry.card ?? {};
  const posts = Array.isArray(card.posts) ? card.posts : [];
  const skills = Array.isArray(card.skills) ? card.skills : [];
  return {
    ...entry,
    card: { ...card, posts: posts.slice(0, SUMMARY_POSTS_MAX), skills: skills.slice(0, SUMMARY_POSTS_MAX) },
    postsTruncated: posts.length > SUMMARY_POSTS_MAX,
  };
}

/** Stable ordering, the visibility filter, the summary projection, the limit. */
export function visibleCards(snapshot, { viewer, limit = DIRECTORY_CARD_LIMIT } = {}) {
  const cards = snapshot.cards.filter((c) => canSeeCard(c, viewer)).sort(compareCards);
  return { ...snapshot, cards: cards.slice(0, limit).map(summarizeEntry), truncated: cards.length > limit };
}

export function registerTeamDirectoryRoutes(
  app,
  { directory, resolveUser, rejectUnauthenticated, findCell = null, secret = "", forwardedFor = forwardedHeaders },
) {
  // `resolveUser` only ever yields a browser cookie session or a session-
  // eligible Bearer — guest seats, widget tokens and anonymous callers all
  // resolve to null, which is exactly the D6 answer (no public listing).
  app.get("/api/teams/directory", async (req, res) => {
    const user = resolveUser(req);
    if (!user?.email) return rejectUnauthenticated(req, res);
    try {
      const snapshot = await directory.snapshot();
      res.json(visibleCards(snapshot, { viewer: user }));
    } catch (err) {
      console.error(`[team-directory] snapshot failed: ${err?.message || err}`);
      // The cache is supposed to make this unreachable; if it happens, say so
      // rather than pretending the directory is empty.
      res.status(503).json({ error: "directory unavailable" });
    }
  });

  app.get("/api/teams/directory/:cellId/:handle", async (req, res) => {
    const user = resolveUser(req);
    if (!user?.email) return rejectUnauthenticated(req, res);
    try {
      const snapshot = await directory.snapshot();
      const cellId = String(req.params.cellId || "");
      const handle = String(req.params.handle || "").toLowerCase();
      const hit = snapshot.cards.find((c) => c.cellId === cellId && c.handle === handle);
      // Unknown, private, and invisible-to-you are one answer (spec: 同形).
      if (!hit || !canSeeCard(hit, user)) {
        return res.status(404).json(NOT_FOUND);
      }
      res.json({ v: 1, sampledAt: snapshot.sampledAt, card: hit.card, handle: hit.handle, cellId: hit.cellId });
    } catch (err) {
      console.error(`[team-directory] card read failed: ${err?.message || err}`);
      res.status(503).json({ error: "directory unavailable" });
    }
  });

  // ── the call door (add-team-as-a2a-agent 6.1–6.3) ────────────────────────
  //
  // A POST is the ONE write-shaped verb the directory owns, and it is not a
  // directory write: it forwards to the team's own cell, which re-decides
  // identity, policy and quota. The gateway's job here is exactly two things —
  // translate `:cellId` to a live cell, and stamp the VERIFIED caller identity
  // (a client-supplied x-forwarded-* is dropped by forwardedFor, so a forged
  // header cannot survive the hop).
  //
  // Registered BEFORE the read-only guard below: the guard answers 405 to every
  // non-GET on /api/teams/directory, and this path is a different prefix — but
  // the order is stated here because an earlier version of this file had the
  // catch-all first and the route became dead code (the fleet-room-bridge
  // lesson).
  if (typeof findCell === "function") {
    const forward = (suffix) => (req, res) => {
      const user = resolveUser(req);
      if (!user?.email) return rejectUnauthenticated(req, res);
      const cell = findCell(String(req.params.cellId || ""));
      if (!cell) return res.status(404).json(NOT_FOUND);
      const handle = String(req.params.handle || "").trim().toLowerCase();
      // Rebuild the path: the cell serves /api/teams/<handle>/a2a and has no
      // idea what its own public cell id is. proxyHttp would replay the
      // original URL verbatim, which is why this hop builds its own request.
      const upstream = http.request(
        {
          host: "127.0.0.1",
          port: cell.port,
          method: req.method,
          path: `/api/teams/${encodeURIComponent(handle)}${suffix}`,
          // forwardedFor stamps the verified identity AND the gateway secret;
          // any client-supplied identity header was dropped inside it.
          headers: forwardedFor(req, user, secret),
        },
        (up) => {
          // An old cell has no route → express answers 404 with an HTML page.
          // The team's own 404 is JSON with `{error:{code:"not_found"}}`; the
          // content type is what tells them apart without parsing a body we
          // are about to stream.
          const isMissingRoute = up.statusCode === 404 && !String(up.headers["content-type"] ?? "").includes("application/json");
          if (isMissingRoute) {
            up.resume();
            return res.status(503).json(NOT_SERVING);
          }
          res.writeHead(up.statusCode, up.headers);
          up.pipe(res);
        },
      );
      upstream.on("error", (err) => {
        if (res.headersSent) return res.end();
        res.status(502).json({ error: { code: "internal_error", message: `Cell unavailable: ${err.message}` } });
      });
      req.pipe(upstream);
    };
    app.post("/api/teams/:cellId/:handle/a2a", forward("/a2a"));
    // The `listed` request door and the caller's own standing (7.1).
    app.post("/api/teams/:cellId/:handle/request", forward("/request"));
    app.get("/api/teams/:cellId/:handle/request", forward("/request"));
  }

  // The directory is read-only by contract: a task-shaped POST must not be
  // mistaken for a (future) invocation path.
  app.all("/api/teams/directory", (req, res) => {
    if (req.method === "GET") return;
    res.status(405).json({ error: "read-only; use the team endpoint to call" });
  });
}

/** Binding helper: sample a live cell exactly like fleet-cells does. */
export function cellCardSampler({ fetchImpl = fetch, secret, secretHeader, timeoutMs = 2500, log = () => {} }) {
  return async (cell, path) => {
    try {
      const res = await fetchImpl(`http://127.0.0.1:${cell.port}${path}`, {
        headers: { "x-forwarded-email": cell.email, [secretHeader]: secret },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        log(`[team-directory] cell ${cell.cellId} answered ${res.status}`);
        return null;
      }
      const payload = await res.json();
      return payload && typeof payload === "object" ? payload : null;
    } catch (err) {
      log(`[team-directory] cell ${cell.cellId} unreachable: ${err?.message || err}`);
      return null;
    }
  };
}
