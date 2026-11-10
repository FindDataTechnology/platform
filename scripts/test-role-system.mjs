// Business roles (openspec: role-system). Unit coverage for the resolution
// chain and the admin composition, plus the cell route surface over a fake
// db: enumeration, admin listing, whole-assignment replace, 403/4xx
// semantics. The resolution order is the load-bearing contract —
// gateway header wins, then stored per-user, then env seed, then stored
// default, then env default, then `standard` — so each layer gets its own
// case with the layers below it present.

import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import express from "express";
import { test } from "node:test";
import { registerMiscRoutes } from "../server/routes/misc.js";
import {
  BUSINESS_ROLES,
  DEFAULT_ROLE,
  admissionView,
  composeAdmin,
  effectiveAdmissionGroups,
  parseRoleHeaders,
  resolveAssignment,
} from "../server/roles.js";

function fakeDb(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    isDbReady: () => true,
    getDeploymentConfig: (k) => store.get(k) ?? null,
    setDeploymentConfig: (k, v) => store.set(k, String(v)),
  };
}

const roleDoc = (assignments = {}, def = null) => ({ "roles.assignments": JSON.stringify({ assignments, default: def }) });

test("fallback: no data anywhere resolves to standard", () => {
  const r = resolveAssignment({ user: { email: "a@b.c" }, db: fakeDb(), env: {} });
  assert.deepEqual(r, { primary: DEFAULT_ROLE, secondary: [], admin: false, source: "fallback" });
});

test("env default seeds below stored data", () => {
  const env = { ROLES_DEFAULT_PRIMARY: "technical", ROLES_DEFAULT_SECONDARY: "legal,stock" };
  const r = resolveAssignment({ user: { email: "a@b.c" }, db: fakeDb(), env });
  assert.deepEqual(r, { primary: "technical", secondary: ["legal", "stock"], admin: false, source: "env-default" });
});

test("stored per-user wins over env seed", () => {
  const db = fakeDb(roleDoc({ "a@b.c": { primary: "paper", secondary: [] } }));
  const env = { ROLES_DEFAULT_PRIMARY: "technical", ROLES_SEED_ASSIGNMENTS: JSON.stringify({ "a@b.c": { primary: "legal" } }) };
  const r = resolveAssignment({ user: { email: "a@b.c" }, db, env });
  assert.equal(r.primary, "paper");
  assert.equal(r.source, "stored");
});

test("env per-user seed wins over stored default", () => {
  const db = fakeDb(roleDoc({}, { primary: "legal", secondary: [] }));
  const env = { ROLES_SEED_ASSIGNMENTS: JSON.stringify({ "a@b.c": { primary: "stock" } }) };
  const r = resolveAssignment({ user: { email: "a@b.c" }, db, env });
  assert.equal(r.primary, "stock");
  assert.equal(r.source, "env-seed");
});

test("stored default wins over env default", () => {
  const db = fakeDb(roleDoc({}, { primary: "financial", secondary: [] }));
  const env = { ROLES_DEFAULT_PRIMARY: "technical" };
  const r = resolveAssignment({ user: { email: "a@b.c" }, db, env });
  assert.equal(r.primary, "financial");
  assert.equal(r.source, "stored-default");
});

test("gateway assignment outranks every local layer", () => {
  const db = fakeDb(roleDoc({ "a@b.c": { primary: "paper" } }));
  const env = { ROLES_DEFAULT_PRIMARY: "technical" };
  const r = resolveAssignment({
    user: { email: "a@b.c" },
    gatewayAssignment: { primary: "legal", secondary: ["stock"], admin: true },
    db,
    env,
  });
  assert.deepEqual(r, { primary: "legal", secondary: ["stock"], admin: true, source: "gateway" });
});

test("gateway headers parse: JSON list, dedupe, unknown slugs dropped", () => {
  const parsed = parseRoleHeaders({
    "x-forwarded-roles": JSON.stringify(["legal", "legal", "nope", "stock"]),
    "x-forwarded-role-admin": "1",
  });
  assert.deepEqual(parsed, { primary: "legal", secondary: ["stock"], admin: true });
  // Malformed / absent header = no assignment (resolution falls through).
  assert.equal(parseRoleHeaders({ "x-forwarded-roles": "not-json" }), null);
  assert.equal(parseRoleHeaders({}), null);
  assert.equal(parseRoleHeaders({ "x-forwarded-roles": JSON.stringify(["bogus"]) }), null);
});

test("admin composes: group membership OR stored flag", () => {
  const adminGroups = ["admin"];
  assert.equal(composeAdmin({ assignment: null, user: { groups: ["admin"] }, adminGroups }), true);
  assert.equal(composeAdmin({ assignment: { admin: true }, user: { groups: [] }, adminGroups }), true);
  assert.equal(composeAdmin({ assignment: { admin: false }, user: { groups: ["users"] }, adminGroups }), false);
  assert.equal(composeAdmin({ assignment: null, user: undefined, adminGroups }), false);
});

test("admission: identity groups authoritative when present", () => {
  const roles = { primary: "legal", secondary: ["stock"] };
  assert.deepEqual(effectiveAdmissionGroups({ roles, identityGroups: ["analysts"] }), ["analysts"]);
});

test("admission: role mapping stands in only without identity groups", () => {
  const roles = { primary: "legal", secondary: ["stock"] };
  assert.deepEqual(effectiveAdmissionGroups({ roles, identityGroups: [] }), ["legal", "analysts"]);
  // No identity at all (auth off / no snapshot) = no filtering.
  assert.equal(effectiveAdmissionGroups({ roles, identityGroups: null }), null);
});

