#!/usr/bin/env node
// ── Partition the unit suite by FILE LIST ───────────────────────────────────
//
// Why this exists: the unit suite is ~63 min on a cold 2-core runner, and it is
// the gate's throughput ceiling (openspec: slim-unit-suite-runtime). The one
// lever nobody had pulled is `--test-concurrency=1`'s SCOPE: it serialises
// every file to protect a handful of files that share global state. Separate
// machines are not that hazard — they are separate processes AND separate
// filesystems — so splitting the FILE LIST across runners keeps the invariant
// (each file still runs alone, in order) while cutting wall clock ~N×.
//
// It must never be `--test-shard`: that flag partitions the FLATTENED CASE
// list, so one file's cases land on different runners and run concurrently.
// scripts/test-unit-shard-safety.mjs measured it and pins the ban.
//
// Usage
//   node scripts/unit-shard.mjs --list                 # every file, one per line
//   node scripts/unit-shard.mjs --shard 3/8            # this shard's files
//   node scripts/unit-shard.mjs --shard 3/8 --manifest /tmp/shard.json
//   node scripts/unit-shard.mjs --check-artifacts /tmp/shards
//   node scripts/unit-shard.mjs --run --shard 3/8      # exec node --test on it
//
// `--run` is what a developer uses instead of the full suite:
//   npm run test:unit:shard -- 3 8
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 可被测试指向一座临时仓（--run 的逐文件超时/预算行为要能在假仓上验）。
const REPO = process.env.UNIT_SHARD_REPO
  ? path.resolve(process.env.UNIT_SHARD_REPO)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const UNIT_GLOB = "scripts/test-*.mjs";

/**
 * The one definition of "the unit suite's file list". As of 2026-11-15 it is a
 * UNION, not the old single glob: an audit that day found directories of tests
 * no lane ran — `lib/*.test.js` (129 tests, all green), `agent-runner/test/`
 * (37, all green), `test/*.test.mjs` (84 after two repairs). The old glob
 * answered "which files does the runner take" with "whatever scripts/ happens
 * to hold", so a test written anywhere else was born orphaned:
 * `test/supply-instance-report.test.mjs` was authored against vitest (which the
 * repo does not declare) and had never executed once;
 * `test/memory-dashboard.test.mjs` had rotted after a page import changed and
 * nobody could know. New directories must join this union (or their files must
 * carry the lane-skip marker below); a NEW FILE in a listed directory joins
 * automatically — that direction is the whole point.
 */
export const UNIT_DIRS = [
  { dir: "scripts", test: (f) => f.startsWith("test-") && f.endsWith(".mjs") },
  { dir: "lib", test: (f) => f.endsWith(".test.js") },
  { dir: "test", test: (f) => f.endsWith(".test.mjs") },
  { dir: "agent-runner/test", test: (f) => f.endsWith(".test.mjs") },
  // `server/` was missing until 2026-11-25, so `grant-verify.test.js` and
  // `routes/erp-shop-proxy.test.js` were authored, committed and NEVER RUN by
  // CI — the coverage gate only failed because it scans for exactly this, and
  // because nobody had published a snapshot since they landed. Both pass
  // (17/17 serial); they simply had no lane.
  { dir: "server", test: (f) => f.endsWith(".test.js") },
  { dir: "server/routes", test: (f) => f.endsWith(".test.js") },
];

export function unitFiles(repo = REPO) {
  const out = [];
  for (const { dir, test } of UNIT_DIRS) {
    const base = path.join(repo, dir);
    if (!existsSync(base)) continue; // e.g. a snapshot crop that dropped the dir
    for (const f of readdirSync(base)) if (test(f)) out.push(`${dir}/${f}`);
  }
  return out.sort();
}

/**
 * Some suites are WORKSPACE acceptance tests, not repo tests: they compare this
 * repo against a sibling that only exists in the authoring workspace (fd-wire's
 * `docs/` and `openspec/`, an out-of-repo `reports/`). In a single-repo CI
 * checkout they cannot resolve — and a red there says nothing about the code
 * they claim to check.
 *
 * They declare it in their first lines:
 *   // workspace-only: needs finddata/{docs,openspec,reports}
 *
 * When the workspace is absent those files are dropped from the shard list AND
 * named in the log, so "fewer tests ran" is never silent. When it IS present
 * they run exactly as before.
 */
