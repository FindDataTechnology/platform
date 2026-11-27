#!/usr/bin/env node
// The gateway's team a2a entry (openspec: add-team-as-a2a-agent, 6.1–6.3).
//
// Three properties, each one a live failure mode rather than a nicety:
//   • ROUTE ORDER (6.1): the directory's read-only guard answers 405 to every
//     non-GET under /api/teams/directory. A call door registered after a
//     catch-all is dead code that looks alive — the fleet-room-bridge lesson.
//     This suite registers a catch-all AFTER the door and proves reachability.
//   • IDENTITY (6.2): the cell must see the gateway's VERIFIED caller, never
//     the x-forwarded-email a client sent. The fake cell records the header it
//     actually received.
//   • OLD CELL (6.3): a cell image without the door answers 404 HTML; that is
//     `not_serving`, not 500 and not "team not found".

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import express from "express";
import { registerTeamDirectoryRoutes } from "../gateway/team-directory.js";

const CELL_EMAIL = "owner@cell.test";
const CALLER = "caller@x.test";
const SECRET = "gateway-secret";
const SECRET_HEADER = "x-cloud-gateway-secret";

let app;
let server;
let base;
/** cell behaviour switch: "modern" | "modern404" | "old" */
let cellMode = "modern";
const seen = [];

let cellServer;
let cellPort;

before(async () => {
  // The fake cell: records what the gateway sent, then answers like a real one
  // (or like an old image with no route at all).
  cellServer = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      seen.push({ path: req.url, headers: req.headers, body });
      if (cellMode === "old") {
        res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
        return res.end("<html><body>Cannot POST /api/teams/cs-team/a2a</body></html>");
      }
      // A MODERN cell's own JSON refusal: the gateway must pass this through
      // untouched instead of rewriting it as not_serving. Behaves as a mode of
      // the same server on purpose — re-listening on the same port between
      // tests loses the race against keep-alive sockets on slower runners
      // (measured on CI, Node 25: the fetch threw and the door answered 502).
      if (cellMode === "modern404") {
        res.writeHead(404, { "content-type": "application/json" });
        return res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32020, data: { code: "not_found" } } }));
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`event: message\ndata: {"ok":true}\n\n`);
      res.write(`event: done\ndata: {"status":"ok"}\n\n`);
      res.end();
    });
  });
  await new Promise((resolve) => cellServer.listen(0, "127.0.0.1", resolve));
  cellPort = cellServer.address().port;

  app = express();
  // NO global body parser, exactly like gateway/index.js: the door pipes the raw
  // request to the cell, and a parser here would empty the stream.
  registerTeamDirectoryRoutes(app, {
    directory: { snapshot: async () => ({ v: 1, sampledAt: 1, cells: { sampled: 0, degraded: 0 }, degradedCells: [], cards: [], stale: false }) },
    resolveUser: (req) => (req.headers["x-user"] ? { email: String(req.headers["x-user"]), groups: [] } : null),
    rejectUnauthenticated: (_q, res) => res.status(401).json({ error: "auth" }),
    findCell: (id) => (id === "cell-public" ? { email: CELL_EMAIL, port: cellPort } : null),
    secret: SECRET,
  });
  // A catch-all registered AFTER the door, the production shape the order bug
  // hid behind.
  app.all("/api/teams/*", (_req, res) => res.status(418).json({ error: "swallowed by catch-all" }));

  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  cellServer?.close();
});

async function call({ user = CALLER, cellId = "cell-public", handle = "cs-team", body = { jsonrpc: "2.0", id: 1, method: "message/stream" }, headers = {} } = {}) {
  const res = await fetch(`${base}/api/teams/${cellId}/${handle}/a2a`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(user ? { "x-user": user } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, contentType: res.headers.get("content-type") ?? "" };
}

// ── 6.1 reachability ──────────────────────────────────────────────────────

test("the call door is reachable even with a catch-all registered after it", async () => {
  seen.length = 0;
  cellMode = "modern";
  const res = await call();
  assert.equal(res.status, 200, res.text);
  assert.match(res.contentType, /text\/event-stream/);
  assert.equal(res.text.includes("event: message"), true);
  // The cell got the PATH WITHOUT the public cell id — it has no idea what its
  // own public id is, so the gateway must rebuild it.
  assert.equal(seen[0].path, "/api/teams/cs-team/a2a");
  assert.equal(seen[0].body.includes('"message/stream"'), true, "the JSON-RPC body arrives intact");
});

// ── 6.2 identity ──────────────────────────────────────────────────────────

test("the cell sees the verified caller, never a forged forwarded header", async () => {
  seen.length = 0;
  await call({
    headers: {
      "x-forwarded-email": "attacker@evil.test",
      "x-forwarded-groups": "admin",
      [SECRET_HEADER]: "guessed-secret",
    },
  });
  const got = seen[0].headers;
  assert.equal(got["x-forwarded-email"], CALLER, "a client-supplied identity must be dropped");
  assert.equal(got["x-forwarded-groups"], "", "group claims are not forwarded from the client either");
  assert.equal(got[SECRET_HEADER], SECRET, "the gateway secret is the deployment's, not the client's");
  assert.equal(got["content-type"], "application/json", "content-type survives — the cell's parser needs it");
});

test("an anonymous caller is refused before any cell is contacted", async () => {
  seen.length = 0;
  const res = await call({ user: null });
  assert.equal(res.status, 401);
  assert.equal(seen.length, 0, "no cell traffic for an unauthenticated call");
});

test("an unknown cell id is the same 404 a missing team produces", async () => {
  seen.length = 0;
  const res = await call({ cellId: "cell-unknown" });
  assert.equal(res.status, 404);
  assert.deepEqual(JSON.parse(res.text), { error: "not found" });
  assert.equal(seen.length, 0);
});

// ── 6.3 old cell ──────────────────────────────────────────────────────────

test("a cell without the door answers not_serving, not a 500", async () => {
  seen.length = 0;
  cellMode = "old";
  const res = await call();
  assert.equal(res.status, 503, res.text);
  const body = JSON.parse(res.text);
  assert.equal(body.error.code, "not_serving");
  assert.equal(typeof body.error.message, "string");
});

test("a modern cell's own 404 (JSON) is passed through untouched", async () => {
  cellMode = "modern404";
  const res = await call();
  assert.equal(res.status, 404, "a team-level 404 must not be rewritten into not_serving");
  assert.equal(JSON.parse(res.text).error.data.code, "not_found");
  cellMode = "modern";
});
