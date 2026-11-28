#!/usr/bin/env node
// ── Does every snapshot skip switch a caller sets actually bind? ─────────────
//
// WHY THIS EXISTS (2026-11-15)
// ----------------------------
// `scripts/make-public-snapshot.mjs` grew three skip switches at three different times
// (line completeness, branch freshness, deployed-baseline lineage). The third one,
// `SNAPSHOT_SKIP_LINEAGE_CHECK`, is ONE WORD away from the first,
// `SNAPSHOT_SKIP_LINE_CHECK` — and both CI and a test kept setting the first while
// meaning the third. The lineage guard then ran on a runner with no kubeconfig, refused
// with exit 2 ("判不出不是通过"), and killed the `gates` job at 55 s on every run of
// 2026-11-15: lint, typecheck, locales and the web build never executed, and
// `unit (shard 7/8)` went red on the same cause.
//
// WHAT THIS CHECKS — AND WHAT IT CANNOT
// -------------------------------------
// Static: every `SNAPSHOT_SKIP_*` name a caller SETS must be a name the exporter READS.
// That catches typos and stale renames (a caller left holding a name nobody honours).
//
// It CANNOT catch the case above, and pretending otherwise would be the same mistake in
// a new place: both `…_LINE_CHECK` and `…_LINEAGE_CHECK` are read by the exporter, so
// "sets ⊆ reads" holds for a caller that meant the wrong one. Intent is not in the text.
// That half is pinned behaviourally instead — `scripts/test-snapshot-build-info.mjs`
// asserts the run prints `lineage   ⊘ 跳过：SNAPSHOT_SKIP_LINEAGE_CHECK=1`, so a caller
// that thinks it skipped the guard but did not cannot pass silently, and
// `make-public-snapshot.mjs` prints that line itself so a skipped guard never looks like
// a passing one.
//
//   node scripts/test-snapshot-skip-knobs.mjs           # check the tree
//   node scripts/test-snapshot-skip-knobs.mjs --self-test   # both arms, no disk reads
//
// Two guard rails borrowed from the gates this repo already trusts: a scan that found
// nothing is UNDETERMINED (not a pass), and every failure names both sides plus the fix.

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXPORTER = "scripts/make-public-snapshot.mjs";

// The exporter deletes itself from the tree it produces, so in the public snapshot (where
// CI also runs) there is no definition side to compare against and this gate must say so
// instead of dying on ENOENT. Same shape as test-snapshot-build-info.mjs — measured
// 2026-11-15 by exporting a tree and running this gate inside it: ENOENT on
// `dist-opensource/…/scripts/make-public-snapshot.mjs`.
const NO_EXPORTER = existsSync(join(REPO_ROOT, EXPORTER))
  ? false
  : "the snapshot exporter is not in this tree (it deletes itself from its own output) — nothing to bind to";