test("admissionView substitutes groups for role-only identities", () => {
  const view = admissionView({ email: "a@b.c", groups: [], roles: { primary: "legal", secondary: [] } });
  assert.deepEqual(view.groups, ["legal"]);
  // With identity groups the view is untouched.
  const untouched = admissionView({ email: "a@b.c", groups: ["analysts"], roles: { primary: "legal", secondary: [] } });
  assert.deepEqual(untouched.groups, ["analysts"]);
});

// ── Route surface ───────────────────────────────────────────────────────────

function request(app, path, { method = "GET", body, user } = {}) {
  const server = createServer((req, res) => {
    req.user = user ?? null;
    app(req, res);
  });
  return new Promise((resolve, reject) => {
    server.unref();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path,
          method,
          headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {},
        },
        (res) => {
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (c) => {
            data += c;
          });
          res.on("end", () => {
            server.close();
            resolve({ status: res.statusCode, json: data ? JSON.parse(data) : null });
          });
        },
      );
      req.on("error", reject);
      req.end(payload);
    });
  });
}

function makeApp({ db, authEnabled = true, isAdmin = false }) {
  const app = express();
  app.use(express.json());
  const ctx = {
    app,
    catalog: { getCatalogFor: () => ({ agents: [], apps: [] }) },
    db,
    cron: null,
    authEnabled,
    authMode: authEnabled ? "forward_auth" : "none",
    adminGroups: ["admin"],
    isAdminUser: () => isAdmin,
    requireAdmin: (_req, res) => {
      if (authEnabled && !isAdmin) {
        res.status(403).json({ error: "Admin group required" });
        return false;
      }
      return true;
    },
    ssoEnabled: false,
    authModeValue: "forward_auth",
    AUTH_LOGIN_PATH: "/oauth2/start",
    AUTH_LOGOUT_PATH: "/oauth2/sign_out",
  };
  registerMiscRoutes(ctx);
  return app;
}

test("GET /api/roles enumerates the closed slug set", async () => {
  const app = makeApp({ db: fakeDb() });
  const res = await request(app, "/api/roles", { user: { email: "u@e.c" } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.roles, BUSINESS_ROLES);
  assert.equal(res.json.default, "standard");
});

test("assignments PUT: non-admin is 403 with nothing stored", async () => {
  const db = fakeDb();
  const app = makeApp({ db, isAdmin: false });
  const res = await request(app, "/api/roles/assignments/u%40e.c", {
    method: "PUT",
    body: { primary: "legal" },
    user: { email: "u@e.c" },
  });
  assert.equal(res.status, 403);
  assert.equal(db.getDeploymentConfig("roles.assignments"), null);
});

test("assignments PUT: unknown slug is 400 with nothing stored", async () => {
  const db = fakeDb();
  const app = makeApp({ db, isAdmin: true });
  const res = await request(app, "/api/roles/assignments/u%40e.c", {
    method: "PUT",
    body: { primary: "wizard" },
    user: { email: "admin@e.c" },
  });
  assert.equal(res.status, 400);
  assert.equal(db.getDeploymentConfig("roles.assignments"), null);
});

test("assignments PUT: admin write round-trips and shows in the listing", async () => {
  const db = fakeDb();
  const app = makeApp({ db, isAdmin: true });
  const put = await request(app, "/api/roles/assignments/u%40e.c", {
    method: "PUT",
    body: { primary: "legal", secondary: ["stock", "stock"], admin: false },
    user: { email: "admin@e.c" },
  });
  assert.equal(put.status, 200);
  assert.equal(put.json.primary, "legal");
  assert.deepEqual(put.json.secondary, ["stock"]);

  const list = await request(app, "/api/roles/assignments", { user: { email: "admin@e.c" } });
  assert.equal(list.status, 200);
  const row = list.json.assignments.find((r) => r.email === "u@e.c");
  assert.equal(row.primary, "legal");
  assert.deepEqual(row.secondary, ["stock"]);

  // Neutral assignment (default primary, no secondary, no flag) clears the row.
  const clear = await request(app, "/api/roles/assignments/u%40e.c", {
    method: "PUT",
    body: { primary: "standard", secondary: [], admin: false },
    user: { email: "admin@e.c" },
  });
  assert.equal(clear.status, 200);
  const after = await request(app, "/api/roles/assignments", { user: { email: "admin@e.c" } });
  assert.equal(after.json.assignments.find((r) => r.email === "u@e.c"), undefined);
});

test("assignments PUT: admin flag is stored and composes with a business role", async () => {
  const db = fakeDb();
  const app = makeApp({ db, isAdmin: true });
  const res = await request(app, "/api/roles/assignments/u%40e.c", {
    method: "PUT",
    body: { primary: "technical", admin: true },
    user: { email: "admin@e.c" },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.admin, true);
  assert.equal(res.json.primary, "technical");
});

test("GET /api/auth/me reports the composed admin answer and roles", async () => {
  const db = fakeDb();
  const app = makeApp({ db, isAdmin: true });
  const res = await request(app, "/api/auth/me", { user: { email: "u@e.c", roles: { primary: "legal", secondary: [] } } });
  assert.equal(res.status, 200);
  assert.equal(res.json.isAdmin, true);
  assert.deepEqual(res.json.roles, { primary: "legal", secondary: [] });
});
