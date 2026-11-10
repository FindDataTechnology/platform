#!/usr/bin/env node
// ── Persona/skill evolution bridge auth suite (add-persona-self-evolution) ───
//
// Pins the loopback-bridge credential for the evolution twins at the AUTH GATE
// layer (registerAuth): an in-cell MCP child's propose rides loopback + the
// internal stamp, while everything else on the same path prefix still faces
// the full gate. The persona twin was MISSING from the middleware (shipped
// with the skill twin already registered) — a real-machine walkthrough turn
// hit the tool face 401 ("Authentication required") on production 11-04.
//
//   node --test scripts/test-evolution-bridge-auth.mjs

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import express from "express";
import http from "node:http";

const home = mkdtempSync(path.join(tmpdir(), "evo-bridge-auth-"));
process.env.DB_PATH = path.join(home, "app.db");
process.env.PLATFORM_DATA_DIR = home;
process.env.DSH_HOME = path.join(home, "dsh-home");
process.env.CHAT_HISTORY_STORE_DIR = path.join(home, "chat");
process.env.DOCUMENTS_STORE_DIR = path.join(home, "docs");
process.env.SESSIONS_STORE_DIR = path.join(home, "sessions");

const { initDb } = await import("../db.js");
await initDb();
const { registerAuth } = await import("../server/auth.js");
const { createPersonaEvolutionRoutes } = await import("../server/persona-evolution-routes.js");
const { createSkillEvolutionRoutes } = await import("../server/skill-evolution-routes.js");
const dbModule = await import("../db.js");

// The amend target must resolve: a user_presets row with a base persona.
dbModule.createUserPreset({
  name: "probe",
  persona: "You are a meticulous reporting assistant. You always re-check every number against the source before presenting results.",
});
dbModule.createUserPreset({
  name: "probe-two",
  persona: "You are a meticulous reporting assistant. You always re-check every number against the source before presenting results.",
});

test.after(() => rmSync(home, { recursive: true, force: true }));

// A hosted-cell ctx: auth hard-on, cell owner stamped — the shape where the
// bridge stamp is the ONLY door a credential-less loopback child has.
const ctx = {
  app: null,
  authEnabled: true,
  authMode: "forward_auth", // the production hosted-cell shape (auth/me: mode=forward_auth)
  CLOUD_MODE: "1",
  CELL_USER_EMAIL: "owner@cell.test",
  cellUserEmail: "owner@cell.test",
  headerTrust: { secret: "test-gateway-secret" },
  logtoAuth: {
    // No cookie/token ever verifies: only the bridge stamps get through.
    authenticate: () => null,
  },
};

const app = express();
app.use(express.json());
ctx.app = app;
registerAuth(ctx);
createPersonaEvolutionRoutes(app, ctx);
createSkillEvolutionRoutes(app, ctx);

const server = http.createServer(app);
server.listen(0);
const call = (method, p, body) =>
  fetch(`http://127.0.0.1:${server.address().port}${p}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

test.after(() => server.close());

const PERSONA_BODY = {
  targetKind: "preset",
  targetRef: "user.probe",
  amendedPersona: "You are a meticulous reporting assistant. When input data contradicts itself, you pause, name the conflict, and refuse to conclude until it is resolved.",
  evidence: { source: "turn: conflict-table walkthrough", fixed: "adds the pause-and-name-the-conflict behavior" },
};

test("bridge: credential-less loopback persona propose lands a candidate stamped persona-evolution@internal", async () => {
  const r = await call("POST", "/api/persona-evolution/propose", PERSONA_BODY);
  assert.equal(r.status, 201);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.candidate.proposed_by, "persona-evolution@internal");
  assert.equal(r.body.candidate.status, "candidate");
});

test("bridge: skill twin unchanged — loopback skill propose still lands (regression guard)", async () => {
  const r = await call("POST", "/api/skill-evolution/propose", {
    name: "probe-skill",
    description: "walkthrough probe",
    body: "# probe skill\n\nThis guidance walks the agent through a two-step verification with at least thirty characters of body text.",
    evidence: { source: "turn: bridge auth suite", fixed: "n/a" },
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.candidate.proposed_by, "skill-evolution@internal");
});

test("bridge: a gateway-proxied real owner propose keeps the real identity (not stamped)", async () => {
  const r = await fetch(`http://127.0.0.1:${server.address().port}/api/persona-evolution/propose`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-email": "owner@cell.test",
      "x-forwarded-groups": "default",
      "x-cloud-gateway-secret": "test-gateway-secret",
    },
    body: JSON.stringify({ ...PERSONA_BODY, targetRef: "user.probe-two" }),
  }).then(async (x) => ({ status: x.status, body: await x.json().catch(() => ({})) }));
  assert.equal(r.status, 201);
  assert.equal(r.body.candidate.proposed_by, "owner@cell.test");
});

test("bridge: the owner's gestures stay human-gated — loopback evaluate is NOT stamped (401)", async () => {
  const { personaEvolutionStore } = await import("../server/persona-evolution.js");
  const cand = personaEvolutionStore().listCandidates()[0];
  const r = await call("POST", `/api/persona-evolution/candidates/${cand.id}/evaluate`, { scenarioPrompt: "x" });
  assert.equal(r.status, 401); // no stamp on the human-only verbs
});
