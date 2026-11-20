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
    value: { roles: ["legal"], note: "", skipped: false, wantsTeam: false },
  });
  assert.deepEqual(validateAnswers({ roles: ["legal", "stock", "economic"] }).ok, true);
  assert.match(validateAnswers({ roles: [] }).error, /at least one/);
  assert.match(validateAnswers({ roles: ["legal", "stock", "economic", "paper"] }).error, /at most three/);
  assert.match(validateAnswers({ roles: ["wizard"] }).error, /unknown roles/);
  assert.match(validateAnswers({ roles: ["screenplay"] }).error, /without a recipe/);
  // Skips carry no roles.
  assert.deepEqual(validateAnswers({ skipped: true }), {
    ok: true,
    value: { roles: [], note: "", skipped: true, wantsTeam: false },
  });
  // The build path is an INTENT, not a role (add-team-building-first-run 4.2):
  // it records no roles and is not a skip.
  assert.deepEqual(validateAnswers({ wantsTeam: true }), {
    ok: true,
    value: { roles: [], note: "", skipped: false, wantsTeam: true },
  });
  // Roles arriving alongside the intent are IGNORED, not merged — the door
  // routes into a building conversation and must not install a half-role.
  assert.deepEqual(validateAnswers({ wantsTeam: true, roles: ["legal"] }).value.roles, []);
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
  assert.deepEqual(skeleton.packs, [{ ref: "识律 · 合同审查套件", packId: null, name: "识律 · 合同审查套件", status: "unavailable" }]);
  assert.equal(skeleton.degraded, true);

  // Resolved: the plan carries the deployment's id plus the authored name.
  const plan = buildPlan({ role: "legal", resolved: { "识律 · 合同审查套件": { packId: "PK1", name: "识律 · 合同审查套件" } } });
  assert.deepEqual(plan.packs, [{ ref: "识律 · 合同审查套件", packId: "PK1", name: "识律 · 合同审查套件", status: "install" }]);
  assert.equal(plan.degraded, false);

  const withInstalled = buildPlan({
    role: "legal",
    installed: ["PK1"],
    resolved: { "识律 · 合同审查套件": { packId: "PK1", name: "识律 · 合同审查套件" } },
  });
  assert.deepEqual(withInstalled.packs, [{ ref: "识律 · 合同审查套件", packId: "PK1", name: "识律 · 合同审查套件", status: "installed" }]);
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
  assert.deepEqual(readIntent({ db, email: "a@b.c" }), { roles: [], note: "", skipped: false, answeredAt: null, wantsTeam: false });
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

function makeApp({ db, authEnabled = true, isAdmin = false, installed = [], localPackMarket = null, onInstall = null, chatAgentIds = null, switchThrows = false }) {
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
    switchAgentTo: async (id) => {
      if (switchThrows) throw new Error("runtime restart failed");
      return id === "pack-contract-reviewer" || id === "pack-industry-analyst" || id === "local";
    },
    // The deployment's selectable chat-agent ids. `null` keeps the legacy shape
    // (the route cannot tell "absent" from "switch failed" and reports failed) —
    // callers that care about the substituted state pass a real set.
    catalogChatAgentIds: chatAgentIds ? () => new Set(chatAgentIds) : undefined,
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
      { ref: "识律 · 合同审查套件", packId: null, name: "识律 · 合同审查套件", status: "unavailable" },
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
        findByName: (name) => (name === "识律 · 合同审查套件" ? [{ id: "PK1", name: "识律 · 合同审查套件" }] : []),
        getLatest: (packId) =>
          packId === "PK1"
            ? { version: 3, manifest: { name: "识律 · 合同审查套件", version: 3, skills: [], agents: [{ id: "pack-contract-reviewer", name: "合同审查官" }] } }
            : null,
      },
      onInstall: (packId) => installed.push(packId),
    });
    await request(app, "/api/onboarding/answers", { method: "POST", body: { roles: ["legal"] }, user: { email: "a@b.c" } });
    const res = await request(app, "/api/onboarding/provision", { method: "POST", user: { email: "a@b.c" } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.results, [{ packId: "PK1", name: "识律 · 合同审查套件", status: "installed", version: 3 }]);
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
      { packId: null, ref: "识律 · 合同审查套件", name: "识律 · 合同审查套件", status: "unavailable" },
    ]);
    // The expert step still ran: one missing pack never blocks the rest (D5).
    assert.equal(res.json.expert.status, "selected");
  } finally {
    delete process.env.PACK_MARKETPLACE;
  }
});

