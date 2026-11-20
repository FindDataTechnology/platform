#!/usr/bin/env node
// ── Facet fleet front-end contracts (facet-owns-its-fleets 3.1 / 4.1 / 4.2) ──
//
// Static assertions over the SPA sources, because each one is a promise that a
// runtime test in this repo would need a browser to prove:
//
//   3.1  TeamConsoleView reads the facet's OWN by-slug console endpoint — the
//        proxy path `/api/team-console` is gone (no cross-domain request).
//   4.1  StudioView's cast no longer auto-opens the run domain; `window.open`
//        survives only inside the explicit "open on platform" navigation.
//   4.2  The deployment deep link is reachable only through a user action.
//   4.3  App.tsx registers a signed-in "fleets" view + navigation entry.
//
// These are greps on purpose: a symbol-name assertion survives minification the
// way a runtime render check would not (and vice versa: pair with the e2e suite).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

test("3.1 TeamConsoleView points at the facet's own by-slug console, not the proxy", () => {
  const src = read("facet/web/src/TeamConsoleView.tsx");
  assert.equal(src.includes("/api/team-console"), false, "proxy path removed");
  assert.match(src, /\/api\/fleets\/by-slug\/\$\{encodeURIComponent\(slug\)\}\/console/, "direct endpoint");
});

test("4.1 StudioView does not auto-open the run domain on cast", () => {
  const src = read("facet/web/src/StudioView.tsx");
  // window.open must exist only inside handleNavigate (the explicit exit).
  const opens = src.match(/window\.open\(/g) ?? [];
  assert.equal(opens.length, 1, "exactly one window.open — the explicit platform exit");
  // The cast handler stays in-domain: it claims the action, no navigation.
  assert.match(src, /onDeployTeam=\{onCastHere\}/);
  // The deploy handoff URL appears only inside the click handler, never as an
  // automatic open at cast time.
  assert.equal(/window\.open\([^)]*deployCastPack/.test(src), false, "deployCastPack is not auto-opened");
});

test("4.2 the platform exit is an explicit control, not an automatic one", () => {
  const src = read("facet/web/src/StudioView.tsx");
  assert.match(src, /facet-cast-open-platform/, "a labelled control carries the exit");
  assert.match(src, /facet-cast-manage/, "the in-domain manage entry is primary");
});

test("4.3 App.tsx registers a signed-in fleets view and nav entry", () => {
  const src = read("facet/web/src/App.tsx");
  assert.match(src, /"fleets"/, "view id exists");
  assert.match(src, /user \? \["studio", "fleets"\]/, "fleets is a signed-in tab");
  assert.match(src, /<FleetsView \/>/, "the view mounts");
});

test("PLATFORM_INTERNAL_URL is absent from the whole fleet plane", () => {
  for (const rel of ["facet/fleets-db.js", "facet/fleets-routes.js", "facet/web/src/FleetsView.tsx", "facet/web/src/TeamConsoleView.tsx"]) {
    assert.equal(read(rel).includes("PLATFORM_INTERNAL_URL"), false, `${rel} must not reference the platform URL`);
  }
});
