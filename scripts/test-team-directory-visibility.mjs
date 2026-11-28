#!/usr/bin/env node
// The gateway directory (openspec: add-agent-team-directory, tasks 3.1–3.5).
//
// Pinned here:
//   • 3.1 honest degradation — a cell without the endpoint (an old cell) is a
//     degraded entry, never a failure and never a fake empty card;
//   • 3.2 the load contract — 20 concurrent readers cost ONE sample per cell,
//     and an expired-but-populated cache answers `stale: true` without waiting;
//   • 3.3 the read surface — signed-in only, stable order (newest first),
//     bounded list with an explicit `truncated`;
//   • 3.4 the visibility matrix — `private` and unknown answer with one body;
//   • 3.5 read-only — a task-shaped POST to the directory is refused.
//
// The real module + a real socket: method routing and status codes are part of
// the contract, so a stubbed app would let the regressions this file guards
// against pass.

import { test } from "node:test";
import assert from "node:assert/strict";

import express from "express";
import {
  createTeamDirectory,
  registerTeamDirectoryRoutes,
  visibleCards,
  canSeeCard,
  DIRECTORY_CARD_LIMIT,
} from "../gateway/team-directory.js";

const VIEWER = { email: "viewer@x.test", groups: [] };

function entry(handle, { visibility = "listed", publishedAt = 1, name = handle } = {}) {
  return {
    handle,
    visibility,
    target: { kind: "fleet", id: `fleet-${handle}` },
    card: {
      name,
      description: "",
      version: 1,
      capabilities: ["a2a"],
      skills: [],
      posts: [],
      pricing: { callsPerDay: 200, tokensPerDay: 2_000_000, usdPerDay: 5, currency: "USD", billedTo: "team-owner" },
      availability: { state: "accepting", accepting: true },
      trust: { publishedAt, cellId: `cell-${handle}` },
    },
  };
}

async function boot(directory, { user = VIEWER } = {}) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  registerTeamDirectoryRoutes(app, {
    directory,
    resolveUser: () => user,
    rejectUnauthenticated: (_q, res) => res.status(401).json({ error: "auth" }),
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function call(base, method, url, body) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON bodies are asserted as text */
  }
  return { status: res.status, json, text };
}

// ── 3.1 honest degradation ──────────────────────────────────────────────────

test("a cell without the endpoint degrades alone; the directory still answers", async () => {
  const cells = [
    { cellId: "cell-a", email: "a@x.test", port: 1 },
    { cellId: "cell-b", email: "b@x.test", port: 2 },
    { cellId: "cell-old", email: "old@x.test", port: 3 },
  ];
  const seen = [];
  const directory = createTeamDirectory({
    cells: () => cells,
    sampleCell: async (cell) => {
      seen.push(cell.cellId);
      if (cell.cellId === "cell-old") return null; // 404 → old cell has no endpoint
      return { v: 1, sampledAt: 1, cards: [entry(`${cell.cellId}-team`)] };
    },
  });

  const snap = await directory.snapshot();
  assert.deepEqual(seen.sort(), ["cell-a", "cell-b", "cell-old"], "every live cell is sampled");
  assert.deepEqual(snap.degradedCells, ["cell-old"]);
  assert.deepEqual(snap.cards.map((c) => c.cellId).sort(), ["cell-a", "cell-b"]);
  assert.equal(snap.cells.sampled, 2);
  assert.equal(snap.cells.degraded, 1);
  assert.equal(snap.stale, false);

  const { server, base } = await boot(directory);
  try {
    const res = await call(base, "GET", "/api/teams/directory");
    assert.equal(res.status, 200, "a degraded cell must not fail the query");
    assert.equal(res.json.cards.length, 2);
    assert.deepEqual(res.json.degradedCells, ["cell-old"]);
  } finally {
    server.close();
  }
});

test("a cell answering a wrong envelope is degraded, not trusted", async () => {
  const directory = createTeamDirectory({
    cells: () => [{ cellId: "cell-x", email: "x@x.test", port: 1 }],
    sampleCell: async () => ({ ok: true, cards: [entry("should-not-appear")] }), // no v:1
  });
  const snap = await directory.snapshot();
  assert.deepEqual(snap.cards, []);
  assert.deepEqual(snap.degradedCells, ["cell-x"]);
});

// ── 3.2 cache: single-flight + stale-serve ─────────────────────────────────

