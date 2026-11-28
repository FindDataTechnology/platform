// Nav registry: the inbox entry (openspec: owner-inbox 6.1).
//
// The counts here are the ones the sidebar spec states (thirteen visible on the
// web, fourteen on the desktop shell). They are pinned because a nav count is
// the sort of thing that silently drifts when someone adds a surface "just for
// now" — and `sidebar-nav-families` promises exactly four families, so the new
// entry must be standalone.
//
// Run: node --test scripts/test-nav-inbox.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw err;
    }
  },
});

const { NAV_SURFACES, NAV_FAMILIES, FACTORY_PRESETS, FACTORY_PRESET_SLUG } = await import(
  "../packages/core/src/lib/surfaces.ts"
);

test("inbox is a nav surface, first in registry order, and not desktop-only", () => {
  const inbox = NAV_SURFACES.find((s) => s.slug === "inbox");
  assert.ok(inbox, "inbox is registered");
  assert.equal(inbox.container, "nav");
  assert.equal(inbox.testId, "nav-inbox");
  assert.equal(inbox.i18nKey, "nav.inbox");
  assert.equal(inbox.predicates, undefined, "plain web surface — no predicate");
  assert.equal(NAV_SURFACES[0].slug, "inbox", "it leads the registry");
});

test("inbox belongs to no family, and there are still exactly four", () => {
  assert.equal(NAV_FAMILIES.length, 4);
  for (const fam of NAV_FAMILIES) {
    assert.ok(!fam.slugs.includes("inbox"), `family ${fam.id} must not contain inbox`);
  }
});

test("factory preset: fourteen visible entries on web, fifteen with the desktop fleet", () => {
  const nav = FACTORY_PRESETS[FACTORY_PRESET_SLUG].nav;
  assert.ok(nav.includes("inbox"));
  assert.equal(nav.length, 15, "every registry slug except blueprints (flows joined run)");
  const browserNav = nav.filter((slug) => slug !== "fleet");
  assert.equal(browserNav.length, 14);
});

test("inbox renders ahead of chat in the factory preset order", () => {
  const nav = FACTORY_PRESETS[FACTORY_PRESET_SLUG].nav;
  assert.ok(nav.indexOf("inbox") < nav.indexOf("chat"));
});
