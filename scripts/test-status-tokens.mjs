#!/usr/bin/env node
// ── web-design-system status token tests (harden-web-design-foundation 1.2) ──
// Pins: the five-kind mapping exists and points at the semantic alias names
// declared in globals.css; unknown/absent states fail-open to neutral;
// asStatusKind maps the server's runtime words without inventing a sixth color.
//
//   node --test scripts/test-status-tokens.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { STATUS_TOKENS, STATUS_KINDS, statusToken, asStatusKind } from "../web/src/lib/statusTokens.ts";

const css = readFileSync(
  fileURLToPath(new URL("../web/src/styles/globals.css", import.meta.url)),
  "utf8"
);

test("five kinds map to the semantic alias tokens", () => {
  assert.deepEqual([...STATUS_KINDS].sort(), ["failed", "neutral", "paused", "running", "waiting"]);
  assert.equal(STATUS_TOKENS.running, "--color-status-running");
  assert.equal(STATUS_TOKENS.paused, "--color-status-paused");
  assert.equal(STATUS_TOKENS.failed, "--color-status-failed");
  assert.equal(STATUS_TOKENS.waiting, "--color-status-waiting");
});

test("every mapped token is declared in the theme", () => {
  for (const kind of STATUS_KINDS) {
    const name = STATUS_TOKENS[kind].replace("--color-", "");
    assert.ok(
      new RegExp(`--color-${name}:`).test(css),
      `${STATUS_TOKENS[kind]} missing from globals.css`
    );
  }
});

test("statusToken fail-opens to neutral for unknown input", () => {
  assert.equal(statusToken("running"), "--color-status-running");
  assert.equal(statusToken("bogus"), "--color-muted-foreground");
  assert.equal(statusToken(null), "--color-muted-foreground");
  assert.equal(statusToken(undefined), "--color-muted-foreground");
});

test("asStatusKind normalizes runtime words, never invents", () => {
  assert.equal(asStatusKind("streaming"), "running");
  assert.equal(asStatusKind("parked"), "paused");
  assert.equal(asStatusKind("failing"), "failed");
  assert.equal(asStatusKind("queued"), "waiting");
  assert.equal(asStatusKind("made-up-thing"), "neutral");
});