test("20 concurrent cold readers produce exactly one sample per cell", async () => {
  let samples = 0;
  const directory = createTeamDirectory({
    cells: () => [{ cellId: "cell-a", email: "a@x.test", port: 1 }],
    sampleCell: async () => {
      samples += 1;
      await new Promise((r) => setTimeout(r, 20)); // sampling takes real time
      return { v: 1, sampledAt: 1, cards: [entry("t")] };
    },
  });
  const results = await Promise.all(Array.from({ length: 20 }, () => directory.snapshot()));
  assert.equal(samples, 1, `expected 1 upstream sample, saw ${samples}`);
  assert.equal(results.every((r) => r.cards.length === 1), true);
});

test("an expired cache answers stale immediately instead of waiting on a slow cell", async () => {
  let t = 1_000;
  let samples = 0;
  let releaseSlow = null;
  const directory = createTeamDirectory({
    cells: () => [{ cellId: "cell-a", email: "a@x.test", port: 1 }],
    now: () => t,
    ttlMs: 60_000,
    sampleCell: async () => {
      samples += 1;
      if (samples === 1) return { v: 1, sampledAt: 1, cards: [entry("first", { publishedAt: 1 })] };
      await new Promise((resolve) => {
        releaseSlow = resolve; // second sample hangs
      });
      return { v: 1, sampledAt: 2, cards: [entry("second", { publishedAt: 2 })] };
    },
  });

  const cold = await directory.snapshot();
  assert.equal(cold.stale, false);
  assert.equal(cold.cards[0].handle, "first");

  t += 61_000; // TTL expired
  // No await on a timer: if the implementation waited for the cell this would
  // never settle.
  const expired = await directory.snapshot();
  assert.equal(expired.stale, true, "expired cache must be served as stale");
  assert.equal(expired.cards[0].handle, "first", "stale view still carries the last good data");

  releaseSlow();
  await new Promise((r) => setTimeout(r, 10));
  const refreshed = await directory.snapshot();
  assert.equal(refreshed.stale, false);
  assert.equal(refreshed.cards[0].handle, "second", "the background refresh lands");
});

// ── 3.3 read surface ───────────────────────────────────────────────────────

test("the owner's email never rides on a card, and the cell id is the shared hash", async () => {
  const { cellIdFor } = await import("../server/team-card.js");
  const OWNER_EMAIL = "owner.private@x.test";
  const directory = createTeamDirectory({
    cells: () => [{ cellId: cellIdFor(OWNER_EMAIL), email: OWNER_EMAIL, port: 1 }],
    sampleCell: async () => ({ v: 1, sampledAt: 1, cards: [entry("team-1")] }),
  });
  const { server, base } = await boot(directory);
  try {
    const res = await call(base, "GET", "/api/teams/directory");
    assert.equal(res.status, 200);
    assert.equal(res.text.includes(OWNER_EMAIL), false, "an owner address must not reach another user");
    assert.equal(res.text.includes("owner.private"), false);
    assert.equal(res.json.cards[0].cellId, cellIdFor(OWNER_EMAIL), "both sides compute the same cell id");
  } finally {
    server.close();
  }
});

test("the listing is newest-first, bounded, and says when it was cut", () => {
  const snapshot = {
    v: 1,
    sampledAt: 5,
    cells: { sampled: 2, degraded: 0 },
    degradedCells: [],
    stale: false,
    cards: [entry("old", { publishedAt: 1 }), entry("new", { publishedAt: 9 }), entry("mid", { publishedAt: 5 })],
  };
  assert.deepEqual(
    visibleCards(snapshot, { viewer: VIEWER }).cards.map((c) => c.handle),
    ["new", "mid", "old"],
  );

  const many = { ...snapshot, cards: Array.from({ length: DIRECTORY_CARD_LIMIT + 3 }, (_, i) => entry(`h${i}`, { publishedAt: i })) };
  const bounded = visibleCards(many, { viewer: VIEWER });
  assert.equal(bounded.cards.length, DIRECTORY_CARD_LIMIT);
  assert.equal(bounded.truncated, true, "a cut list must say so rather than look complete");
  assert.equal(visibleCards({ ...snapshot, cards: [] }, { viewer: VIEWER }).truncated, false);

  // The list is a summary: a card with many posts is cut and flagged, while the
  // deep-link read still returns everything.
  const fat = entry("fat");
  fat.card.posts = Array.from({ length: 25 }, (_, i) => ({ id: `p${i}`, title: `岗${i}` }));
  fat.card.skills = fat.card.posts.map((p) => ({ id: p.id, name: p.title }));
  const summarized = visibleCards({ ...snapshot, cards: [fat] }, { viewer: VIEWER }).cards[0];
  assert.equal(summarized.card.posts.length, 20);
  assert.equal(summarized.postsTruncated, true);
  assert.equal(visibleCards({ ...snapshot, cards: [entry("thin")] }, { viewer: VIEWER }).cards[0].postsTruncated, false);
});

