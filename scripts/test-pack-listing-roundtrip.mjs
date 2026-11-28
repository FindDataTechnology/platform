#!/usr/bin/env node
// ── Listing survives the pack registry (run-card-bridge 5.1 server half) ────
//
// The listing is a segment on the manifest. The server stores the manifest
// verbatim and the detail read returns it, so no schema change is needed —
// this pins that, including across a reopen.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createPackRegistry } from "../gateway/packs.js";

const listing = () => ({
  schema: "capability-listing/1",
  asset: { kind: "pack", id: "lex-core", version: "0.1.0" },
  satisfies: ["skill:legal-review"],
  fitness: { status: "unverified", evidence: [] },
  license_tier: "official",
  storage: "platform",
  price: null,
  settlement_subject: null,
});

test("a published listing is readable from the version manifest, and after reopen", () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "pack-listing-")), "packs.db");
  const first = createPackRegistry({ file });
  const { id, version } = first.publish({
    email: "author@example.com",
    manifest: { name: "lex-core", description: "x", listing: listing() },
  });
  assert.deepEqual(first.getVersion(id, version).manifest.listing, listing());

  const second = createPackRegistry({ file });
  assert.deepEqual(second.getVersion(id, version).manifest.listing, listing());
});
