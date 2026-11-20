// Role landing (openspec: add-role-landing-board). The load-bearing contract is
// that the landing resolves MOST-SPECIFIC-WINS — the opposite of the visibility
// chain — and that it can never strand a user on a surface the same resolution
// removed. Plus the write-boundary half: a malformed landing rejects the whole
// preset rather than being dropped silently.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BOARD_LINES,
  FACTORY_LANDING,
  FACTORY_PRESETS,
  FACTORY_PRESET_SLUG,
  factoryPreset,
  resolveLanding,
  resolveLayout,
  validateLanding,
  validatePreset,
} from "../packages/core/src/lib/surfaces.ts";
import { RECIPE_CATALOG, recipeFor } from "../packages/core/src/lib/recipes.ts";

const SERVED = ["facet", "wanxing", "wire", "lex"];

// ── The value shape ─────────────────────────────────────────────────────────

test("validateLanding accepts a nav slug path and a served board line", () => {
  assert.deepEqual(validateLanding("/chat"), { ok: true, landing: "/chat" });
  assert.deepEqual(validateLanding("/fleets"), { ok: true, landing: "/fleets" });
  assert.deepEqual(validateLanding("/boards/lex"), { ok: true, landing: "/boards/lex" });
  assert.deepEqual(validateLanding("  /apps  "), { ok: true, landing: "/apps" });
});

test("validateLanding rejects every shape that could send the user elsewhere", () => {
  const bad = [
    "/boards/lex/x", // deeper than one board path
    "/boards", // no line
    "/boards/nonexistent", // unserved line
    "/boards/base", // the host is not a board
    "/nonexistent", // unknown nav slug
    "boats/lex", // no leading slash
    "https://lex.finddatatech.cloud", // absolute URL
    "//evil.example/x", // protocol-relative
    "/fleets?x=1", // query
    "/fleets#x", // hash
    "/a/b", // multi-segment nav path
    "", // empty
    "   ", // blank
    42, // non-string
    null,
  ];
  for (const value of bad) {
    assert.equal(validateLanding(value).ok, false, `expected reject: ${JSON.stringify(value)}`);
  }
});

// ── Write boundary: a bad landing kills the whole preset ────────────────────

test("a malformed landing rejects the entire preset, not just the field", () => {
  const v = validatePreset({ version: 1, nav: ["chat"], landing: "lex" });
  assert.equal(v.ok, false);
  assert.match(v.error, /landing/);
});

test("a valid landing rides through validatePreset unchanged", () => {
  const v = validatePreset({ version: 1, nav: ["chat", "fleets"], landing: "/boards/wire" });
  assert.equal(v.ok, true);
  assert.equal(v.preset.landing, "/boards/wire");
  // Absent means "this layer does not speak to it" and stays absent.
  assert.equal("landing" in validatePreset({ version: 1, nav: ["chat"] }).preset, false);
});

// ── Precedence: most specific wins ──────────────────────────────────────────

test("role landing beats the deployment default", () => {
  const r = resolveLayout(
    {
      deployment: { preset: factoryPreset(FACTORY_PRESET_SLUG), landing: "/apps" },
      role: { landing: "/boards/lex" },
    },
    { boardLines: SERVED },
  );
  assert.equal(r.landing, "/boards/lex");
});

test("deployment default applies when no role speaks", () => {
  const r = resolveLayout({ deployment: { preset: factoryPreset(FACTORY_PRESET_SLUG), landing: "/apps" } }, { boardLines: SERVED });
  assert.equal(r.landing, "/apps");
});

test("nothing declared anywhere lands on chat", () => {
  assert.equal(resolveLayout({}, {}).landing, FACTORY_LANDING);
  assert.equal(resolveLayout({}, {}).landing, "/chat");
});

test("the user layer outranks the role layer", () => {
  const r = resolveLayout(
    {
      deployment: { preset: factoryPreset(FACTORY_PRESET_SLUG) },
      role: { landing: "/boards/lex" },
      user: { preset: { version: 1, landing: "/memory" } },
    },
    { boardLines: SERVED },
  );
  assert.equal(r.landing, "/memory");
});

test("a landing is NOT narrowed — two layers do not intersect", () => {
  // The classic mistake this test pins: a visibility-style implementation would
  // try to keep only what both layers agree on, yielding "" or the wider one.
  const r = resolveLayout(
    {
      deployment: { preset: factoryPreset(FACTORY_PRESET_SLUG), landing: "/apps" },
      role: { landing: "/fleets" },
    },
    { boardLines: SERVED },
  );
  assert.equal(r.landing, "/fleets");
});