test("an anonymous caller is refused and learns nothing", async () => {
  const directory = createTeamDirectory({
    cells: () => [{ cellId: "cell-a", email: "a@x.test", port: 1 }],
    sampleCell: async () => ({ v: 1, sampledAt: 1, cards: [entry("secret-team", { name: "客户甲" })] }),
  });
  const { server, base } = await boot(directory, { user: null });
  try {
    const res = await call(base, "GET", "/api/teams/directory");
    assert.equal(res.status, 401);
    assert.equal(res.text.includes("secret-team"), false);
    assert.equal(res.text.includes("客户甲"), false);
  } finally {
    server.close();
  }
});

// ── 3.4 visibility matrix ──────────────────────────────────────────────────

test("the visibility matrix: only a signed-in viewer sees listed/open", () => {
  assert.equal(canSeeCard({ visibility: "private" }, VIEWER), false);
  assert.equal(canSeeCard({ visibility: "listed" }, VIEWER), true);
  assert.equal(canSeeCard({ visibility: "open" }, VIEWER), true);
  for (const v of ["private", "listed", "open"]) {
    assert.equal(canSeeCard({ visibility: v }, null), false, `${v} must need a session`);
    assert.equal(canSeeCard({ visibility: v }, {}), false, "an identity without email is not a session");
  }
  // A cell that predates the field still only samples non-private cards.
  assert.equal(canSeeCard({ card: {} }, VIEWER), true);
});

test("private and unknown answer with one identical body, and private is absent from the list", async () => {
  const directory = createTeamDirectory({
    cells: () => [{ cellId: "cell-a", email: "a@x.test", port: 1 }],
    sampleCell: async () => ({
      v: 1,
      sampledAt: 1,
      cards: [
        entry("listed-team", { visibility: "listed" }),
        entry("open-team", { visibility: "open" }),
        // A misbehaving cell: even if a private card were sampled, the gateway
        // must not serve it (defence in depth, D4).
        entry("private-team", { visibility: "private" }),
      ],
    }),
  });
  const { server, base } = await boot(directory);
  try {
    const listed = await call(base, "GET", "/api/teams/directory/cell-a/listed-team");
    assert.equal(listed.status, 200, listed.text);
    assert.equal(listed.json.card.name, "listed-team");

    const open = await call(base, "GET", "/api/teams/directory/cell-a/open-team");
    assert.equal(open.status, 200);

    const priv = await call(base, "GET", "/api/teams/directory/cell-a/private-team");
    const unknown = await call(base, "GET", "/api/teams/directory/cell-a/nope");
    const wrongCell = await call(base, "GET", "/api/teams/directory/cell-zzz/listed-team");
    for (const res of [priv, unknown, wrongCell]) {
      assert.equal(res.status, 404);
      assert.deepEqual(res.json, { error: "not found" });
    }
    assert.equal(priv.text.includes("private-team"), false, "the refusal must not echo the handle");

    // A private card is never in the directory listing either.
    const list = await call(base, "GET", "/api/teams/directory");
    assert.deepEqual(list.json.cards.map((c) => c.handle).sort(), ["listed-team", "open-team"]);
  } finally {
    server.close();
  }
});

// ── 3.5 read-only ──────────────────────────────────────────────────────────

test("a task-shaped POST to the directory is refused, not queued", async () => {
  const directory = { snapshot: async () => ({ v: 1, sampledAt: 1, cells: { sampled: 0, degraded: 0 }, degradedCells: [], cards: [], stale: false }) };
  const { server, base } = await boot(directory);
  try {
    const res = await call(base, "POST", "/api/teams/directory", {
      target: "cell-a/team",
      task: "帮我退款",
      budget: { usd: 1 },
    });
    assert.equal(res.status, 405);
    assert.equal(res.json.error.includes("read-only"), true);
    // And the GET surface still works, so the 405 is not the app failing shut.
    const list = await call(base, "GET", "/api/teams/directory");
    assert.equal(list.status, 200);
  } finally {
    server.close();
  }
});
