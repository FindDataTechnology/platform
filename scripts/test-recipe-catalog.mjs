// Recipe-catalog conformance (add-team-building-first-run 1.2 / 1.4).
//
// Two things this pins, both of which failed silently in production:
//   1. Every ready recipe's pack reference resolves against a REAL market
//      listing. The pre-2026-11-05 names (法律-合同 / 数据-股票 / 数据-中国经济)
//      matched nothing because resolution is an exact display-name compare, so
//      every new user's confirmation list read "unavailable" with no signal.
//   2. Resolution tolerates the `·`/whitespace half of a rename, and reports
//      WHICH listing it matched so a future drift is visible instead of silent.
//
// The market snapshot is the checked-in `site-plaza/generated/catalog.json`
// (the same artifact the plaza build consumes). It is a SNAPSHOT: a green run
// proves the recipes match this snapshot, not the live market — the live check
// is the provisioning回执 in the change's production verification task.
//
// Run: node --test scripts/test-recipe-catalog.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolvePackReferences, matchPackListing } from "../server/pack-manifest-source.js";
import { RECIPE_CATALOG, readyRoles } from "../packages/core/src/lib/recipes.ts";
import { buildPlan } from "../server/onboarding.js";

const CATALOG_PATH = new URL("../site-plaza/generated/catalog.json", import.meta.url);

// `site-plaza/` is EXCLUDED from the public snapshot (live market emails in its
// generated data; see make-public-snapshot.mjs's EXCLUDE list). A test whose
// only input is an excluded directory cannot judge anything in the snapshot or
// in a single-repo CI checkout — it reads as red noise that hides real drift.
// Missing fixture = cannot judge, said out loud; NOT a pass. (Same wording as
// test-blueprint-member-closure.mjs ⑦ and test-pack-pillars.mjs.)
const NO_SNAPSHOT = existsSync(CATALOG_PATH)
  ? false
  : "site-plaza/generated/catalog.json 不在本树（随站内快照排除出公开面）——判不出，不是通过";

// The market's own pack listings as the resolution path sees them: {id, name}
// with `name` the zh-CN display name (the authored reference alphabet).
function marketListings() {
  const doc = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
  return (doc.materials ?? [])
    .filter((m) => m?.category === "pack" && m?.id)
    .map((m) => ({ id: m.id, name: m?.human?.["zh-CN"]?.name ?? "" }))
    .filter((p) => p.name);
}

const market = marketListings();

function marketStub() {
  return {
    findByName: (ref) => market.filter((p) => p.name === ref),
  };
}

// ── 1.4 Each ready recipe resolves against the snapshot ─────────────────────

test("every ready recipe's pack reference resolves against the market snapshot", { skip: NO_SNAPSHOT }, async () => {
  const missing = [];
  for (const role of readyRoles()) {
    const recipe = RECIPE_CATALOG.recipes[role];
    assert.ok(recipe, `ready role '${role}' has no recipe`);
    assert.ok(Array.isArray(recipe.packs) && recipe.packs.length > 0, `recipe '${role}' declares no packs`);
    const resolved = await resolvePackReferences({
      refs: recipe.packs,
      viewer: { email: "test@example.com", groups: [] },
      localMarket: marketStub(),
    });
    for (const ref of recipe.packs) {
      if (!resolved[ref]?.packId) missing.push(`${role} → '${ref}'`);
    }
  }
  assert.deepEqual(missing, [], `recipe reference(s) match no market listing: ${missing.join(", ")}`);
});

test("a deliberately wrong reference fails loudly, naming the recipe", async () => {
  // Negative control: the assertion above can only be trusted if a bad ref
  // turns it red. Mirrors the real defect (a name that no listing carries).
  const resolved = await resolvePackReferences({
    refs: ["不存在的套件-xyz"],
    viewer: { email: "test@example.com", groups: [] },
    localMarket: marketStub(),
  });
  assert.equal(resolved["不存在的套件-xyz"], undefined);
});

// ── 1.2 Normalized retry + reported match ───────────────────────────────────

test("exact match is the primary path and carries the listing name", { skip: NO_SNAPSHOT }, async () => {
  const ref = "识律 · 合同审查套件";
  const resolved = await resolvePackReferences({
    refs: [ref],
    viewer: null,
    localMarket: marketStub(),
  });
  assert.equal(resolved[ref].name, ref);
  assert.equal(resolved[ref].ref, ref);
  assert.ok(resolved[ref].packId);
});

test("a renamed separator still resolves, and reports the matched listing", { skip: NO_SNAPSHOT }, async () => {
  // `·` dropped and spacing collapsed — the half of a rename the resolver
  // absorbs. The stub mirrors the PRODUCTION local market: it searches with
  // separators folded (server.js findByName) and returns every candidate, and
  // the normalization under test is matchPackListing's. The result must name
  // the LISTING, not echo the stale ref.
  const stale = "识律合同审查套件";
  const resolved = await resolvePackReferences({
    refs: [stale],
    viewer: null,
    localMarket: {
      findByName: (r) => market.filter((p) => matchPackListing(r, [p])),
    },
  });
  assert.equal(resolved[stale]?.name, "识律 · 合同审查套件");
  assert.equal(resolved[stale]?.ref, stale);
});

test("no match stays unresolved (never an empty success)", { skip: NO_SNAPSHOT }, async () => {
  const resolved = await resolvePackReferences({
    refs: ["柏讯 · 不存在的套件"],
    viewer: null,
    localMarket: { findByName: (r) => market.filter((p) => matchPackListing(r, [p])) },
  });
  assert.deepEqual(resolved, {});
});


// ── 1.3 The provisioning plan carries the matched name ──────────────────────

test("every ready recipe's plan is not degraded against the snapshot market", { skip: NO_SNAPSHOT }, async () => {
  // The surface renders `plan.packs[].name`. If a reference resolves, that name
  // is the LISTING's authored name; if it does not, the row reads "unavailable".
  // This is the assertion the old defect violated for all three roles.
  for (const role of readyRoles()) {
    const recipe = RECIPE_CATALOG.recipes[role];
    const resolvedRefs = await resolvePackReferences({
      refs: recipe.packs,
      viewer: { email: "test@example.com", groups: [] },
      localMarket: marketStub(),
    });
    const resolved = {};
    for (const [ref, hit] of Object.entries(resolvedRefs)) {
      resolved[ref] = { packId: hit.packId, name: hit.name };
    }
    const plan = buildPlan({ role, resolved });
    assert.equal(plan.degraded, false, `plan for '${role}' degraded: ${JSON.stringify(plan.packs)}`);
    for (const row of plan.packs) {
      assert.notEqual(row.status, "unavailable", `${role} → '${row.ref}' reads unavailable`);
      assert.ok(row.name, `${role} → '${row.ref}' carried no display name`);
    }
  }
});