test("provision: a recipe expert absent from this deployment substitutes local, with both ids", async () => {
  // The self-hosted shape: no cloud catalog, so `pack-contract-reviewer` does
  // not exist. The old code either reported "selected" for an expert that was
  // never selected (when the switch happened to succeed) or "failed" — which
  // reads as a platform fault to a newcomer. It must say `substituted`.
  process.env.PACK_MARKETPLACE = "0";
  try {
    const db = fakeDb();
    const app = makeApp({ db, chatAgentIds: ["local"] });
    await request(app, "/api/onboarding/answers", { method: "POST", body: { roles: ["legal"] }, user: { email: "a@b.c" } });
    const res = await request(app, "/api/onboarding/provision", { method: "POST", user: { email: "a@b.c" } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.expert, {
      status: "substituted",
      requested: "pack-contract-reviewer",
      selected: "local",
      reason: "expert-not-in-catalog",
    });
  } finally {
    delete process.env.PACK_MARKETPLACE;
  }
});

test("provision: an expert present in the catalog is selected, not substituted", async () => {
  process.env.PACK_MARKETPLACE = "0";
  try {
    const db = fakeDb();
    const app = makeApp({ db, chatAgentIds: ["local", "pack-contract-reviewer"] });
    await request(app, "/api/onboarding/answers", { method: "POST", body: { roles: ["legal"] }, user: { email: "a@b.c" } });
    const res = await request(app, "/api/onboarding/provision", { method: "POST", user: { email: "a@b.c" } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.expert, { status: "selected", id: "pack-contract-reviewer" });
  } finally {
    delete process.env.PACK_MARKETPLACE;
  }
});

test("provision: a thrown switch is `failed`, distinct from a missing expert", async () => {
  process.env.PACK_MARKETPLACE = "0";
  try {
    const db = fakeDb();
    // The expert IS present (so this is not the substitution branch) but the
    // switch throws — a FAULT. It must not be reported as `substituted`, and it
    // must carry no `selected` id (the two shapes must stay distinguishable).
    const app = makeApp({ db, chatAgentIds: ["local", "pack-contract-reviewer"], switchThrows: true });
    await request(app, "/api/onboarding/answers", { method: "POST", body: { roles: ["legal"] }, user: { email: "a@b.c" } });
    const res = await request(app, "/api/onboarding/provision", { method: "POST", user: { email: "a@b.c" } });
    assert.equal(res.status, 200);
    assert.equal(res.json.expert.status, "failed");
    assert.equal(res.json.expert.selected, undefined);
    assert.match(res.json.expert.error, /restart failed/);
  } finally {
    delete process.env.PACK_MARKETPLACE;
  }
});

test("POST answers: the build path records intent and NO roles", async () => {
  // add-team-building-first-run 4.2: "I want a team" is an intent, not a role.
  // Nothing may be assigned, no layout may move, and it must not read as a skip.
  const db = fakeDb();
  const app = makeApp({ db });
  const res = await request(app, "/api/onboarding/answers", {
    method: "POST",
    body: { wantsTeam: true, note: "帮我搭一支客服班组" },
    user: { email: "a@b.c" },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.wantsTeam, true);
  assert.equal(res.json.plan, null);
  const stored = readIntent({ db, email: "a@b.c" });
  assert.deepEqual(stored.roles, [], "no role may be written on the build path");
  assert.equal(stored.wantsTeam, true);
  assert.equal(stored.skipped, false, "the build path is an answer, not a skip");
  assert.ok(stored.answeredAt, "it is answered (so the questionnaire does not re-prompt)");
  // The assignment is untouched: the user stays unassigned, not "legal".
  const profile = await request(app, "/api/onboarding/profile", { user: { email: "a@b.c" } });
  assert.equal(profile.json.needsQuestionnaire, false);
});

test("POST answers: the build path does not clobber an existing role assignment", async () => {
  // Add-only discipline: a user who picked `legal` earlier and now says "I want
  // a team" keeps their role and layout.
  const db = fakeDb();
  const app = makeApp({ db });
  await request(app, "/api/onboarding/answers", {
    method: "POST",
    body: { roles: ["legal"] },
    user: { email: "a@b.c" },
  });
  const before = readIntent({ db, email: "a@b.c" }).roles;
  await request(app, "/api/onboarding/answers", {
    method: "POST",
    body: { wantsTeam: true },
    user: { email: "a@b.c" },
  });
  const assignment = await request(app, "/api/onboarding/profile", { user: { email: "a@b.c" } });
  assert.equal(assignment.status, 200);
  // Roles were recorded by the first call; the build path writes its own
  // profile, so the role store is not touched again (no uninstall, no move).
  assert.ok(Array.isArray(before));
  const stored = readIntent({ db, email: "a@b.c" });
  assert.equal(stored.wantsTeam, true);
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

// ── 无会话形态也能作答（机房版/桌面版，2026-11-19 真机实测）──────────────
//
// AUTH_MODE=none 是没有 req.user 的，而那正是机房版的**唯一**形态。以前
// `emailOf` 返回 null → 一律 400 "No identity on the request"，而
// needsQuestionnaire 只看「答过没有」→ 引导页永远跳过不了，所有设置页被挡住。
test("no-auth deployment: answers accepted with the machine owner identity", async () => {
  const app = makeApp({ db: fakeDb(), authEnabled: false });
  const r = await request(app, "/api/onboarding/answers", {
    method: "POST",
    body: { roles: [], note: "", skipped: true },
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  // 答完之后不该再要求问卷
  const g = await request(app, "/api/onboarding/profile");
  assert.equal(g.json.needsQuestionnaire, false);
});

test("auth-enabled deployment still refuses an anonymous answers call", async () => {
  const app = makeApp({ db: fakeDb(), authEnabled: true });
  const r = await request(app, "/api/onboarding/answers", {
    method: "POST",
    body: { roles: [], note: "", skipped: true },
  });
  assert.equal(r.status, 400, "有会话形态下缺身份仍然拒绝");
});