const WORKSPACE_MARK = /^\s*\/\/\s*workspace-only:/m;

/**
 * A test that cannot run under `node --test` must SAY so, in its first lines:
 *   // lane-skip: <why> (e.g. needs a browser, needs a paid API key)
 * The skip is printed every run, so "fewer tests ran" is never silent — and a
 * file WITHOUT a marker that cannot run makes the lane red, which is the point:
 * silence is how `supply-instance-report.test.mjs` sat unexecuted for weeks.
 */
const LANE_SKIP_MARK = /^\s*\/\/\s*lane-skip:/m;

export function workspacePresent(repo = REPO) {
  return existsSync(path.join(repo, "..", "docs")) && existsSync(path.join(repo, "..", "openspec"));
}

export function declaresWorkspaceOnly(repo, file) {
  return WORKSPACE_MARK.test(readFileSync(path.join(repo, file), "utf8").slice(0, 4000));
}

export function declaresLaneSkip(repo, file) {
  return LANE_SKIP_MARK.test(readFileSync(path.join(repo, file), "utf8").slice(0, 4000));
}

/** unitFiles minus the ones that cannot run here, each kind of skip named. */
export function runnableFiles(repo = REPO) {
  const all = unitFiles(repo);
  const skipped = all.filter(
    (f) => (declaresLaneSkip(repo, f) || (!workspacePresent(repo) && declaresWorkspaceOnly(repo, f))),
  );
  return { files: all.filter((f) => !skipped.includes(f)), skipped };
}

/** Round-robin by sorted position, not contiguous blocks: slow files are
 * spread out (they cluster by topic, and topics cluster alphabetically), and
 * shard sizes stay within one file of each other.
 */
export function shardFiles(files, index, count) {
  if (!Number.isInteger(count) || count < 1) throw new Error(`shard count must be >= 1, got ${count}`);
  if (!Number.isInteger(index) || index < 1 || index > count) throw new Error(`shard index must be 1..${count}, got ${index}`);
  return files.filter((_, i) => i % count === index - 1);
}

function parseShard(spec) {
  const m = /^(\d+)\/(\d+)$/.exec(String(spec ?? ""));
  if (!m) throw new Error(`--shard wants <index>/<count> (e.g. 1/8), got ${JSON.stringify(spec)}`);
  return { index: Number(m[1]), count: Number(m[2]) };
}

/**
 * The split alone, with no artifacts: proves a shard assignment is an exact
 * partition of `files`. `checkArtifacts` proves something stronger (what each
 * runner actually OWNED), but it needs the manifests to survive the trip between
 * jobs — and they do not when the account's artifact storage is full (measured
 * 2026-11-14: ~575 MB against the free plan's 500 MB, so all eight shards were
 * green on tests and red on `upload-artifact`). This is the honest fallback: it
 * still says something true, and it needs no storage at all.
 *
 * Takes the assignment rather than computing it so a test can hand it a broken
 * one — a check whose red path is unreachable is a check nobody has verified.
 */
export function checkSplit(assigned, files) {
  const problems = [];
  const flat = assigned.flat();
  if (flat.length !== files.length) problems.push(`assigned ${flat.length} file(s), suite is ${files.length}`);
  const dupes = flat.filter((f, i) => flat.indexOf(f) !== i);
  if (dupes.length) problems.push(`assigned twice: ${[...new Set(dupes)].slice(0, 5).join(", ")}`);
  const unassigned = files.filter((f) => !flat.includes(f));
  if (unassigned.length) problems.push(`assigned to no shard: ${unassigned.slice(0, 5).join(", ")}`);
  const sizes = assigned.map((a) => a.length);
  const spread = sizes.length ? Math.max(...sizes) - Math.min(...sizes) : 0;
  if (spread > 1) problems.push(`shards differ by ${spread} file(s): ${sizes.join(",")}`);
  return problems;
}

