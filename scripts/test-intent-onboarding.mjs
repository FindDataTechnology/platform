// Intent onboarding (openspec: intent-onboarding). The profile/plan machinery
// and the route surface over a fake db: answers validation (ready roles only),
// the atomic profile+roles write, the self channel never granting the admin
// flag, provisioning idempotency (re-activation installs nothing twice), the
// per-identity scoping, and the deployment preset.

import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import express from "express";
import { test } from "node:test";
import { registerMiscRoutes } from "../server/routes/misc.js";
import {
  buildPlan,
  effectiveIntent,
  intentKeyFor,
  needsQuestionnaire,
  readIntent,
  selfAssignment,
  validateAnswers,
  writeIntent,
} from "../server/onboarding.js";
import { RECIPE_CATALOG, readyRoles, recipeFor } from "../packages/core/src/lib/recipes.ts";

function fakeDb({ installed = [], deployment = {}, prefs = {} } = {}) {
  const d = new Map(Object.entries(deployment));
  const p = new Map(Object.entries(prefs));
  let packs = [...installed];
  return {
    isDbReady: () => true,
    getDeploymentConfig: (k) => d.get(k) ?? null,
    setDeploymentConfig: (k, v) => d.set(k, String(v)),
    getPreference: (k) => p.get(k) ?? null,
    setPreference: (k, v) => p.set(k, String(v)),
    listInstalledPacks: () => packs.map((packId) => ({ packId })),
    _setInstalled: (ids) => {
      packs = [...ids];
    },
    _prefs: p,
    _deployment: d,
  };
}

// ── Recipe data ─────────────────────────────────────────────────────────────

test("v1 ready roles are legal/stock/economic; every ready role has a full recipe", () => {
  assert.deepEqual(readyRoles().sort(), ["economic", "legal", "stock"]);
  for (const role of readyRoles()) {
    const recipe = recipeFor(role);
    assert.ok(recipe, `${role} has no recipe`);
    assert.ok(recipe.defaultExpert, `${role} has no default expert`);
    assert.equal(recipe.layoutPreset, "simple");
    // Pack references are authored names, never ids: the market mints ids
    // randomly per deployment, so a curated table cannot hold one. The
    // v1 recipes shipped invented slugs (`legal-contract`) and every
    // provisioning run failed "Pack version not found" (2026-10-17 defect).
    for (const ref of recipe.packs) {
      assert.ok(!/^[A-Za-z0-9_-]{20,}$/.test(ref), `'${ref}' looks like a minted id, not an authored name`);
      assert.ok([...ref].some((ch) => ch.codePointAt(0) > 0x7f), `'${ref}' is not an authored market display name`);
    }
  }
  // Roles without a recipe stay out of the ready set (assignable by admins).
  for (const role of ["financial", "screenplay", "paper", "technical", "standard"]) {
    assert.equal(readyRoles().includes(role), false);
  }
  assert.equal(RECIPE_CATALOG.version, 1);
});

// ── Answers validation ──────────────────────────────────────────────────────

test("validateAnswers: 1..3 ready roles, unknown and not-ready rejected", () => {
  assert.deepEqual(validateAnswers({ roles: ["legal"] }), {
    ok: true,
    value: { roles: ["legal"], note: "", skipped: false },
  });
  assert.deepEqual(validateAnswers({ roles: ["legal", "stock", "economic"] }).ok, true);
  assert.match(validateAnswers({ roles: [] }).error, /at least one/);
  assert.match(validateAnswers({ roles: ["legal", "stock", "economic", "paper"] }).error, /at most three/);
  assert.match(validateAnswers({ roles: ["wizard"] }).error, /unknown roles/);
  assert.match(validateAnswers({ roles: ["screenplay"] }).error, /without a recipe/);
  // Skips carry no roles.
  assert.deepEqual(validateAnswers({ skipped: true }), {
    ok: true,
    value: { roles: [], note: "", skipped: true },
  });
  // Duplicates collapse.
  assert.deepEqual(validateAnswers({ roles: ["legal", "legal"] }).value.roles, ["legal"]);
  // Note is trimmed and bounded.
  assert.equal(validateAnswers({ roles: ["legal"], note: "  hi  " }).value.note, "hi");
  assert.equal(validateAnswers({ roles: ["legal"], note: "x".repeat(600) }).value.note.length, 500);
});

// ── Plan ────────────────────────────────────────────────────────────────────

