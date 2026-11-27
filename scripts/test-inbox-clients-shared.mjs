#!/usr/bin/env node
// ── One inbox implementation, three clients (add-broadcast-and-notification-inbox 2.6) ─
//
// The task says web, mini-program and native must all see the same list "with
// no new page and no new request". That is a claim about the SOURCE, and it is
// cheap to check: every client must build its list with `itemsInBucket` from
// packages/core, and none may hand-roll the lane flattening.
//
// Why a test rather than a comment: found live 2026-11-24 — the mini-program
// carried its own copy of both the item TYPES and the flattening expression, so
// the lane-priority fix (notification first) applied to web and native and
// silently skipped the mini-program. A client that re-implements the read
// order drifts the moment the shared one changes.
//
//   node --test scripts/test-inbox-clients-shared.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

const CLIENTS = [
  { name: "web", file: "web/src/pages/InboxPage.tsx" },
  { name: "native", file: "app/src/app/(tabs)/inbox.tsx" },
  { name: "miniapp", file: "miniapp/src/pages/inbox/index.tsx" },
];

test("2.6 every client builds its list with the shared itemsInBucket", () => {
  for (const c of CLIENTS) {
    const src = readFileSync(path.join(ROOT, c.file), "utf8");
    assert.match(src, /from\s+["']@platform\/core["']/, `${c.name}: must import from @platform/core`);
    assert.match(src, /\bitemsInBucket\b/, `${c.name}: must use itemsInBucket`);
  }
});

test("2.6 no client hand-rolls the lane flattening", () => {
  // The exact expression that drifted in the mini-program.
  for (const c of CLIENTS) {
    const src = readFileSync(path.join(ROOT, c.file), "utf8");
    assert.doesNotMatch(
      src,
      /lanes\s*\.\s*flatMap\s*\(/,
      `${c.name}: re-implementing the flattening is how the lane order drifts — call itemsInBucket instead`,
    );
  }
});

test("2.6 no client keeps a private copy of the inbox item types", () => {
  // A local `interface InboxItem` is the other half of the same drift: the
  // shared ordering could change shape and a private type would keep compiling.
  for (const c of CLIENTS) {
    const src = readFileSync(path.join(ROOT, c.file), "utf8");
    assert.doesNotMatch(
      src,
      /interface\s+Inbox(Item|Lane|Payload)\b/,
      `${c.name}: import the types from @platform/core rather than redeclaring them`,
    );
  }
});
