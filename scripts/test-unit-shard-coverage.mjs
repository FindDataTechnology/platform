#!/usr/bin/env node
// The shard split is only safe if it is also COMPLETE: a partition that
// quietly drops a file turns "the suite is green" into a lie that looks
// exactly like success. These assertions exist because that failure has no
// symptom — nothing errors, fewer tests just run.
//
// The contract pinned here:
//   · the file list is exactly `scripts/test-*.mjs` (the same glob test:unit
//     uses, so CI shards and the local suite can never drift apart);
//   · any shard count partitions it into disjoint, non-empty parts whose union
//     is the whole list;
//   · round-robin keeps shard sizes within one file of each other;
//   · the published-manifest check goes RED on a missing shard, a duplicated
//     file, and a file that no shard claimed.

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkArtifacts, declaresWorkspaceOnly, runnableFiles, shardFiles, unitFiles } from "./unit-shard.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the shard source of truth is the same glob test:unit runs", () => {
  const fromDisk = readdirSync(path.join(REPO, "scripts"))
    .filter((f) => f.startsWith("test-") && f.endsWith(".mjs"))
    .sort()
    .map((f) => `scripts/${f}`);
  assert.deepEqual(unitFiles(REPO), fromDisk);
  assert.ok(unitFiles(REPO).length > 400, `expected the whole suite, got ${unitFiles(REPO).length} files`);
  // `scripts/test-*.mjs` does not recurse: a test file in a subdirectory would
  // be silently excluded from both the suite and the shards.
  assert.ok(
    unitFiles(REPO).every((f) => path.dirname(f) === "scripts"),
    "unit files live directly under scripts/",
  );
});

test("every shard count 1..8 partitions the files exactly once", () => {
  const files = unitFiles(REPO);
  for (let count = 1; count <= 8; count += 1) {
    const shards = Array.from({ length: count }, (_, i) => shardFiles(files, i + 1, count));
    const flat = shards.flat();
    assert.equal(flat.length, files.length, `${count} shards: total files must match the suite`);
    assert.deepEqual([...flat].sort(), [...files].sort(), `${count} shards: union must equal the suite`);
    assert.equal(new Set(flat).size, files.length, `${count} shards: no file may appear twice`);
    for (const [i, s] of shards.entries()) {
      assert.ok(s.length > 0, `${count} shards: shard ${i + 1} is empty`);
    }
    const sizes = shards.map((s) => s.length);
    assert.ok(
      Math.max(...sizes) - Math.min(...sizes) <= 1,
      `${count} shards: sizes ${sizes.join("/")} drift by more than one file`,
    );
  }
});

test("a shard index outside 1..count is refused, not silently empty", () => {
  const files = unitFiles(REPO);
  assert.throws(() => shardFiles(files, 0, 4), /shard index must be 1\.\.4/);
  assert.throws(() => shardFiles(files, 5, 4), /shard index must be 1\.\.4/);
  assert.throws(() => shardFiles(files, 1, 0), /shard count must be >= 1/);
});

test("the CI wiring keeps one manifest per shard (unique filenames)", () => {
  // The coverage job downloads every artifact with `merge-multiple`, which
  // collapses same-named files in one directory. Eight artifacts each holding
  // `shard.json` therefore merge into ONE, and the gate then truthfully reports
  // "shard indexes are 7 but 8 shards were declared" — a real bug the first CI
  // run had, caused by the workflow rather than the split. Pin it statically so
  // it costs a unit test instead of a CI round trip.
  const yml = readFileSync(path.join(REPO, ".github/workflows/ci.yml"), "utf8");
  const manifestArgs = [...yml.matchAll(/--manifest\s+"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(manifestArgs.length > 0, "the unit job must write a manifest");
  for (const name of manifestArgs) {
    assert.match(name, /matrix\.shard/, `manifest filename ${name} must carry the shard number`);
  }
  assert.match(yml, /--check-artifacts\s+shards/, "the coverage job must run the union check");
  assert.match(yml, /merge-multiple:\s*true/, "the coverage job is expected to merge artifacts into one dir");
});

test("only files that DECLARE workspace-only are ever dropped", () => {
  // Dropping a file is how a lane quietly stops testing it. The rule: a file may
  // leave the shard list ONLY by carrying the marker in its own header, and the
  // difference must equal exactly the reported skip list.
  const all = unitFiles(REPO);
  const { files, skipped } = runnableFiles(REPO);
  const dropped = all.filter((f) => !files.includes(f)).sort();
  assert.deepEqual(dropped, [...skipped].sort(), "the drop list and the reported skips must be the same set");
  for (const f of skipped) {
    assert.ok(declaresWorkspaceOnly(REPO, f), `${f} was dropped but does not declare // workspace-only:`);
  }
});

test("the manifest check catches a dropped shard, a duplicate, and an unclaimed file", () => {
  const files = unitFiles(REPO);
  const dir = mkdtempSync(path.join(tmpdir(), "unit-shard-"));
  try {
    const write = (name, body) => writeFileSync(path.join(dir, name), JSON.stringify(body));
    const half = Math.ceil(files.length / 2);

    write("1.json", { index: 1, count: 2, files: files.slice(0, half) });
    write("2.json", { index: 2, count: 2, files: files.slice(half) });
    assert.deepEqual(checkArtifacts(dir, files), [], "a complete pair must pass");

    rmSync(path.join(dir, "2.json"));
    assert.ok(
      checkArtifacts(dir, files).some((p) => /shard indexes|ran on NO shard/.test(p)),
      "a missing shard must be named",
    );

    write("2.json", { index: 2, count: 2, files: [...files.slice(half), files[0]] });
    write("1.json", { index: 1, count: 2, files: files.slice(0, half) });
    assert.ok(
      checkArtifacts(dir, files).some((p) => /more than one shard/.test(p)),
      "a file claimed twice must be named",
    );

    write("2.json", { index: 2, count: 2, files: files.slice(half + 1) });
    assert.ok(
      checkArtifacts(dir, files).some((p) => /ran on NO shard/.test(p)),
      "a file no shard claimed must be named",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