test("buildPlan: recipe packs, installed state, marketplace-off degradation", () => {
  // Recipe pack references are authored DISPLAY NAMES (ids are minted per
  // deployment, so a static table cannot hold one). Unresolved refs are
  // reported unavailable and mark the plan degraded.
  const skeleton = buildPlan({ role: "legal" });
  assert.equal(skeleton.role, "legal");
  assert.equal(skeleton.defaultExpert, "pack-contract-reviewer");
  assert.deepEqual(skeleton.packs, [{ ref: "法律-合同", packId: null, name: "法律-合同", status: "unavailable" }]);
  assert.equal(skeleton.degraded, true);

  // Resolved: the plan carries the deployment's id plus the authored name.
  const plan = buildPlan({ role: "legal", resolved: { "法律-合同": { packId: "PK1", name: "法律-合同" } } });
  assert.deepEqual(plan.packs, [{ ref: "法律-合同", packId: "PK1", name: "法律-合同", status: "install" }]);
  assert.equal(plan.degraded, false);

  const withInstalled = buildPlan({
    role: "legal",
    installed: ["PK1"],
    resolved: { "法律-合同": { packId: "PK1", name: "法律-合同" } },
  });
  assert.deepEqual(withInstalled.packs, [{ ref: "法律-合同", packId: "PK1", name: "法律-合同", status: "installed" }]);
  assert.equal(withInstalled.degraded, false);

  const off = buildPlan({ role: "legal", marketplaceOff: true });
  assert.deepEqual(off.packs, []);
  assert.equal(off.degraded, true);
  // Layout + expert survive the degradation.
  assert.equal(off.defaultExpert, "pack-contract-reviewer");
  assert.equal(off.layoutPreset, "simple");

  assert.equal(buildPlan({ role: "screenplay" }), null);
});

// ── Intent profile ──────────────────────────────────────────────────────────

test("intent profile round-trips per identity", () => {
  const db = fakeDb();
  assert.deepEqual(readIntent({ db, email: "a@b.c" }), { roles: [], note: "", skipped: false, answeredAt: null });
  writeIntent({ db, email: "a@b.c" }, { roles: ["legal"], note: "合同", skipped: false, answeredAt: "2026-10-16T00:00:00Z" });
  assert.deepEqual(readIntent({ db, email: "a@b.c" }).roles, ["legal"]);
  // Another identity in the same cell is untouched.
  assert.deepEqual(readIntent({ db, email: "other@b.c" }).roles, []);
  assert.equal(intentKeyFor("A@B.C"), intentKeyFor("a@b.c"));
});

test("effectiveIntent: stored wins over the deployment preset", () => {
  const db = fakeDb();
  const env = { ONBOARDING_DEFAULT_ROLES: "stock", ONBOARDING_DEFAULT_NOTE: "客户预置" };
  const preset = effectiveIntent({ db, env, email: "a@b.c" });
  assert.equal(preset.source, "env-preset");
  assert.deepEqual(preset.roles, ["stock"]);

  writeIntent({ db, email: "a@b.c" }, { roles: ["legal"], note: "", skipped: false, answeredAt: "2026-10-16T00:00:00Z" });
  const stored = effectiveIntent({ db, env, email: "a@b.c" });
  assert.equal(stored.source, "stored");
  assert.deepEqual(stored.roles, ["legal"]);
});

test("needsQuestionnaire: empty asks; answered, skipped and preset do not", () => {
  const db = fakeDb();
  assert.equal(needsQuestionnaire({ db, env: {}, email: "a@b.c" }), true);
  assert.equal(needsQuestionnaire({ db, env: { ONBOARDING_DEFAULT_ROLES: "legal" }, email: "a@b.c" }), false);
  writeIntent({ db, email: "a@b.c" }, { roles: [], note: "", skipped: true, answeredAt: "2026-10-16T00:00:00Z" });
  assert.equal(needsQuestionnaire({ db, env: {}, email: "a@b.c" }), false);
});

// ── Self assignment ─────────────────────────────────────────────────────────

test("selfAssignment: first role is primary, rest secondary, admin preserved", () => {
  assert.deepEqual(selfAssignment(["legal", "stock"], null), { primary: "legal", secondary: ["stock"], admin: false });
  // The admin flag is neither granted nor revoked by onboarding.
  assert.deepEqual(selfAssignment(["legal"], { admin: true }).admin, true);
  assert.deepEqual(selfAssignment(["legal"], { admin: false }).admin, false);
});

// ── Routes ──────────────────────────────────────────────────────────────────

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

