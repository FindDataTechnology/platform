#!/usr/bin/env node
// ── facet publish dry-run (run-card-bridge 5.1 local proof) ─────────────────
//
// Exercises the real publish assembly — read manifest, read listing, validate,
// attach, stop — without pairing or a network call.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { publishRun } from "../facet/cli/facet.js";

function fixture(listingOver = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "facet-publish-"));
  const manifest = path.join(dir, "manifest.json");
  const listing = path.join(dir, "listing.json");
  writeFileSync(manifest, JSON.stringify({ name: "lex-core", description: "x" }));
  writeFileSync(listing, JSON.stringify({
    schema: "capability-listing/1",
    asset: { kind: "pack", id: "lex-core", version: "0.1.0" },
    satisfies: ["skill:legal-review"],
    fitness: { status: "unverified", evidence: [] },
    license_tier: "official",
    storage: "platform",
    price: null,
    settlement_subject: null,
    ...listingOver,
  }));
  return { manifest, listing };
}

async function capture(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines.join("\n");
}

test("dry-run attaches the listing and stops before the network", async () => {
  const { manifest, listing } = fixture();
  const out = await capture(() => publishRun({ packRef: manifest, listingFile: listing, dryRun: true, market: "http://127.0.0.1:1" }));
  assert.match(out, /dry-run/);
  assert.match(out, /capability-listing\/1/);
  assert.match(out, /"status": "unverified"/);
});

test("a rentable listing is refused before any network call", async () => {
  const { manifest, listing } = fixture({ price: 9 });
  // 这条也必须走 capture：publishRun 在校验 price 之前就打了「载荷：本地清单」，
  // 不兜住它会直接落到 stdout。node 25 的 test runner 把子进程 stdout 当 IPC
  // 数据反序列化，混进一行中文就整个文件报
  // "Unable to deserialize cloned data due to invalid or unsupported version"。
  await assert.rejects(
    () => capture(() => publishRun({ packRef: manifest, listingFile: listing, dryRun: true, market: "http://127.0.0.1:1" })),
    /price/,
  );
});