// The exporter is the definition side: names it mentions in prose/error text are not
// "set sites", and scanning it for sets would make this gate compare a file with itself.
const SET_SITE_SOURCES = [
  { dir: ".github/workflows", pattern: /^\s*(SNAPSHOT_[A-Z_]+):/ },
  { dir: "scripts", pattern: /(SNAPSHOT_[A-Z_]+)\s*:\s*["']/ },
];

const READ_PATTERN = /process\.env\.(SNAPSHOT_[A-Z_]+)/g;

export function readNames(exporterSource) {
  const names = new Set();
  for (const m of exporterSource.matchAll(READ_PATTERN)) names.add(m[1]);
  return names;
}

// `files` is [{ label, text }] — plain data, so the self-test can feed fixtures instead of
// mutating the tree (a gate whose red path requires editing ci.yml is a gate nobody runs).
export function setSites(files, pattern) {
  const sites = [];
  // Every match on a line, not the first one: `spawnSync(… env: {A: "1", B: "1"})` puts two
  // switches on one line, and reporting only the first would shrink the population — the
  // same "silently narrower set" failure this gate exists to catch (measured: the first
  // version missed `SNAPSHOT_SKIP_LINEAGE_CHECK` in test-snapshot-build-info.mjs:59 and
  // still printed a green summary over 3 of 4 sites).
  const all = new RegExp(pattern.source, "g");
  for (const { label, text } of files) {
    text.split("\n").forEach((line, i) => {
      for (const m of line.matchAll(all)) sites.push({ where: `${label}:${i + 1}`, name: m[1] });
    });
  }
  return sites;
}

export function judge(readSet, sites) {
  const problems = [];
  // Non-vacuity: "scanned nothing" is undetermined, never agreement. Same rule the e2e
  // budget gate and the lineage gate already follow. The threshold is 3 because the tree
  // is known to carry two switches in ci.yml plus two in the exporter test — a scan that
  // finds fewer than that has lost population (it lost one of these pairs once already).
  if (readSet.size === 0) problems.push("读集为空：一个 process.env.SNAPSHOT_* 都没解析到（脚本被改名或读法变了）");
  if (sites.length < 3)
    problems.push(`设点只有 ${sites.length} 处（已知至少 4 处：ci.yml 两个 + 导出器测试两个）—— 扫丢人口同样是判不出`);
  for (const site of sites) {
    if (!readSet.has(site.name)) {
      problems.push(
        `${site.where} 设了 ${site.name} —— 导出器不读这个名字\n` +
          `    脚本读的是：${[...readSet].sort().join(", ") || "(空)"}\n` +
          `    处置：改设脚本读的那个名字；或给导出器加这个开关（一个没人认的开关仍然是开关的样子）`,
      );
    }
  }
  return problems;
}

function loadSetSources() {
  const files = [];
  for (const { dir, pattern } of SET_SITE_SOURCES) {
    const abs = join(REPO_ROOT, dir);
    let entries = [];
    try {
      entries = readdirSync(abs).filter((f) => (dir.endsWith("workflows") ? f.endsWith(".yml") : f.endsWith(".mjs")));
    } catch {
      continue; // missing dir ⇒ the non-vacuity rule below reports it
    }
    for (const f of entries) {
      if (dir === "scripts" && f === "make-public-snapshot.mjs") continue;
      files.push({ label: relative(REPO_ROOT, join(abs, f)), text: readFileSync(join(abs, f), "utf8"), pattern });
    }
  }
  // Group by pattern so each file is scanned with the conventions of its own directory.
  return files;
}

test("every SNAPSHOT_SKIP_* a caller sets is one the exporter reads", { skip: NO_EXPORTER }, () => {
  const exporter = readFileSync(join(REPO_ROOT, EXPORTER), "utf8");
  const readSet = readNames(exporter);

  const workflowPattern = SET_SITE_SOURCES[0].pattern;
  const scriptPattern = SET_SITE_SOURCES[1].pattern;
  const all = loadSetSources();
  const sites = [
    ...setSites(
      all.filter((f) => f.label.includes(".github/workflows")),
      workflowPattern,
    ),
    ...setSites(
      all.filter((f) => !f.label.includes(".github/workflows")),
      scriptPattern,
    ),
  ];

  // The mapping is printed on success too: the next reader should not have to grep three
  // files to learn which switch belongs to which guard.
  console.log("快照跳过开关：导出器读的名字");
  for (const n of [...readSet].sort()) console.log(`  · ${n}`);
  console.log("调用方设的位置");
  for (const s of sites) console.log(`  · ${s.where}  ${s.name}`);

  const problems = judge(readSet, sites);
  assert.deepEqual(problems, [], `跳过开关的绑定不成立：\n${problems.map((p) => `  ✗ ${p}`).join("\n")}`);
  console.log(`✓ ${sites.length} 处设点全部落在导出器读取的 ${readSet.size} 个名字之内`);
});

test("--self-test: both arms, no disk dependency", () => {
  const readSet = readNames("if (!process.env.SNAPSHOT_SKIP_LINE_CHECK) {}\nif (!process.env.SNAPSHOT_SKIP_LINEAGE_CHECK) {}");
  assert.equal(readSet.size, 2);

  // Green arm: callers set exactly what the exporter reads (3 sites — the non-vacuity
  // floor is 3, so a two-site fixture would be red for the wrong reason).
  const okSites = [
    { where: "wf.yml:1", name: "SNAPSHOT_SKIP_LINE_CHECK" },
    { where: "wf.yml:2", name: "SNAPSHOT_SKIP_LINEAGE_CHECK" },
    { where: "t.mjs:3", name: "SNAPSHOT_SKIP_LINE_CHECK" },
  ];
  assert.deepEqual(judge(readSet, okSites), []);

  // Red arm A — the typo/rename shape: a name one plural away from a real one binds to
  // nothing. This is the class the static check CAN see.
  const typoSites = [...okSites, { where: "wf.yml:9", name: "SNAPSHOT_SKIP_LINEAGE_CHECKS" }];
  const typoProblems = judge(readSet, typoSites);
  assert.equal(typoProblems.length, 1);
  assert.match(typoProblems[0], /wf\.yml:9 设了 SNAPSHOT_SKIP_LINEAGE_CHECKS/);
  assert.match(typoProblems[0], /脚本读的是：SNAPSHOT_SKIP_LINEAGE_CHECK, SNAPSHOT_SKIP_LINE_CHECK/);

  // Red arm B — non-vacuity. A scan that saw nothing must not read as agreement.
  assert.match(judge(new Set(), okSites).join("\n"), /读集为空/);
  assert.match(judge(readSet, []).join("\n"), /设点只有 0 处/);

  // Documented blind spot, pinned as a test so nobody mistakes this gate for more than it
  // is: setting the *wrong but valid* switch passes (that is the 2026-11-15 defect, caught
  // behaviourally by test-snapshot-build-info.mjs instead).
  assert.deepEqual(judge(readSet, [{ where: "wf.yml:1", name: "SNAPSHOT_SKIP_LINE_CHECK" }]).filter((p) => !/设点只有/.test(p)), []);
});
