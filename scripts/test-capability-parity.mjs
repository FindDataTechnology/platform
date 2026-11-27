// Capability advertisement must agree across BOTH entrypoints
// (openspec: owner-inbox).
//
// Why this test exists: every client (web, mini program, Expo app) reads
// capabilities from the GATEWAY's /api/config — that is the config an
// unauthenticated client gets, before any cell exists. The cell has its own
// /api/config too. Announcing a capability on one and not the other is exactly
// the multi-manifest trap that made `facet` "the fifth manifest" — the feature
// then looks absent on every hosted deployment while every per-cell unit test
// stays green.
//
// Pinned by reading both sources: if someone adds a capability to one file,
// this fails until they add it to the other.
//
// Run: node --test scripts/test-capability-parity.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const GATEWAY = new URL("../gateway/index.js", import.meta.url);
const CELL = new URL("../server/routes/misc.js", import.meta.url);

/** Pull the `capabilities: { ... }` literal out of a source file. */
function capabilitiesIn(path) {
  const src = readFileSync(path, "utf8");
  const m = src.match(/capabilities:\s*\{([^}]*)\}/);
  assert.ok(m, `no capabilities literal found in ${path.pathname}`);
  const keys = {};
  for (const part of m[1].split(",")) {
    const kv = part.split(":");
    if (kv.length !== 2) continue;
    const key = kv[0].trim();
    if (!/^[A-Za-z_$][\w$]*$/.test(key)) continue;
    keys[key] = kv[1].trim();
  }
  return keys;
}

test("gateway and cell advertise the same capability keys", () => {
  const gw = capabilitiesIn(GATEWAY);
  const cell = capabilitiesIn(CELL);
  assert.deepEqual(
    Object.keys(gw).sort(),
    Object.keys(cell).sort(),
    `capability keys diverge — gateway: ${JSON.stringify(Object.keys(gw))} ` +
      `cell: ${JSON.stringify(Object.keys(cell))}. A capability must be announced on BOTH ` +
      `entrypoints or clients on a hosted deployment never see it.`,
  );
});

test("ownerInbox is announced on both entrypoints", () => {
  assert.equal(capabilitiesIn(GATEWAY).ownerInbox, "true", "gateway must announce ownerInbox");
  assert.equal(capabilitiesIn(CELL).ownerInbox, "true", "cell must announce ownerInbox");
});

// add-ai-native-meeting 3.2 (2026-11-24): the SAME trap, one level up. The web
// fetches /api/config once at boot (main.tsx), before any session, so the
// gateway's anonymous answer is the only one the meeting route gate sees. The
// field had been added to the cell alone: on the hosted deployment
// config.meeting stayed null, App.tsx never registered /meetings/:id, and a
// fully-deployed feature was a dead click — with every per-cell test green.
test("meeting is announced on both entrypoints", () => {
  for (const [name, path] of [["gateway", GATEWAY], ["cell", CELL]]) {
    const src = readFileSync(path, "utf8");
    assert.match(src, /meeting:\s*meetingCapability\(\)/, `${name} must announce the meeting capability`);
  }
});
