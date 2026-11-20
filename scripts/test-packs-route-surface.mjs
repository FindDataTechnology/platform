// Pack gateway route-surface guard (optimize-paas-module-audit N-9).
//
// gateway/packs.js is 3.5k lines carrying registry + gates + the whole HTTP
// surface in ONE registerPackRoutes() body — the audit's worst-maintainability
// finding. The backlog's own instruction is "拆分+回归护栏优先": split only
// behind a net. This file IS that net, and it must exist BEFORE any extraction.
//
// What it pins, and why each one is a real extraction hazard:
//   1. the exact (method, path) inventory — a handler moved into a new module
//      and forgotten at the mount point disappears silently, and the failure
//      surfaces as a 404 in production rather than as a diff review note;
//   2. no duplicate (method, path) — re-registering a route during a move is
//      how a later edit lands on the wrong handler (Express dispatches the
//      FIRST match, so the second becomes dead code that looks alive);
//   3. every route still hangs off /api/packs — a stray mount prefix change is
//      invisible to unit tests that call handlers through a helper;
//   4. the routes the product literally cannot lose (publish, browse, detail,
//      stored version, subscribe, deploy, billing) are present by name.
//
// Read-only: boots a bare express app, registers the real routes, inspects the
// router stack. No socket, no LLM, no registry.

import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPackRegistry, registerPackRoutes } from "../gateway/packs.js";

const tmpRoot = mkdtempSync(join(tmpdir(), "fd-packs-surface-"));
process.on("exit", () => rmSync(tmpRoot, { recursive: true, force: true }));

function buildApp() {
  const registry = createPackRegistry({ file: join(tmpRoot, `packs-${Math.random().toString(36).slice(2)}.db`) });
  const app = express();
  registerPackRoutes(app, {
    registry,
    resolveUser: () => null,
    rejectUnauthenticated: (_q, r) => r.status(401).json({ error: "auth" }),
    creatorGroups: ["creators"],
    adminGroups: ["admin"],
    deployConfig: {
      registryUrl: "https://mcp.example.test",
      token: "runner-svc-token",
      runnerBaseUrl: "http://runner.tailnet",
      packsPublicBase: "https://packs.example.test",
      fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }),
      sub2api: null,
    },
  });
  return app;
}

function routeTable(app) {
  const stack = (app._router?.stack ?? []).filter((layer) => layer.route);
  const rows = [];
  for (const layer of stack) {
    const methods = Object.keys(layer.route.methods)
      .filter((m) => m !== "_all")
      .map((m) => m.toUpperCase())
      .sort();
    for (const method of methods) rows.push(`${method} ${layer.route.path}`);
  }
  return rows;
}

test("packs gateway: the route inventory is frozen (an extraction cannot drop one silently)", () => {
  const table = routeTable(buildApp());

  // The full surface as of the audit baseline. Adding a route is fine — update
  // this list in the same commit. LOSING one, or changing a verb/path, is a
  // product break disguised as a refactor and fails here instead.
  assert.deepEqual(table.sort(), EXPECTED_ROUTES.slice().sort());
});

test("packs gateway: no duplicate method+path (Express dispatches the first match)", () => {
  const table = routeTable(buildApp());
  const seen = new Map();
  const dupes = [];
  for (const row of table) {
    if (seen.has(row)) dupes.push(row);
    seen.set(row, true);
  }
  assert.deepEqual(dupes, [], `duplicate registrations: ${dupes.join(", ")}`);
});

test("packs gateway: every route stays under the /api/packs prefix", () => {
  const stray = routeTable(buildApp()).filter((row) => !row.split(" ")[1].startsWith("/api/packs"));
  assert.deepEqual(stray, [], `routes escaped the /api/packs prefix: ${stray.join(", ")}`);
});

test("packs gateway: the routes the product cannot lose are present", () => {
  const table = new Set(routeTable(buildApp()));
  const loadBearing = [
    "POST /api/packs", // publish
    "GET /api/packs", // browse
    "GET /api/packs/:id", // detail
    "GET /api/packs/:id/versions/:version", // stored version (server-side install fetch)
    "POST /api/packs/:id/subscribe",
    "POST /api/packs/:id/versions/:version/deploy",
    "GET /api/packs/billing/me",
    "POST /api/packs/validate",
  ];
  for (const route of loadBearing) assert.ok(table.has(route), `missing load-bearing route: ${route}`);
});

const EXPECTED_ROUTES = [
  "POST /api/packs",
  "POST /api/packs/validate",
  "POST /api/packs/coverage",
  "GET /api/packs",
  "GET /api/packs/curation/coverage",
  "GET /api/packs/facets",
  "GET /api/packs/official",
  "PUT /api/packs/:id/curation",
  "PUT /api/packs/:id/visibility",
  "GET /api/packs/:id/versions",
  "GET /api/packs/serving-status",
  "GET /api/packs/:id",
  "GET /api/packs/:id/versions/:version",
  "GET /api/packs/:id/versions/:version/skills/:skill/files/*",
  "GET /api/packs/:id/versions/:version/skills/:skill",
  "POST /api/packs/:id/versions/:version/deploy",
  "GET /api/packs/billing/me",
  "GET /api/packs/billing/snapshot",
  "GET /api/packs/:id/billing-bindings",
  "GET /api/packs/:id/secret-bindings",
  "GET /api/packs/billing/board",
  "GET /api/packs/internal/llm-key/:keyRef",
  "GET /api/packs/internal/secret/:ref",
  "GET /api/packs/internal/deployments",
  "GET /api/packs/internal/deployments/:id",
  "GET /api/packs/internal/author/:id",
  "GET /api/packs/internal/runners",
  "POST /api/packs/internal/deployments/:packId/:agentId/host-settle",
  "POST /api/packs/internal/matters/:packId/:agentId/open",
  "GET /api/packs/internal/matters/:packId/:agentId",
  "GET /api/packs/internal/matters/:packId/:agentId/:mid",
  "POST /api/packs/internal/visitor-actor/:packId/:agentId",
  "DELETE /api/packs/internal/visitor-actor/:packId/:agentId",
  "POST /api/packs/internal/connector-action/:packId/:agentId",
  "GET /api/packs/:id/deployments",
  "GET /api/packs/:id/matters",
  "POST /api/packs/:id/matters/:mid/reply",
  "POST /api/packs/:id/matters/:mid/close",
  "POST /api/packs/:id/deployments/:agentId/pause",
  "POST /api/packs/:id/deployments/:agentId/resume",
  "POST /api/packs/:id/deployments/:agentId/kill",
  "GET /api/packs/:id/deployments/:agentId/config",
  "PUT /api/packs/:id/deployments/:agentId/config",
  "GET /api/packs/internal/deployments/:id/:agentId/config",
  "PUT /api/packs/internal/deployments/:id/:agentId/config",
  "POST /api/packs/:id/unpublish",
  "POST /api/packs/:id/subscribe",
  "DELETE /api/packs/:id/subscribe",
  "GET /api/packs/subscriptions/updates",
];