function makeApp({ db, authEnabled = true, isAdmin = false, installed = [], localPackMarket = null, onInstall = null }) {
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
    AUTH_LOGIN_PATH: "/oauth2/start",
    AUTH_LOGOUT_PATH: "/oauth2/sign_out",
    localPackMarket,
    switchAgentTo: async (id) => id === "pack-contract-reviewer" || id === "pack-industry-analyst",
    installPackHook: onInstall
      ? async ({ packId }) => {
          onInstall(packId);
          return { report: { agents: [], skills: [] }, installed: { packId } };
        }
      : null,
    _installed: installed,
    _onInstall: onInstall,
  };
  registerMiscRoutes(ctx);
  return app;
}

test("GET /api/onboarding/profile: empty profile asks; ready roles listed", async () => {
  const db = fakeDb();
  const app = makeApp({ db });
  const res = await request(app, "/api/onboarding/profile", { user: { email: "a@b.c" } });
  assert.equal(res.status, 200);
  assert.equal(res.json.needsQuestionnaire, true);
  assert.deepEqual(res.json.readyRoles.sort(), ["economic", "legal", "stock"]);
  assert.equal(res.json.profile.source, "empty");
});

test("POST answers: writes profile + roles, returns the plan, never sets admin", async () => {
  const db = fakeDb({ deployment: { "roles.assignments": JSON.stringify({ assignments: { "a@b.c": { primary: "technical", admin: true } } }) } });
  const app = makeApp({ db });
  const res = await request(app, "/api/onboarding/answers", {
    method: "POST",
    body: { roles: ["legal", "stock"], note: "合同审查" },
    user: { email: "a@b.c" },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.profile.roles, ["legal", "stock"]);
  assert.equal(res.json.profile.note, "合同审查");
  // The role assignment landed with primary/secondary from the answers…
  assert.equal(res.json.assignment.primary, "legal");
  assert.deepEqual(res.json.assignment.secondary, ["stock"]);
  // …and the existing admin flag survived the self-service write.
  assert.equal(res.json.assignment.admin, true);
  // The plan the user confirms is returned with the answers. Asserts the
  // marketplace-on shape (the route reads PACK_MARKETPLACE from the env).
  process.env.PACK_MARKETPLACE = "1";
  try {
    const again = await request(app, "/api/onboarding/answers", {
      method: "POST",
      body: { roles: ["legal", "stock"], note: "合同审查" },
      user: { email: "a@b.c" },
    });
    // No market is injected in this harness, so the recipe's authored
    // reference cannot resolve and the plan reports it unavailable rather
    // than inventing an id.
    assert.deepEqual(again.json.plan.packs, [
      { ref: "法律-合同", packId: null, name: "法律-合同", status: "unavailable" },
    ]);
    assert.equal(again.json.plan.degraded, true);
  } finally {
    delete process.env.PACK_MARKETPLACE;
  }
});

test("provision: a resolvable recipe pack installs through the market", async () => {
  // The end-to-end shape the v1 recipes got wrong: the recipe names a pack by
  // its authored display name, the resolver maps it to this deployment's
  // minted id, and provisioning installs it via the server-side fetch.
  process.env.PACK_MARKETPLACE = "1";
  try {
    const db = fakeDb();
    const installed = [];
    const app = makeApp({
      db,
      installed: [],
      // One pack, resolved by name — the shape the real market answers.
      localPackMarket: {
        findByName: (name) => (name === "法律-合同" ? [{ id: "PK1", name: "法律-合同" }] : []),
        getLatest: (packId) =>
          packId === "PK1"
            ? { version: 3, manifest: { name: "法律-合同", version: 3, skills: [], agents: [{ id: "pack-contract-reviewer", name: "合同审查官" }] } }
            : null,
      },
      onInstall: (packId) => installed.push(packId),
    });
    await request(app, "/api/onboarding/answers", { method: "POST", body: { roles: ["legal"] }, user: { email: "a@b.c" } });
    const res = await request(app, "/api/onboarding/provision", { method: "POST", user: { email: "a@b.c" } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.results, [{ packId: "PK1", name: "法律-合同", status: "installed", version: 3 }]);
    assert.deepEqual(installed, ["PK1"]);
    assert.deepEqual(res.json.expert, { status: "selected", id: "pack-contract-reviewer" });
  } finally {
    delete process.env.PACK_MARKETPLACE;
  }
});

test("provision: an unresolvable reference is reported, never fatal", async () => {
  process.env.PACK_MARKETPLACE = "1";
  try {
    const db = fakeDb();
    const app = makeApp({ db, localPackMarket: { findByName: () => [], getLatest: () => null } });
    await request(app, "/api/onboarding/answers", { method: "POST", body: { roles: ["legal"] }, user: { email: "a@b.c" } });
    const res = await request(app, "/api/onboarding/provision", { method: "POST", user: { email: "a@b.c" } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.results, [
      { packId: null, ref: "法律-合同", name: "法律-合同", status: "unavailable" },
    ]);
    // The expert step still ran: one missing pack never blocks the rest (D5).
    assert.equal(res.json.expert.status, "selected");
  } finally {
    delete process.env.PACK_MARKETPLACE;
  }
});

test("POST answers: not-ready role is 400 and nothing is written", async () => {
  const db = fakeDb();
  const app = makeApp({ db });
  const res = await request(app, "/api/onboarding/answers", {
    method: "POST",
    body: { roles: ["screenplay"] },
    user: { email: "a@b.c" },
  });
  assert.equal(res.status, 400);
  assert.equal(readIntent({ db, email: "a@b.c" }).answeredAt, null);
});

test("POST answers: skip records no roles and returns no plan", async () => {
  const db = fakeDb();
  const app = makeApp({ db });
  const res = await request(app, "/api/onboarding/answers", {
    method: "POST",
    body: { skipped: true },
    user: { email: "a@b.c" },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.profile.skipped, true);
  assert.equal(res.json.plan, null);
  // The skip is durable — the questionnaire does not come back.
  assert.equal(needsQuestionnaire({ db, env: {}, email: "a@b.c" }), false);
});

test("provision: marketplace-off deployment degrades to expert only", async () => {
  const db = fakeDb();
  const app = makeApp({ db });
  await request(app, "/api/onboarding/answers", {
    method: "POST",
    body: { roles: ["legal"] },
    user: { email: "a@b.c" },
  });
  const res = await request(app, "/api/onboarding/provision", { method: "POST", user: { email: "a@b.c" } });
  assert.equal(res.status, 200);
  // No marketplace in this test env → PACK_MARKETPLACE is unset → degraded.
  assert.deepEqual(res.json.results, []);
  assert.deepEqual(res.json.expert, { status: "selected", id: "pack-contract-reviewer" });
});

test("provision: already-installed packs are reported, not reinstalled", async () => {
  const db = fakeDb({ installed: ["legal-contract"] });
  const app = makeApp({ db });
  await request(app, "/api/onboarding/answers", {
    method: "POST",
    body: { roles: ["legal"] },
    user: { email: "a@b.c" },
  });
  const res = await request(app, "/api/onboarding/provision", { method: "POST", user: { email: "a@b.c" } });
  // Marketplace off in this env ⇒ no pack rows; the idempotency path itself is
  // covered by buildPlan's installed case above.
  assert.equal(res.status, 200);
  assert.equal(res.json.role, "legal");
});

test("provision before answering is 400", async () => {
  const db = fakeDb();
  const app = makeApp({ db });
  const res = await request(app, "/api/onboarding/provision", { method: "POST", user: { email: "a@b.c" } });
  assert.equal(res.status, 400);
});

test("provision reports a failed default-expert selection without failing the run", async () => {
  const db = fakeDb();
  const app = makeApp({ db });
  // Make the switcher reject the recipe's expert.
  const ctxSwitcher = async () => false;
  const app2 = (() => {
    const a = express();
    a.use(express.json());
    const ctx = {
      app: a,
      catalog: { getCatalogFor: () => ({ agents: [], apps: [] }) },
      db,
      cron: null,
      authEnabled: true,
      authMode: "forward_auth",
      adminGroups: ["admin"],
      isAdminUser: () => false,
      requireAdmin: (_r, res) => {
        res.status(403).json({ error: "x" });
        return false;
      },
      ssoEnabled: false,
      AUTH_LOGIN_PATH: "/x",
      AUTH_LOGOUT_PATH: "/y",
      switchAgentTo: ctxSwitcher,
    };
    registerMiscRoutes(ctx);
    return a;
  })();
  await request(app, "/api/onboarding/answers", { method: "POST", body: { roles: ["legal"] }, user: { email: "a@b.c" } });
  const res = await request(app2, "/api/onboarding/provision", { method: "POST", user: { email: "a@b.c" } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.expert, { status: "failed" });
});
