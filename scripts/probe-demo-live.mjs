#!/usr/bin/env node
// ── Live probe for mini-program demo mode (openspec: add-mp-demo-mode 6.2) ───
//
// Exercises the three behavior points of a gateway-shaped deployment with
// MP_DEMO_MODE=1, against a RUNNING gateway (PROBE_BASE, default the local
// rehearsal gateway on :3080):
//
//   1. A fresh WeChat openid chats with no login page: wx.login code →
//      silent demo token (never `binding_required`), a real cell answers a
//      real prompt.
//   2. The demo cell is visible in /api/gateway/status (admin cookie minted
//      locally with the deployment's own session secret).
//   3. The demo cell reaps after the idle window — process stopped AND its
//      data root deleted (mp-demo-mode's discardable-data contract).
//
// Point PROBE_BASE at any gateway-shaped deployment after the fd-prod
// migration; the probe is deployment-agnostic. Exit 0 = all three hold.

import "dotenv/config";
import assert from "node:assert/strict";
import { resolveSessionSecret, sessionCookie } from "../server/session.js";

const WS = await import(new URL("../node_modules/ws/index.js", import.meta.url).href);
const WebSocket = WS.default || WS.WebSocket;
const { userIdFor } = await import(new URL("../gateway/spawner.js", import.meta.url).href);

const BASE = (process.env.PROBE_BASE || "http://127.0.0.1:3080").replace(/\/+$/, "");
const CODE = process.env.PROBE_CODE || `openid-probe-${Date.now()}`;
const wsUrl = `${BASE.replace(/^http/, "ws")}/`;

// ── 1. Fresh openid gets a silent demo identity and chats ───────────────────
const login = await fetch(`${BASE}/api/mp/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ code: CODE }),
}).then((r) => r.json());
assert.ok(login.token, `probe login failed: ${JSON.stringify(login)}`);
assert.match(login.email, /@demo\.invalid$/, "fresh openid must land on a demo identity");
console.log(`[probe] fresh openid → demo identity ${login.email}`);

// A freshly spawned cell listens BEFORE its dsh agent finishes initializing
// (listen-first boot); the first prompt can get "Agent is still initializing".
// The MP client treats that as retryable (reconnect + ready-sync) — so does
// the probe: resend until the runtime is ready.
async function demoChat(token) {
  const giveUpAt = Date.now() + 240_000;
  let lastReason = "never connected";
  for (;;) {
    assert.ok(Date.now() < giveUpAt, `demo chat never completed within 240s (last reason: ${lastReason})`);
    const chars = await new Promise((resolve) => {
      const ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${token}` } });
      let chars = 0;
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          ws.close();
          resolve(-1); // timeout → retry loop
        }
      }, 60_000);
      ws.on("message", (raw) => {
        if (settled) return;
        const m = JSON.parse(raw.toString());
        if (m.type === "text") chars += m.delta?.length ?? 0;
        if (m.type === "done") {
          settled = true;
          clearTimeout(timer);
          ws.close();
          resolve(chars);
        }
        if (m.type === "error") {
          settled = true;
          clearTimeout(timer);
          lastReason = m.message ?? "unknown error";
          ws.close();
          // "Agent is still initializing" is the listen-first boot race —
          // retryable. Anything else (e.g. model_not_found) is a real
          // failure, but resolve(-1) so the give-up assert reports it.
          resolve(-1);
        }
      });
      ws.on("open", () => ws.send(JSON.stringify({ type: "prompt", text: "用一句话回答：1+1等于几？" })));
      ws.on("error", (e) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          lastReason = `ws error: ${e.message}`;
          resolve(-1);
        }
      });
    });
    if (chars > 0) return chars;
    console.log(`[probe] attempt failed (${lastReason}) — retrying in 5s`);
    await new Promise((r) => setTimeout(r, 5000));
  }
}

const textLen = await demoChat(login.token);
assert.ok(textLen > 0, "demo chat produced no streamed text");
console.log(`[probe] demo chat OK (${textLen} chars streamed, no login page involved)`);

// ── 2. The demo cell is visible in /api/gateway/status ──────────────────────
const secret = await resolveSessionSecret({ env: process.env });
const adminCookie = sessionCookie(
  "paas_session",
  { email: "probe-admin@localhost", groups: ["admin"], exp: Math.floor(Date.now() / 1000) + 600 },
  secret,
  600_000,
).split(";")[0];
const status = await fetch(`${BASE}/api/gateway/status`, { headers: { cookie: adminCookie } }).then((r) => r.json());
const demoCell = (status.cells ?? []).find((c) => c.demo);
assert.ok(demoCell, `no demo cell in gateway status: ${JSON.stringify(status.cells ?? status)}`);
assert.ok((status.demoCells ?? 0) >= 1, "demoCells counter missing");
console.log(`[probe] gateway status shows the demo cell (state=${demoCell.state})`);

// ── 3. The demo cell reaps after the idle window ────────────────────────────
const userId = userIdFor(login.email);
const userRoot = `${status.dataRoot}/${userId}`;
console.log(`[probe] waiting for idle reap of ${userId} (data root ${userRoot})…`);
const deadline = Date.now() + 180_000;
let reaped = false;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 5000));
  const s = await fetch(`${BASE}/api/gateway/status`, { headers: { cookie: adminCookie } }).then((r) => r.json());
  const still = (s.cells ?? []).some((c) => c.userId === userId);
  const { statSync } = await import("node:fs");
  const dirGone = (() => {
    try {
      statSync(userRoot);
      return false;
    } catch {
      return true;
    }
  })();
  if (!still && dirGone) {
    reaped = true;
    break;
  }
}
assert.ok(reaped, "demo cell was not reaped (stopped + data root deleted) within 180s");
console.log("[probe] demo cell reaped: process stopped and data root deleted");

console.log("[probe] ALL THREE POINTS HOLD — demo mode behaves per spec on this deployment");
