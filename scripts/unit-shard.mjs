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

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const UNIT_GLOB = "scripts/test-*.mjs";

/** The one definition of "the unit suite's file list" — same glob as test:unit. */
export function unitFiles(repo = REPO) {
  const dir = path.join(repo, "scripts");
  return readdirSync(dir)
    .filter((f) => f.startsWith("test-") && f.endsWith(".mjs"))
    .sort()
    .map((f) => `scripts/${f}`);
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

export function workspacePresent(repo = REPO) {
  return existsSync(path.join(repo, "..", "docs")) && existsSync(path.join(repo, "..", "openspec"));
}

export function declaresWorkspaceOnly(repo, file) {
  return WORKSPACE_MARK.test(readFileSync(path.join(repo, file), "utf8").slice(0, 4000));
}

/** unitFiles minus the workspace-only ones that cannot run here. */
export function runnableFiles(repo = REPO) {
  const all = unitFiles(repo);
  if (workspacePresent(repo)) return { files: all, skipped: [] };
  const skipped = all.filter((f) => declaresWorkspaceOnly(repo, f));
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
      `[unit-shard] 工作区不在场，跳过 ${skipped.length} 个工作区级验收文件（它们比较的是兄弟仓/仓外报告）：\n` +
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
    const res = spawnSync(
      process.execPath,
      ["--test", "--test-concurrency=1", "--test-timeout=180000", ...passthrough, ...mine],
      { cwd: REPO, stdio: "inherit" },
    );
    return res.status ?? 1;
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