test("a preset's own landing is used when the layer declares none", () => {
  const r = resolveLayout({ deployment: { preset: { version: 1, landing: "/apps" } } }, {});
  assert.equal(r.landing, "/apps");
});

test("an explicit layer landing outranks the preset's own", () => {
  const r = resolveLayout(
    { deployment: { preset: { version: 1, landing: "/apps" }, landing: "/memory" } },
    {},
  );
  assert.equal(r.landing, "/memory");
});

// ── The guard: never strand the user ────────────────────────────────────────

test("a nav landing the same resolution hid falls back to chat", () => {
  // `simple` hides fleets; the role both narrows to `simple` and asks for /fleets.
  const r = resolveLayout(
    {
      deployment: { preset: factoryPreset(FACTORY_PRESET_SLUG) },
      role: { preset: factoryPreset("simple"), landing: "/fleets" },
    },
    { boardLines: SERVED },
  );
  assert.equal(r.nav.includes("fleets"), false);
  assert.equal(r.landing, "/chat");
});

test("deployment hiding disqualifies a landing", () => {
  const r = resolveLayout(
    {
      deployment: { preset: factoryPreset(FACTORY_PRESET_SLUG), hidden: ["apps"], landing: "/apps" },
    },
    {},
  );
  assert.equal(r.landing, "/chat");
});

test("a board landing survives only on a SERVED board", () => {
  const layers = { role: { landing: "/boards/wire" } };
  // Boards switch ON: wire is served.
  assert.equal(resolveLanding(layers, { nav: ["chat"] }, { boardLines: SERVED }), "/boards/wire");
  // Boards switch OFF: the deployment serves nothing, so the landing is off too.
  assert.equal(resolveLanding(layers, { nav: ["chat"] }, { boardLines: [] }), "/chat");
  // A line that is not served here.
  assert.equal(resolveLanding(layers, { nav: ["chat"] }, { boardLines: ["lex"] }), "/chat");
});

// ── Admin exemption ─────────────────────────────────────────────────────────

test("administrators ignore role landings but still honour the deployment default", () => {
  const layers = {
    deployment: { preset: factoryPreset(FACTORY_PRESET_SLUG), landing: "/apps" },
    role: { landing: "/boards/lex" },
  };
  const admin = resolveLayout(layers, { authOn: true, isAdmin: true, boardLines: SERVED });
  assert.equal(admin.landing, "/apps", "an admin's role landing must not hijack their first screen");

  const user = resolveLayout(layers, { authOn: true, isAdmin: false, boardLines: SERVED });
  assert.equal(user.landing, "/boards/lex");
});

test("an admin with only a role landing lands on chat", () => {
  const r = resolveLayout({ role: { landing: "/boards/lex" } }, { authOn: true, isAdmin: true, boardLines: SERVED });
  assert.equal(r.landing, "/chat");
});

// ── Factory + recipe invariants ─────────────────────────────────────────────

test("neither factory preset declares a landing", () => {
  for (const [slug, preset] of Object.entries(FACTORY_PRESETS)) {
    assert.equal(preset.landing, undefined, `${slug} must not declare a landing (default-off)`)
  }
});

test("every ready recipe's landing validates, and stock/economic differ from legal", () => {
  for (const role of RECIPE_CATALOG.ready) {
    const landing = recipeFor(role)?.landing;
    if (!landing) continue;
    const v = validateLanding(landing);
    assert.equal(v.ok, true, `recipe '${role}' has an invalid landing: ${landing} (${v.error})`);
    const line = landing.slice(1).split("/")[1];
    assert.ok(BOARD_LINES.includes(line), `recipe '${role}' points at an unserved board line: ${line}`);
  }
  assert.equal(recipeFor("legal").landing, "/boards/lex");
  assert.equal(recipeFor("stock").landing, recipeFor("economic").landing);
  assert.notEqual(recipeFor("legal").landing, recipeFor("stock").landing);
});

test("the recipe landings actually reach a resolution", () => {
  const r = resolveLayout({ role: { landing: recipeFor("legal").landing } }, { boardLines: SERVED });
  assert.equal(r.landing, "/boards/lex");
});
