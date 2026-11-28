#!/usr/bin/env node
// ── Official agent gallery tests (add-official-agent-gallery) ────────────────
//
// Pins the gallery's structural contract (behavior rides e2e/walkthrough):
//   1. the gallery is a PRESENTATION-LAYER upgrade of the official filter —
//      the same list data, zero new endpoints, zero new server code
//   2. cards render the summary projection only: the shared spec sheet in
//      COMPACT density with counts from the list row — the gallery never
//      fetches full manifests (anonymous discipline: render what the read
//      face gives, fetch nothing beyond it)
//   3. the starter sequence rides the EXISTING client constant (no second
//      truth) and the EXISTING five-locale role labels
//   4. the fork affordance is the SAME deep link (cross-origin on facet)
//   5. the plain list path is untouched when the official filter is off
//
//   node --test scripts/test-official-agent-gallery.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

const view = read("web/src/components/packs/PackMarketView.tsx");
// The gallery branch region — anchored on its own comment, not on the
// `officialOnly ? (` ternary (which first matches the filter chip's class).
const gallery = view.slice(
  view.indexOf("官方 gallery (add-official-agent-gallery)"),
  view.indexOf("pack-card-${pack.id}"),  // the else arm — inner ternaries excluded
);

test("gallery = presentation upgrade of the official filter (zero endpoints)", () => {
  assert.match(view, /officialOnly \? \(/, "the official filter switches the card rendering");
  assert.match(view, /pack-gallery-title/, "a gallery heading renders when the filter is on");
  // No new data surface: the gallery branch adds no fetch of its own.
  assert.ok(!/fetch\(/.test(gallery), "gallery cards fetch nothing — they render the list row");
});

test("cards render the summary projection via the shared sheet (compact)", () => {
  assert.match(gallery, /<AgentSpecSheet/, "cards consume the SHARED sheet");
  assert.match(gallery, /variant="compact"/, "compact density — summary projection only");
  assert.match(gallery, /personaPresent=\{\(pack\.agentCount \?\? 0\) > 0\}/, "counts come from the list row");
  // Anonymous discipline: the gallery branch must not request manifests.
  assert.ok(!/\/api\/packs\/\$/.test(gallery), "no per-card manifest fetch");
});

test("starter sequence = existing client constant + existing role labels", () => {
  assert.match(view, /STARTER_TEAMS\.find\(\(st\) => st\.packId === pack\.id\)/, "markers derive from STARTER_TEAMS");
  assert.match(view, /help\.start\.starterRole\.\$\{starter\.role\}/, "role labels reuse the help-center keys (five locales, parity-gated)");
  assert.match(view, /pack-gallery-starter-\$\{pack\.id\}/, "starter marker testid");
});

test("fork affordance is the same deep link, cross-origin on facet", () => {
  assert.match(gallery, /\/studio\?fork=\$\{encodeURIComponent\(pack\.id\)\}/);
  assert.match(gallery, /studioOrigin \?\? ""/, "relative on 壹座; facet passes the origin");
  assert.match(gallery, /stopPropagation/, "fork does not trigger the card's detail open");
});

test("the plain list path is untouched when the official filter is off", () => {
  assert.match(view, /pack-card-\$\{pack\.id\}/, "the original card remains the else arm");
  assert.match(view, /pack-featured-rail/, "the featured rail is untouched");
});

test("i18n: gallery heading exists in all five locales", () => {
  for (const loc of ["zh-CN", "en", "ja", "fr", "es"]) {
    const d = JSON.parse(read(`web/src/locales/${loc}/common.json`));
    assert.ok(typeof d.packs?.market?.galleryTitle === "string" && d.packs.market.galleryTitle.length > 0, `${loc}: galleryTitle`);
    assert.ok(d.help?.start?.starterRole?.preferred, `${loc}: starterRole labels present`);
  }
});
