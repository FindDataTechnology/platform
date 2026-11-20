// Gateway publish-prevalidation gate for fleet orchestration sections
// (add-mixed-fleet-packs, task 1.3 / design D3).
//
// The fleetTemplate gate inside collectPublishVerdict runs parseFleetTemplate,
// which since this change validates a manifest's fleet.orchestration with the
// SAME pure validator the live write face uses (member set = template
// members). This suite pins the GATE wiring itself through the real routes,
// on one express app with a temp registry:
//   - a manifest with a LEGAL orchestration section validates clean and
//     publishes through
//   - a manifest whose orchestration references a post outside the member
//     set is refused at the mint with the offending edge named
//
// Run: node --test scripts/test-fleet-template-publish-gate.mjs

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import express from "express";

import { createPackRegistry, registerPackRoutes } from "../gateway/packs.js";

const tmp = mkdtempSync(path.join(tmpdir(), "fleet-gate-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

const registry = createPackRegistry({ file: path.join(tmp, "packs.db") });
const resolveUser = (req) => {
  const raw = req.headers["x-test-user"];
  if (!raw) return null;
  try {
    const doc = JSON.parse(raw);
    return typeof doc?.email === "string" ? { email: doc.email, groups: Array.isArray(doc.groups) ? doc.groups : [] } : null;
  } catch {
    return null;
  }
};
const rejectUnauthenticated = (_req, res) => res.status(401).json({ error: "Authentication required" });

const app = express();
app.use(express.json({ limit: "1mb" }));
registerPackRoutes(app, {
  registry,
  resolveUser,
  rejectUnauthenticated,
  creatorGroups: ["creators"],
  adminGroups: [],
});
const server = http.createServer(app);
const base = await new Promise((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}`)));
after(() => server.close());

const CREATOR = { "x-test-user": JSON.stringify({ email: "author@test", groups: ["creators"] }), "content-type": "application/json" };

const call = (method, p, body, headers = CREATOR) =>
  fetch(`${base}${p}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

function fleetManifest(orchestration) {
  return {
    name: "编排模板包",
    // The structural gate requires at least one skill/MCP/agent (an agent
    // needs its persona string to clear the manifest shape gate).
    agents: [{ id: "fleet-a", name: "主编", persona: "你是主编。" }],
    fleet: {
      name: "内容流水线",
      members: [
        { ref: "a", title: "主编", parentRef: null, target: { kind: "existing-persona", id: "p-a" }, cadence: null },
        { ref: "b", title: "撰稿", parentRef: "a", target: { kind: "existing-persona", id: "p-b" }, cadence: null },
      ],
      ...(orchestration === undefined ? {} : { orchestration }),
    },
  };
}

test("validate (dry-run): legal orchestration passes; ghost ref refused with the edge named", async () => {
  const legal = await call("POST", "/api/packs/validate", { manifest: fleetManifest({
    edges: [
      { kind: "trigger", to: "a", cron: "0 9 * * 1" },
      { kind: "handoff", from: "a", to: "b" },
    ],
  }) });
  assert.equal(legal.status, 200);
  assert.equal(legal.body.valid, true, JSON.stringify(legal.body.errors));

  const ghost = await call("POST", "/api/packs/validate", { manifest: fleetManifest({
    edges: [{ kind: "handoff", from: "a", to: "ghost" }],
  }) });
  assert.equal(ghost.status, 200);
  assert.equal(ghost.body.valid, false);
  const fleetErrors = ghost.body.errors.filter((e) => JSON.stringify(e).includes("fleet"));
  assert.ok(fleetErrors.length >= 1, "the fleetTemplate gate verdict is present");
  assert.match(JSON.stringify(fleetErrors), /does not match a member/, "the refusal names the missing post");
  assert.match(JSON.stringify(fleetErrors), /handoff|edges/, "the refusal names the offending edge");
});

test("publish: legal orchestration goes through; illegal orchestration is refused at the mint", async () => {
  const ok = await call("POST", "/api/packs", { manifest: fleetManifest({
    edges: [{ kind: "trigger", to: "a", cron: "0 9 * * 1" }, { kind: "handoff", from: "a", to: "b" }],
  }) });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.version, 1);

  const bad = await call("POST", "/api/packs", { manifest: fleetManifest({
    edges: [{ kind: "mystery", from: "a", to: "b" }],
  }) });
  assert.equal(bad.status, 400);
  assert.match(JSON.stringify(bad.body.errors), /kind must be one of/, "structured refusal names the unknown kind");

  // The refused publish stored nothing.
  const list = await call("GET", "/api/packs?search=编排模板包", undefined, CREATOR);
  assert.equal(list.body.packs.filter((p) => p.name.includes("编排模板包")).length, 1, "only the legal publish landed");
});
