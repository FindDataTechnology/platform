#!/usr/bin/env node
// A zhiyu-only instance for the Android emulator lane (openspec:
// add-zhiyu-mobile-clients, task 7.2).
//
// WHY THIS EXISTS
// ---------------
// The app's zhiyu tab needs a GATEWAY, not a cell: rooms are cross-user objects
// and the kernel is mounted at `gateway/index.js` (before the cell proxy). The
// existing app-e2e mock boots `server.js`, which has no `/api/zhiyu/*` at all —
// so the emulator could pair and chat but never show a room.
//
// Two ways to fix that, and only one of them is honest:
//   • hand-write the four endpoints the screens call — fast, and it would test
//     MY idea of the wire contract, including the tail/cursor semantics that
//     the walkthrough is specifically about;
//   • mount the REAL kernel and seed it. Then "first screen is the tail",
//     "load earlier prepends an adjacent window" and "the cursor is the last row
//     handed back" are the production rules, not a mock's imitation.
// This file does the second. It is deliberately NOT a cell: pairing is a
// two-endpoint stub (`/api/config` + `/api/app/pair`) because the app only needs
// a token and an email to reach the room screens, and pulling the real cell in
// would drag the dsh runtime and the whole task engine into a UI lane.
//
// WHAT IT PROVES (device-class, emulator only)
//   tab → room list → room → tail first screen → "load earlier"
// = walkthrough items 1, 2 and 3 of docs/zhiyu-mobile-device-walkthrough.md on
// an actual Android runtime. Everything else in that document is either already
// covered by a node/Playwright gate or genuinely human-only (see the doc).
//
//   PORT=9413 node e2e/zhiyu-gateway-mock.mjs
//   → prints one JSON line: {port, code, email, roomId, roomTitle, dataRoot}
//     (`code` is the bind code the Maestro flow must type; it is random per run
//      so a stale code can never pair, and it lives only as long as the process)

import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { registerZhiyuRoutes } from "../gateway/zhiyu/index.js";

const PORT = Number(process.env.PORT) || 9413;
// The emulator reaches the host as 10.0.2.2, so the listen address must be the
// wildcard — but it is a knob, not a constant: a local debug run wants
// 127.0.0.1 and passing HOST to a script that ignores it is exactly the kind of
// quietly-wrong knob this repo keeps getting bitten by.
const HOST = process.env.HOST || "0.0.0.0";
const EMAIL = process.env.MOCK_USER_EMAIL || "mobile@corp.com";
const ROOM_TITLE = process.env.MOCK_ROOM_TITLE || "真机走查房";
// 60, not "a handful": the app opens a room with `tailCount: 30, pageSize: 20`
// (app/src/app/(tabs)/zhiyu/[roomId].tsx), so a room of 31 rows would arrive
// WHOLE in the first page — "load earlier" would never render and the
// walkthrough's items 2 and 3 would pass without being exercised. 61 rows
// (system + 60) leaves the tail window at 第31…第60 and the earlier page at
// 第11…第30, i.e. two adjacent windows with a real boundary to assert on.
const SEED_MESSAGES = Number(process.env.MOCK_SEED_MESSAGES) || 60;
// Random per boot: a code that outlives the process would be a credential.
const BIND_CODE = String(process.env.MOCK_BIND_CODE || Math.floor(100000 + Math.random() * 900000));

const dataRoot = process.env.MOCK_DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "zhiyu-mock-"));
fs.mkdirSync(dataRoot, { recursive: true });

/** token → email. In-memory on purpose: a restart invalidates every pairing. */
const tokens = new Map();
function mintToken() {
  const t = `zyt_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  tokens.set(t, EMAIL);
  return t;
}

const app = express();

// ── pairing (the two endpoints the app's front door actually calls) ─────────
app.get("/api/ready", (_req, res) => res.json({ ok: true }));
// `probeConfig()` reads capabilities.devicePairing; without it the app says
// "older server" and refuses to pair at all.
app.get("/api/config", (_req, res) => res.json({ capabilities: { devicePairing: true } }));
app.post("/api/app/pair", express.json({ limit: "16kb" }), (req, res) => {
  const code = String(req.body?.code ?? "").trim();
  if (code !== BIND_CODE) return res.status(401).json({ error: "invalid or expired code" });
  res.json({ token: mintToken(), email: EMAIL });
});
// Silent login on the next launch: the flow relaunches between cases, and a
// pairing that evaporated on relaunch would make every case after the first
// one run unpaired (the shell redirects to /pair).
app.post("/api/app/challenge", express.json({ limit: "16kb" }), (_req, res) => res.json({ nonce: `n_${Date.now()}` }));
app.post("/api/app/login", express.json({ limit: "16kb" }), (_req, res) => res.json({ token: mintToken(), email: EMAIL }));

// ── the real room kernel ───────────────────────────────────────────────────
const zhiyu = registerZhiyuRoutes(app, {
  dataRoot,
  // Two identity paths, both deliberate: the app presents its bearer token;
  // a human debugging the harness locally can send x-forwarded-email (the same
  // header the cell mock accepts). No other shape is trusted.
  resolveUser: (req) => {
    const auth = String(req.headers.authorization || "");
    if (auth.startsWith("Bearer ")) {
      const email = tokens.get(auth.slice(7));
      if (email) return { email };
    }
    const fwd = req.headers["x-forwarded-email"];
    if (typeof fwd === "string" && fwd) return { email: fwd };
    return null;
  },
  rejectUnauthenticated: (_req, res) => res.status(401).json({ error: "Authentication required" }),
  env: process.env,
  secret: "zhiyu-mock-secret",
  webDist: null,
  // No agent seat is dispatched in this lane: the walkthrough's items 1-3 are
  // the read path (list → enter → tail → load earlier). An agent lane here
  // would need a registry and a model, i.e. the thing this harness avoids.
  callAgent: null,
  settleTurn: null,
  // No sweeper/SSE timers: the process must exit when the flow ends, and a
  // stray interval keeps the runner's shell alive past the step.
  startTimers: false,
});

// ── seed: more rows than the app's tail window, so "load earlier" has work ──
{
  const store = zhiyu.store;
  const room = store.roomCreate({ title: ROOM_TITLE, ownerEmail: EMAIL });
  // An active user seat: the owner can READ without one, but posting is gated on
  // a seat, and a room whose composer 403s is not the room the walkthrough
  // describes.
  store.memberAdd({ roomId: room.id, kind: "user", ref: EMAIL, display: "我", presence: "active" });
  store.messageAppend({ roomId: room.id, kind: "system", content: "", meta: { event: "room_created", by: EMAIL } });
  for (let i = 1; i <= SEED_MESSAGES; i += 1) {
    store.messageAppend({
      roomId: room.id,
      kind: i % 2 === 0 ? "agent" : "human",
      content: `第 ${i} 条消息`,
      senderMemberId: null,
    });
  }
  app.listen(PORT, HOST, () => {
    // ONE machine-readable line: the CI script mints nothing and parses this.
    console.log(JSON.stringify({ port: PORT, code: BIND_CODE, email: EMAIL, roomId: room.id, roomTitle: ROOM_TITLE, dataRoot }));
  });
}