/** Assert the published shard manifests together are exactly the suite. */
export function checkArtifacts(dir, files) {
  const manifests = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8")));
  const problems = [];
  if (manifests.length === 0) problems.push(`no shard manifests in ${dir}`);

  const counts = new Set(manifests.map((m) => m.count));
  if (counts.size > 1) problems.push(`shards disagree on count: ${[...counts].join(", ")}`);
  const count = manifests[0]?.count ?? 0;

  const seenIndexes = manifests.map((m) => m.index).sort((a, b) => a - b);
  const expectedIndexes = Array.from({ length: count }, (_, i) => i + 1);
  if (JSON.stringify(seenIndexes) !== JSON.stringify(expectedIndexes)) {
    problems.push(`shard indexes are ${seenIndexes.join(",")} but ${count} shards were declared`);
  }

  const flat = manifests.flatMap((m) => m.files);
  const dupes = flat.filter((f, i) => flat.indexOf(f) !== i);
  if (dupes.length) problems.push(`files claimed by more than one shard: ${[...new Set(dupes)].slice(0, 5).join(", ")}`);

  const ran = new Set(flat);
  const missing = files.filter((f) => !ran.has(f));
  const extra = flat.filter((f) => !files.includes(f));
  if (missing.length) problems.push(`${missing.length} suite file(s) ran on NO shard: ${missing.slice(0, 5).join(", ")}`);
  if (extra.length) problems.push(`${extra.length} file(s) ran that are not in the suite: ${extra.slice(0, 5).join(", ")}`);

  return problems;
}

