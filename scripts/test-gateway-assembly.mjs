#!/usr/bin/env node
// ── Gateway assembly smoke (harden-cell-execution-reliability task 3.2) ──────
//
// Spec (harness-adapter, "Core execution modules carry contract tests"):
// `gateway/index.js` — assembly smoke asserting the OpenAPI paths shape.
//
// The gateway carries NO OpenAPI artifact (repo audit 2026-11-06), so the
// spec's "paths shape" is asserted against the registry the app actually
// keeps: the Express route table read off the assembled app — one noted
// adaptation, same regression guard. The assembly itself is the test: the
// module boots its full route surface in test mode (GATEWAY_ASSEMBLY_ONLY=1,
// no port bound, no cell spawned, throwaway data root, loopback OIDC stub)
// and every key face must be registered BEFORE the cell-proxy catch-all.
//
// The import runs in a self-re-execed child (GATEWAY_ASSEMBLY_CHILD=1): the
// gateway's sqlite handles and module state stay out of the runner process
// and die with the child (same process-hygiene doctrine as
// scripts/lib/test-server.mjs). The child prints the route table as one
// JSON line; the parent asserts on it.
//
//   node --test scripts/test-gateway-assembly.mjs

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SELF = fileURLToPath(import.meta.url);
const MARKER = "__GATEWAY_ASSEMBLY__";
const CHILD_TIMEOUT_MS = 60_000;

// ── child mode: assemble the real gateway and print its route registry ──────

// The gateway hard-wires AUTH_MODE=logto and performs OIDC discovery at boot,
// so assembly needs a discovery+jwks responder — loopback only, no upstream.
function startOidcStub() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const base = `http://127.0.0.1:${server.address().port}`;
      res.setHeader("content-type", "application/json");
      if (req.url.includes("openid-configuration")) {
        return res.end(
          JSON.stringify({
            issuer: base,
            authorization_endpoint: `${base}/oidc/auth`,
            token_endpoint: `${base}/oidc/token`,
            jwks_uri: `${base}/oidc/jwks`,
            end_session_endpoint: `${base}/oidc/session/end`,
          }),
        );
      }
      if (req.url.includes("jwks")) return res.end(JSON.stringify({ keys: [] }));
      res.statusCode = 404;
      res.end("{}");
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

// Express 4 keeps the registry on app._router; layers either carry a Route
// (methods × path) or are mounted middleware (static, the SPA fallback, the
// final cell-proxy catch-all).
function routeEntries(app) {
  const stack = app?._router?.stack;
  if (!Array.isArray(stack)) {
    throw new Error("no Express route registry on the assembled app (expected app._router.stack)");
  }
  return stack.map((layer) => {
    if (layer.route) {
      const methods = Object.entries(layer.route.methods ?? {})
        .filter(([, on]) => on)
        .map(([m]) => m.toLowerCase());
      return { kind: "route", path: String(layer.route.path), methods };
    }
    const name = layer.name ?? layer.handle?.name ?? "anonymous";
    if (name === "serveStatic" || name === "static") return { kind: "static", name };
    return { kind: "middleware", name, regexp: String(layer.regexp ?? "") };
  });
}

async function runChild() {
  const oidc = await startOidcStub();
  const dataRoot = await mkdtemp(path.join(tmpdir(), "gw-assembly-"));
  // Pre-set EVERY env the assembly must not inherit from a developer .env —
  // dotenv/config (imported by the gateway) never overrides existing vars.
  Object.assign(process.env, {
    GATEWAY_ASSEMBLY_ONLY: "1",
    CELL_GATEWAY_SECRET: "assembly-smoke-secret",
    CELL_DATA_ROOT: dataRoot,
    CELL_REGISTRY_DISABLE: "1",
    CELL_IDLE_REAP_SECS: "0",
    SESSION_SECRET: "assembly-smoke-session-secret",
    LOGTO_ENDPOINT: `http://127.0.0.1:${oidc.address().port}`,
    LOGTO_APP_ID: "assembly-test",
    LOGTO_APP_SECRET: "assembly-test-secret",
    LOGTO_CLIENT_TYPE: "confidential",
    FACET_BASE_URL: "",
    FLEET_INGEST_URL: "",
    FLEET_INGEST_TOKEN: "",
    DESK_EMBED_HOST: "",
    MP_DEMO_MODE: "",
    PACK_MARKETPLACE: "",
    PACK_ANONYMOUS_READ: "",
    BOTS_RELAY_OWNER_EMAIL: "",
  });
  try {
    const { gatewayAppForTests: app } = await import(path.join(REPO, "gateway", "index.js"));
    if (!app || typeof app !== "function") {
      throw new Error("gateway/index.js did not export the assembled app (gatewayAppForTests)");
    }
    const routes = routeEntries(app);
    process.stdout.write(`${MARKER}${JSON.stringify({ routes })}\n`);
  } finally {
    oidc.close();
    await rm(dataRoot, { recursive: true, force: true }).catch(() => {});
  }
  process.exit(0);
}

