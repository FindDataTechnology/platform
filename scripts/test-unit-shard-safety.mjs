#!/usr/bin/env node
// ── Why this suite must NOT use `--test-shard` ───────────────────────────────
//
// The unit suite is slow (~63 min on a cold 2-core runner, run 42630983629).
// The obvious fix is `node --test --test-shard=N/M`, and it LOOKS right: with
// two files, shard 1/2 ran only one file's cases. It is not right.
//
// Measured 2026-11-09 with four files and `--test-reporter=tap`: shard 1/2
// executed cases from THREE of them — `--test-shard` partitions the FLATTENED
// test list, not the file list. One file's cases therefore land on different
// runners and run CONCURRENTLY, which is exactly what `--test-concurrency=1`
// exists to prevent (within-file ordering is load-bearing: queue-health's
// "a record left queued on disk does not leak" only means anything because the
// earlier cases in that file ran first).
//
// This test pins the constraint so the next person who reaches for the flag
// finds the reason instead of a green CI that hides a lost invariant.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8"));

test("test:unit sets concurrency explicitly and bounds every case", () => {
  const script = pkg.scripts?.["test:unit"] ?? "";
  // 2026-11-15: `test:unit` now DELEGATES to scripts/unit-shard.mjs so the local
  // suite and the CI shards derive from one enumeration (the union of every
  // directory that holds tests). The flags therefore live in unit-shard's spawn
  // args, not in the package.json string — so read the effective command instead
  // of weakening the assertion. The invariant itself is unchanged.
  const effective = /unit-shard\.mjs/.test(script)
    ? `${script}\n${readFileSync(path.join(REPO, "scripts/unit-shard.mjs"), "utf8")}`
    : script;
  // Strip line comments BEFORE matching: unit-shard.mjs's header discusses
  // `--test-concurrency=1` in prose, so matching the raw text let the assertion
  // pass with the flag deleted from the actual spawn args (verified 2026-11-15 —
  // a gate reading its own rulebook and calling it green).
  const code = effective
    .split("\n")
    .map((line) => line.replace(/\s*\/\/.*$/, ""))
    .join("\n");
  // Concurrency must be EXPLICIT — either a literal or the env seam with a
  // numeric default — because node's default (os.availableParallelism()) would
  // silently oversubscribe a 2-core CI runner. Why the value is no longer pinned
  // to 1: measured 2026-11-10 on one tree, the whole suite (520 files) at
  // --test-concurrency=4 finished in 315s, and re-running its 14 failing files
  // SERIALLY reproduced all 27 of those failures — i.e. zero failures were
  // concurrency-induced. Serialization was a blanket safety choice, not a
  // measured requirement; keeping 1 as the DEFAULT still leaves it intact.
  //
  // Raising it by hand still needs no edit: unit-shard forwards everything after
  // a bare `--`, e.g. `npm run test:unit:shard -- 1 1 -- --test-concurrency=4`.
  const m = code.match(/--test-concurrency=(?:\$\{UNIT_TEST_CONCURRENCY(?::-|:=)?(\d+)\}|(\d+))/);
  assert.ok(
    m,
    "the effective test:unit command must pass --test-concurrency explicitly " +
      "(a literal, or the UNIT_TEST_CONCURRENCY env seam with a numeric default)",
  );
  const n = Number(m[1] ?? m[2]);
  assert.ok(Number.isInteger(n) && n >= 1, `--test-concurrency must be a positive integer, got ${m[0]}`);
  assert.match(code, /--test-timeout=\d+/, "a hanging case must fail by name, not eat the job budget");
});

test("test:unit does not use --test-shard (it partitions CASES, not files)", () => {
  const script = pkg.scripts?.["test:unit"] ?? "";
  assert.ok(
    !/--test-shard/.test(script),
    "`--test-shard` splits the flattened case list: one file's cases then run concurrently on " +
      "different runners, destroying the within-file ordering that makes several of these suites " +
      "deterministic. If this suite must be split, partition the FILE LIST (ls scripts/test-*.mjs) " +
      "and assert the union of executed files equals the full list — never rely on --test-shard.",
  );
});

// The coverage gate has two halves, and only one of them needs the artifact
// store. Measured 2026-11-14: the account's artifact storage was full (~575 MB
// against the 500 MB free cap), so every shard passed its tests and failed at
// `upload-artifact`, and the coverage job then died with "no shard manifests in
// shards". The split itself is still checkable — but a check whose red path has
// never fired is a guess, so the broken assignments below are built by hand.
test("checkSplit accepts an exact partition and rejects each way it can break", async () => {
  const { shardFiles, checkSplit } = await import("./unit-shard.mjs");
  const files = Array.from({ length: 11 }, (_, i) => `scripts/test-f${i}.mjs`);
  const split = (count) => Array.from({ length: count }, (_, i) => shardFiles(files, i + 1, count));

  // Sizes for 11 files in 4 shards are 3,3,3,2 — a spread of 1 is expected, not a defect.
  assert.deepEqual(checkSplit(split(4), files), [], "a round-robin split of the file list is exact");

  const dropped = split(4);
  dropped[3] = dropped[3].slice(1);
  assert.match(checkSplit(dropped, files).join(" "), /assigned to no shard/);

  const doubled = split(4);
  doubled[1] = [...doubled[1], files[0]];
  assert.match(checkSplit(doubled, files).join(" "), /assigned twice/);

  const lopsided = [files.slice(0, 1), files.slice(1)];
  assert.match(checkSplit(lopsided, files).join(" "), /shards differ by 9 file/);
});

// ── 一条挂住不能烧掉整片（2026-11-27 实撞）─────────────────────────────────
//
// shard 2 连续三次跑满 45 分钟被 cancel，日志停在某个文件的中途，谁也说不出
// 是哪个文件。现在 --run 逐文件 spawn 并给每个文件独立墙钟上限：挂住的文件
// 被杀掉、点名、其余文件照跑。这条测试在假仓上钉住该行为。
test("--run kills and names a hanging file, then keeps going", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const os = await import("node:os");
  const { execFileSync } = await import("node:child_process");
  const dir = mkdtempSync(path.join(os.tmpdir(), "ushard-safety-"));
  mkdirSync(path.join(dir, "scripts"));
  writeFileSync(path.join(dir, "scripts", "test-aaa-hang.mjs"), 'import { test } from "node:test";\ntest("h", () => new Promise(() => {}));\n');
  writeFileSync(path.join(dir, "scripts", "test-bbb-ok.mjs"), 'import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("ok", () => assert.equal(1, 1));\n');
  let out = "", code = 0;
  try {
    execFileSync(process.execPath, [path.join(REPO, "scripts", "unit-shard.mjs"), "--run", "--shard", "1/1"], {
      cwd: dir,
      env: { ...process.env, UNIT_SHARD_REPO: dir, UNIT_SHARD_FILE_TIMEOUT_MS: "3000", UNIT_SHARD_BUDGET_MS: "60000" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60000,
    });
  } catch (e) {
    code = e.status;
    out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  assert.equal(code, 1, "a timed-out file must fail the shard");
  assert.match(out, /超时（>3s，已杀掉）：scripts\/test-aaa-hang\.mjs/);
  assert.ok(out.includes("test-bbb-ok.mjs"), "the healthy file still runs after the hang is killed");
  assert.match(out, /TIMEOUT scripts\/test-aaa-hang\.mjs/);
});