function main(argv) {
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const suite = unitFiles();
  const { files, skipped } = runnableFiles();
  if (skipped.length) {
    console.error(
      `[unit-shard] 跳过 ${skipped.length} 个文件（workspace-only：仓外兄弟不在场；lane-skip：文件自己声明不能在本车道跑）——跳过必须逐个点名，不许静默：\n` +
        skipped.map((f) => `  · ${f}`).join("\n"),
    );
  }

  if (argv.includes("--check-artifacts")) {
    const problems = checkArtifacts(arg("--check-artifacts"), files);
    if (problems.length) {
      console.error(`[unit-shard] 分片并集不等于全集（${files.length} 个文件）：`);
      for (const p of problems) console.error(`  · ${p}`);
      process.exit(1);
    }
    console.log(
      `[unit-shard] ✓ 所有分片并集 == 本次可跑全集（${files.length} 个文件，无重复、无遗漏；套件共 ${suite.length} 个，跳过的 ${skipped.length} 个已在上面点名）`,
    );
    return 0;
  }

  if (argv.includes("--list")) {
    console.log(suite.join("\n"));
    return 0;
  }
  if (argv.includes("--list-runnable")) {
    console.log(files.join("\n"));
    return 0;
  }

  // The split alone, with no artifacts — see checkSplit() for why this exists.
  if (argv.includes("--check-split")) {
    const { count } = parseShard(`1/${arg("--check-split")}`);
    const assigned = Array.from({ length: count }, (_, i) => shardFiles(files, i + 1, count));
    const problems = checkSplit(assigned, files);
    if (problems.length) {
      console.error(`[unit-shard] 分片划分不是严格划分（${count} 片 / ${files.length} 个文件）：`);
      for (const p of problems) console.error(`  · ${p}`);
      return 1;
    }
    const sizes = assigned.map((a) => a.length);
    const spread = sizes.length ? Math.max(...sizes) - Math.min(...sizes) : 0;
    console.log(
      `[unit-shard] ✓ ${count} 片是 ${files.length} 个可跑文件的严格划分（无重复、无遗漏，最大差 ${spread} 个文件）`,
    );
    return 0;
  }

  const { index, count } = parseShard(arg("--shard"));
  const mine = shardFiles(files, index, count);

  const manifest = arg("--manifest");
  if (manifest) {
    mkdirSync(path.dirname(manifest), { recursive: true });
    writeFileSync(manifest, `${JSON.stringify({ shard: index, index, count, total: files.length, files: mine }, null, 2)}\n`);
  }

  if (argv.includes("--run")) {
    // Everything after a bare `--` is forwarded, so the caller can add
    // reporters or flags without this script growing a parser.
    const sep = argv.indexOf("--");
    const passthrough = sep === -1 ? [] : argv.slice(sep + 1);
    console.error(
      `[unit-shard] 分片 ${index}/${count}：${mine.length}/${files.length} 个文件` +
        (mine.length === 0 ? "（该分片是空的——分片数超过了文件数？）" : ""),
    );

    // ── 逐文件跑，每个文件有独立的墙钟上限 ────────────────────────────────
    // 为什么不是一次 `node --test <全部文件>`：2026-11-27 实测 shard 2 连续三次
    // 烧掉整条 45 分钟 job——父进程在等一个永不退出的子进程，日志停在某个文件的
    // 中途，**没有任何一行说清是哪个文件**。一个挂住的文件不该让整片变成黑盒，
    // 也不该花掉整条 job 的预算。
    //
    // 逐文件 spawn 保持「每个文件单独跑、按顺序」这一不变量（比原来更严），
    // 代价是每文件多一次 node 启动（~50ms × 124 ≈ 6s）。
    const fileLimit = Number(process.env.UNIT_SHARD_FILE_TIMEOUT_MS || 180000);
    const budget = Number(process.env.UNIT_SHARD_BUDGET_MS || 1200000);
    const started = Date.now();
    const failed = [];
    const timedOut = [];
    const overBudget = [];
    for (const file of mine) {
      if (Date.now() - started > budget) {
        overBudget.push(file);
        continue;
      }
      console.error(`[unit-shard] ▶ ${file}`);
      // NODE_TEST_CONTEXT 会让被 spawn 的 node 以为自己是某个测试的子进程；
      // 从 `node --test` 里调用本脚本（自测）时它会污染退出码。
      const childEnv = { ...process.env };
      delete childEnv.NODE_TEST_CONTEXT;
      // Two-pass, because --test-force-exit is not free.
      //
      // It exists for the real leak: a file that finishes every case but keeps a
      // listener/timer open never exits, and the whole shard then runs to the
      // job timeout (measured 2026-11-25). But it also breaks files that are
      // fine: it ends the process the first moment the loop looks idle, and
      // node then reports the cases still queued behind the current turn as
      // `Promise resolution is still pending but the event loop has already
      // resolved` — 2026-11-27, test-fleet-memory lost its last two cases that
      // way while passing 7/7 without the flag.
      //
      // So: run plainly first. Only a file that fails to EXIT gets the flag,
      // and that retry is reported, because a green-with-force-exit is weaker
      // evidence than a green without it.
      const runOnce = (extraFlags) =>
        spawnSync(
          process.execPath,
          ["--test", "--test-concurrency=1", "--test-timeout=60000", ...extraFlags, ...passthrough, file],
          { cwd: REPO, env: childEnv, stdio: "inherit", timeout: fileLimit, killSignal: "SIGKILL" },
        );
      let res = runOnce([]);
      const neverExited = res.error?.code === "ETIMEDOUT" || (res.signal && res.status === null);
      if (neverExited) {
        console.error(`[unit-shard] ↻ ${file} 未自行退出（用例可能全绿但进程挂着）——加 --test-force-exit 重跑`);
        res = runOnce(["--test-force-exit"]);
      }
      const hitTimeout = res.error?.code === "ETIMEDOUT" || (res.signal && res.status === null);
      if (hitTimeout) {
        timedOut.push(file);
        console.error(`[unit-shard] ✖ 超时（>${Math.round(fileLimit / 1000)}s，已杀掉）：${file}`);
      } else if (res.status !== 0) {
        failed.push(file);
      }
    }
    if (timedOut.length || failed.length || overBudget.length) {
      console.error(
        `[unit-shard] 分片 ${index}/${count} 未全绿：失败 ${failed.length}，超时 ${timedOut.length}，预算跳过 ${overBudget.length}` +
          (overBudget.length ? `（整片预算 ${Math.round(budget / 1000)}s 用尽）` : ""),
      );
      for (const f of [...timedOut.map((f) => `TIMEOUT ${f}`), ...failed.map((f) => `FAIL ${f}`), ...overBudget.map((f) => `OVER-BUDGET ${f}`)]) {
        console.error(`  · ${f}`);
      }
      return 1;
    }
    console.error(`[unit-shard] ✓ 分片 ${index}/${count} 全绿（${mine.length} 个文件）`);
    return 0;
  }

  console.log(mine.join("\n"));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error(`[unit-shard] ${e.message}`);
    process.exit(2);
  }
}