// Child dispatch: run the assembly, print the registry line, exit — never
// register tests (the re-exec would otherwise recurse).
if (process.env.GATEWAY_ASSEMBLY_CHILD === "1") {
  await runChild();
}

// ── parent mode: spawn the child, parse the registry, assert the faces ──────

async function assembleInChild() {
  const child = spawn(process.execPath, [SELF], {
    env: { ...process.env, GATEWAY_ASSEMBLY_CHILD: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (b) => (stdout += b));
  child.stderr.on("data", (b) => (stderr += b));
  const timer = setTimeout(() => child.kill("SIGKILL"), CHILD_TIMEOUT_MS);
  const code = await new Promise((resolve) => child.on("exit", (c) => resolve(c)));
  clearTimeout(timer);
  assert.equal(code, 0, `the gateway assembled in test mode must exit cleanly (code ${code})\n${stderr}`);
  const line = stdout.split("\n").find((l) => l.startsWith(MARKER));
  assert.ok(line, `the child must print the ${MARKER} route registry line\nstderr: ${stderr}`);
  return JSON.parse(line.slice(MARKER.length));
}

function findRoute(routes, method, routePath) {
  return routes.find((r) => r.kind === "route" && r.path === routePath && r.methods.includes(method.toLowerCase()));
}

test("gateway assembly smoke: the full route surface assembles in test mode with key faces before the cell-proxy catch-all", async () => {
  const { routes } = await assembleInChild();

  // 1. Assembly regression guard — the key identity/auth faces.
  for (const [method, face] of [
    ["GET", "/healthz"],
    ["GET", "/api/config"],
    ["GET", "/api/auth/me"],
    ["POST", "/api/mp/login"],
    ["POST", "/api/mp/login-bindcode"],
    ["DELETE", "/api/mp/bind"],
    ["GET", "/api/mp/bindcode"],
    ["POST", "/api/app/pair"],
  ]) {
    assert.ok(findRoute(routes, method, face), `${method} ${face} must be registered`);
  }

  // 2. Steward reporting + desired-state doors (the cell-report module's faces).
  assert.ok(findRoute(routes, "POST", "/api/gateway/cell-report"), "POST /api/gateway/cell-report must be registered");
  assert.ok(findRoute(routes, "GET", "/api/gateway/desired-fleet"), "GET /api/gateway/desired-fleet must be registered");

  // 3. Operator/admin faces.
  assert.ok(findRoute(routes, "GET", "/api/roles"), "GET /api/roles must be registered");
  assert.ok(findRoute(routes, "GET", "/api/gateway/status"), "GET /api/gateway/status must be registered");
  assert.ok(
    findRoute(routes, "DELETE", "/api/gateway/cells/:userId"),
    "DELETE /api/gateway/cells/:userId must be registered",
  );
  assert.ok(findRoute(routes, "GET", "/api/machines"), "GET /api/machines must be registered (fleet machines console)");

  // 4. Share brokerage + marketplace/wanxing/zhiyu fronts.
  assert.ok(findRoute(routes, "POST", "/api/share"), "POST /api/share must be registered");
  assert.ok(findRoute(routes, "GET", "/api/share/:token"), "GET /api/share/:token must be registered");
  assert.ok(findRoute(routes, "GET", "/api/packs"), "GET /api/packs must be registered");
  // The wanxing card/catalog/management face no longer mounts here (unify-
  // wanxing-a2a-face 4.1: single serving point is the independent facade,
  // FindDataTechnology/fd-wanxing) — /api/wanxing/* is intentionally absent.
  assert.ok(!findRoute(routes, "GET", "/api/wanxing/v1/ops/usage"), "wanxing ops face must stay UNMOUNTED (facade is the single serving point)");
  assert.ok(findRoute(routes, "GET", "/api/zhiyu/health"), "GET /api/zhiyu/health must be registered");

  // 5. Machine-caller lanes: the bot webhook is an app.all (any verb), the
  // relay lane is a regex route.
  const webhook = findRoute(routes, "get", "/api/bots/webhook/:botId/:secret");
  assert.ok(webhook, "bot webhook face must be registered");
  for (const verb of ["post", "put", "delete"]) {
    assert.ok(webhook.methods.includes(verb), "bot webhook answers every verb (app.all)");
  }
  assert.ok(
    routes.some((r) => r.kind === "route" && String(r.path).includes("api\\/bots\\/relay")),
    "the bot relay regex lane must be registered",
  );

  // 5b. Disclosure-gate machine door (fix-disclosure-gate-reachability): the
  // verdict channel is machine-to-machine, so it CANNOT live behind the
  // cell-proxy catch-all — that catch-all resolves a user first and refuses
  // machine callers (measured 2026-11-11: correct bearer → 401, forever).
  // Asserted here because only the assembled app knows where a route sits
  // relative to the catch-all; the ordering rule below then pins it.
  assert.ok(
    findRoute(routes, "POST", "/api/actions/mandate-verdict"),
    "the disclosure-gate machine door must be registered before the catch-all",
  );

  // 5c. Input-request machine door (add-acp-input-request-owner): same reason as
  // 5b — the ACP lane is machine-to-machine with a shared bearer, so it cannot
  // live behind the cell-proxy catch-all either (measured 2026-11-12: the mount
  // was there, a correct bearer still answered 401).
  assert.ok(
    findRoute(routes, "POST", "/api/mcp/input-request/mcp"),
    "the input-request machine door must be registered before the catch-all",
  );

  // 6. Shape invariants: the pre-login SPA shell is served by a static mount
  // plus a negative-lookahead SPA fallback, and the cell-proxy catch-all is
  // the LAST layer — every face above sits before it, or a cell could never
  // be reached by its own traffic.
  assert.ok(routes.some((r) => r.kind === "static"), "the SPA shell static mount must be present");
  const fallback = routes.find((r) => r.kind === "route" && String(r.path).startsWith("/^\\/"));
  assert.ok(fallback && String(fallback.path).includes("(?!api\\/"), "the SPA fallback must exclude the API prefixes");
  const last = routes[routes.length - 1];
  assert.equal(last.kind, "middleware", "the cell-proxy catch-all must be the last layer");
  const catchAllIndex = routes.length - 1;
  const routeIndexes = routes.map((r, i) => (r.kind === "route" ? i : -1)).filter((i) => i >= 0);
  assert.ok(
    routeIndexes.every((i) => i < catchAllIndex),
    "every concrete route must be registered before the cell-proxy catch-all",
  );
  assert.ok(routes.length >= 30, `the assembly is implausibly small (${routes.length} layers)`);
});

test("gateway assembly smoke: the production default still binds (GATEWAY_ASSEMBLY_ONLY unset keeps listen wired)", async () => {
  // The seam is env-guarded; assert the guard's negative branch textually so a
  // refactor that drops the listen call entirely (or makes it unconditional
  // under the flag) is caught at the source level too.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(path.join(REPO, "gateway", "index.js"), "utf8");
  assert.match(src, /GATEWAY_ASSEMBLY_ONLY !== "1"[\s\S]*server\.listen\(PORT, HOST/, "server.listen stays behind the assembly-only guard");
  assert.match(src, /export const gatewayAppForTests = app;/, "the test export stays pinned");
});
