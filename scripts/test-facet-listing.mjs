#!/usr/bin/env node
// ── facet publish + capability listing (run-card-bridge 4.1) ────────────────
//
// The listing envelope is validated by @finddatatechnology/run-card, the one
// implementation. v1 is not rentable: present/price/settlement are refused.
// Run: node --test scripts/test-facet-listing.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { attachListing } from "../facet/cli/facet.js";

const manifest = () => ({ name: "lex-core", description: "x" });
const listing = (over = {}) => ({
  schema: "capability-listing/1",
  asset: { kind: "pack", id: "lex-core", version: "0.1.0" },
  satisfies: ["skill:legal-review"],
  fitness: { status: "unverified", evidence: [] },
  license_tier: "official",
  storage: "platform",
  price: null,
  settlement_subject: null,
  ...over,
});

test("a valid v1 listing is attached to the manifest", () => {
  const got = attachListing(manifest(), listing());
  assert.equal(got.listing.asset.id, "lex-core");
  assert.equal(got.name, "lex-core");
});

test("present fitness is refused (v1 does not claim verification)", () => {
  assert.throws(() => attachListing(manifest(), listing({ fitness: { status: "present", evidence: ["e"] } })), /unverified/);
});

test("a price is refused (v1 is not rentable)", () => {
  assert.throws(() => attachListing(manifest(), listing({ price: 1 })), /price/);
});

test("a settlement subject is refused", () => {
  assert.throws(() => attachListing(manifest(), listing({ settlement_subject: "acct" })), /settlement_subject/);
});

test("an invalid envelope is refused by the shared validator", () => {
  assert.throws(() => attachListing(manifest(), listing({ asset: { kind: "pack", id: "", version: "1" } })), /不合法/);
});
