#!/usr/bin/env node
// ── E2E flake budget (2026-11-13) ────────────────────────────────────────────
//
// The fast e2e lane is a shared-session, load-sensitive suite. It is NOT
// deterministic: measured 2026-11-13 across four full runs (two CI, two local),
// every run ended with 5-6 reds and no two runs agreed on WHICH ones —
// pack-usage / copilot-dock / onboarding / delegation / session-open /
// registry-connect / plugins-supply / websearch all took turns, and every one of
// them passes when its file runs alone.
//
// 2026-11-14: focus-overlay and pack-agent-scoping left both the list AND the
// rotation above. Their red was not a flake at all — it was a preset roster that
// never reached the child (fix-catalog-preset-roster-convergence: restart
// colliding, no spawn budget, the restart window read as "no agent modes",
// declines eating the failure budget, a dropped initializeTimeoutMs, and no way
// to name who held the child).
//
// The last hole was outside that change and worth naming here because it decided
// a dozen reds: a DELEGATION turn whose prompt failed left its collector in
// `sessionCollectors` + `taskTurnRegistry` for the full 10-minute turn timeout,
// and both are inputs to `runtimeBusy()` — so the whole cell counted as busy and
// every deferred restart (MCP patch, credential, catalog roster) was blocked.
// Runs measured before/after that one catch-block fix, same tree, same suite:
// 9 red / 693 green / 33.9m (focus-overlay, pack-agent-scoping, onboarding and
// both session-solution tests inside the blackout) → 3 red / 715 green / 27.9m
// with every preset test green. `describeRuntimeBusy()` is what named it; keep
// that log line when trimming anything here.
//
// delegation.spec.js came OFF the list on the same evidence: it was the spec
// whose failed turn leaked, so its own second test waited behind the first one's
// stuck collector. After the release-on-failure fix: full lane 715/3 with both
// its tests green, then three consecutive runs of the whole blackout cluster
// (delegation + focus-overlay + onboarding + pack-agent-scoping +
// session-solution) at 29/29 — 4.8m, 4.8m, 5.9m. If it goes red again, read
// `describeRuntimeBusy()` first; the retry budgets are rarely the answer.
//
// The 3 left in run seven: auth-catalog ×2 (in this list) and
// resources-binding:265. Measured properly afterwards (six independent runs of
// the whole file, 2026-11-14): 4 green / 2 red — NOT load. The tick log this
// investigation added to `chart-refresh.js` says why: the timer runs, the
// freshness gate answers `skipped_fresh`, so the series is never re-read and the
// page's period count stays at the armed value. The gate asks `data_stats` for a
// fingerprint (`last_fetch|latest_date|rows`); the spec's fake changed the
// SERIES but not the STATS, so whether the test passed depended on whether an
// earlier test in the same file had already stored that fingerprint.
// Fixed test-side. The mechanism is worth remembering because it is a FIXTURE
// lying about the source, not a product defect:
//   - `e2e/fake-mcp.js` now derives `rows`/`latest_date` from the series it
//     serves (an explicit `stats` block still overrides, for a spec that needs a
//     lying source) — a real source's coverage moves when its data does;
//   - the spec appends the extra period AFTER the page is open and after its
//     `before` snapshot, so the assertion no longer depends on whether the
//     on-open read got there first;
//   - two further reds surfaced once the file ran deterministically, both
//     harness teardown races rather than page behaviour: a `route.fetch()`
//     response disposed when the page closed mid-flight, and `storedResource()`
//     sampling the store during the empty window of a list refetch. Both now
//     wait or yield instead of throwing.
// Result: 11 consecutive green whole-file runs (runs 8–18, 13–21 s each). The
// product-side alternative — force-read every N skips, so a lying `data_stats`
// cannot park a binding forever — stays open as its own change: a wrong
// `data_stats` from a real source is still unfalsifiable from inside a binding.
// voice:152 stays OUT of this list on purpose: it fails standalone (the speak
// button reads "playing" 10s after a 0.4s fixture) because this host's headless
// Chromium has no advancing audio clock — a real environment limit, documented
// at the assertion, not a flake to be blessed.
//
// A gate that is red every run carries no information: the red you must not
// ignore looks exactly like the five you must. So this step keeps the lane
// ENFORCED (the step above it is `continue-on-error`, and this step fails the
// job) but judges it against two signals instead of a binary:
//
//   1. a red in a spec file that is NOT on the known-flake list → instant fail.
//      A regression in an otherwise-green spec is exactly what the old binary
//      gate was for, and this keeps it.
//   2. more reds than FLAKE_BUDGET → fail. The measured band is 5-6; a real
//      regression on this suite shows up as a burst (one shared cause, many
//      specs), so 8 leaves room for the band and none for a burst.
//
// Usage: node scripts/check-e2e-budget.mjs <playwright-json-report>
// Exit 0 = within budget (names still printed). Exit 1 = regression.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Measured over five full runs on 2026-11-13: 4, 5, 6, 6, 8 reds. The band is
// wide because it tracks runner load, not the code. 10 keeps a little headroom
// above the observed maximum while staying far below what one shared cause
// produces on a 748-test suite (the case this backstop is for).
//
// The band and this gate are measured in CI's caliber: the job runs with
// `retries: CI ? 2 : 0` (playwright.config.js), so a red here has failed THREE
// times. A local run (retries 0) reports every first-attempt flake and therefore
// a higher number from the same tree — measured 2026-11-13: 6 locally, 3 in CI.
// Do not recalibrate the budget against a local run, and do not conclude "CI
// will go red" from a local count.
const FLAKE_BUDGET = 10;

// Spec files observed to fail under load and pass alone. Adding a file here is a
// decision to tolerate its reds; the count still has to stay inside the budget.
//
// Three files came OFF this list on 2026-11-13 (packs, registry-connect,
// websearch). They were not flakes: they were victims of a state leak, and the
// leak is now fixed at its source — the active agent preset is deployment-global
// and a pack-role focus narrows the MCP surface to three servers, so every file
// after packs.spec read a profile without websearch (see the e2e/helpers.js
// switchPreset comment). Evidence: two full local runs after the fix, 6 and 5
// reds, in both cases ZERO of the 137 spec files ended with a narrowed profile
// (it was 6/137), packs/registry-connect/websearch green in both, and the
// public CI run 43423955544 reddened only fleets / plugins-supply /
// session-navigation-streaming / session-open. If one of these three reds again,
// put it back AND read the leak first — the file that fails is usually not the
// file that caused it.
// Playwright reports `spec.file` relative to the configured testDir, i.e.
// "websearch.spec.js" — never "websearch.spec.js". Comparing repo-relative
// paths (the first version did) marks EVERY file as unknown, so the gate fails
// on a clean band and says nothing about regressions. Normalise to basenames.
const baseName = (file) => String(file ?? "").split("/").pop();

// Removed 2026-11-14 (fix-catalog-preset-roster-convergence 4.2): the roster
// these two waited 90s for now converges. Evidence — full fast lane 713 passed /
// 3 failed with both files GREEN (`/tmp/full-run-5.log`), and the narrowed pair
// `delegation + focus-overlay` 8/8 while the delegation turn was live. They go
// back on this list only with a fresh round of evidence, never as a default.
// Per-file history measured across the six consecutive GREEN CI runs of
// 2026-11-14 on ci/paas-lanes-1114 (retries=2, so a listed red already failed
// three times). Read the numbers as: "this file's own reds, counted from the
// gate's own output" — 43599124908 (3 reds), 43602008389 (1), 43607929997 (2),
// 43611482706 (1), 43618682527 (0, 719 passed), 43624475405 (2).
//
// The reason this table is here at all: on 2026-11-15 I annotated six of these
// entries with "5 consecutive full fast-lane runs green … zero failed attempts"
// and it was FALSE. Five of those six runs carried 1-3 reds. The mistake was
// reading "the e2e job is green" as "nothing failed", when this gate is a
// BUDGET: green means "inside it". A green job says nothing about which listed
// files ran clean — only this gate's own lines do, which is why it must print
// them on a red run too (it did not; `ledger()` sat inside the zero-red
// branch and stayed silent exactly when a red existed).
const KNOWN_FLAKY = new Set([
  "auth-catalog.spec.js", // spawns its own server; 12/12 three times standalone 2026-11-13; 0 reds in the six runs above
  "copilot-dock.spec.js", // 1 red (43599124908: market tab / facet line) — measured, not assumed
  "fleet-ops-canvas.spec.js", // canvas paint/embed frames: green 4× standalone 2026-11-13; 0 reds in the six runs above
  "fleets.spec.js", // already named as flaky in ci.yml ("session-open, fleets pass on retry"); 0 reds in the six runs above
  "plugins-supply.spec.js", // 2 reds of 6 (43599124908, 43624475405: "the three supply states render")
  "session-navigation-streaming.spec.js", // 3 reds of 6 (43599124908, 43607929997, 43611482706: "new chat leaves the live turn running")
  "session-open.spec.js", // 3 reds of 6 (43602008389, 43607929997, 43624475405: "switch to an unknown session")
  // 2026-11-23, measured both ways on the same commit: red on snapshot
  // 463668c22 ("publish: preview never writes…") and green on the next one
  // (881adfe05) with no code change in between — plus 9/9 green standalone
  // locally. That is a flake's shape, not a regression's.
  "team-directory.spec.js", // red 463668c22 / green 881adfe05, same code; 9/9 standalone 2026-11-23
]);

// Dropped on the same measurement, because a listed file that never reddens is
// not a tolerance any more — it is a blind spot: a real regression there would
// be tolerated silently. `onboarding` and `pack-usage` were on this list for
// pre-fix flakes and ran clean in all six runs, so they come off with the
// doctrine the list already states ("a fresh round of evidence, never as a
// default"). If either reddens, this gate fails and says so — that is the
// intended behaviour, and the fix is to look at the file, not to re-list it.

// 2026-11-15 (shard-the-e2e-lane): the lane is sharded across runners
// (Playwright --shard on fullyParallel:false partitions the FILE list), so the
// gate now aggregates N shard reports instead of judging one. Two completeness
// rules come with it, both failures rather than warnings:
//   1. every shard report must arrive — a missing report means the lane never
//      ran to completion (server boot failure, artifact storage quota), and
//      "green shards plus a missing report" is not a fact about the code;
//   2. with --lane, the union of spec files observed across the reports must
//      equal the lane's own `--list` enumeration, in BOTH directions. The
//      expectation is enumerated from the config in the judging job — never
//      derived from the reports themselves, or a truncated lane would define
//      its own truncated expectation.
// The single-report form is the N=1 case and keeps its old behaviour.

// usage: node scripts/check-e2e-budget.mjs <report.json> [more.json …] [--lane <list.json>]
const argv = process.argv.slice(2);
const laneFlag = argv.indexOf("--lane");
let lanePath = null;
if (laneFlag !== -1) {
  lanePath = argv[laneFlag + 1];
  if (!lanePath) {
    console.error("--lane requires a path argument");
    process.exit(2);
  }
  argv.splice(laneFlag, 2);
}
const reportPaths = argv.filter((a) => a !== "--");
if (!reportPaths.length) {
  console.error("usage: node scripts/check-e2e-budget.mjs <report.json> [more.json …] [--lane <list.json>]");
  process.exit(2);
}

// Each report carries the shard attribution its failures print under. With a
// single report the label is omitted (the historical output shape).
const single = reportPaths.length === 1;
const reports = [];
for (const p of reportPaths) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(p, "utf8"));
  } catch (err) {
    // No report = the shard never reached the reporter (server boot failure,
    // timeout, or the artifact upload dying on storage quota — measured
    // 2026-11-14: ~575 MB against the free plan's 500 MB). That is a real
    // failure, not a flake: say so instead of aggregating what arrived.
    console.error(`✗ no readable e2e report at ${p}: ${err.message}`);
    console.error("  (this shard never produced one — server boot failure, timeout, or");
    console.error("   the artifact upload dying on storage quota. The lane's verdict is");
    console.error("   UNKNOWN without it: judging only the reports that arrived would");
    console.error("   turn a silently dropped slice of the suite into a green run.)");
    process.exit(1);
  }
  reports.push({ path: p, report: parsed });
}

// Playwright's JSON reporter puts the suite tree under .suites; walk it and
// collect specs whose last result is not ok, without depending on the (stable
// but deep) config/suite nesting for anything else.
const failed = [];
const observed = new Set();
let expectedTotal = 0;
const walk = (suite, trail, shard) => {
  const path_ = suite.file ? [suite.file] : trail;
  for (const spec of suite.specs ?? []) {
    const name = baseName(spec.file ?? path_[0]);
    if (spec.tests?.length) observed.add(name);
    const bad = (spec.tests ?? []).some((t) =>
      (t.results ?? []).some((r) => r.status !== "passed" && r.status !== "skipped"),
    );
    if (bad) failed.push({ file: spec.file ?? path_[0] ?? "(unknown)", title: spec.title, shard });
  }
  for (const child of suite.suites ?? []) walk(child, path_, shard);
};
for (const { path: p, report } of reports) {
  for (const s of report.suites ?? []) walk(s, [], single ? null : p);
  expectedTotal += report.stats?.expected ?? 0;
}

const stats = { expected: expectedTotal };
const unexpected = Array.isArray(failed) && failed.length ? failed.length : (reports[0].report.stats?.unexpected ?? 0);

// The union check (rule 2). Files are compared at basename level — the gate
// already normalizes spec.file to basenames, and Playwright's `--list` reports
// paths the same way the run reports do. Files whose tests are ALL excluded by
// the project's grepInvert (@smoke/@live) appear on neither side, so the
// comparison stays symmetric without a hand-maintained exception list.
if (lanePath) {
  let laneReport;
  try {
    laneReport = JSON.parse(readFileSync(lanePath, "utf8"));
  } catch (err) {
    console.error(`✗ cannot read the lane enumeration at ${lanePath}: ${err.message}`);
    console.error("  (the expected file list could not be produced — the verdict is");
    console.error("  UNDETERMINED, not green: a gate that cannot enumerate its lane");
    console.error("  cannot vouch for what the shards covered.)");
    process.exit(2);
  }
  const laneFiles = new Set();
  const walkList = (suite, trail) => {
    const path_ = suite.file ? [suite.file] : trail;
    for (const spec of suite.specs ?? []) laneFiles.add(baseName(spec.file ?? path_[0]));
    for (const child of suite.suites ?? []) walkList(child, path_);
  };
  for (const s of laneReport.suites ?? []) walkList(s, []);
  // A lane with ZERO files is never legitimate — every real lane collects
  // ~137. An empty enumeration means `--list` produced nothing usable (bad
  // filter, wrong project, a truncated write), and comparing it against an
  // equally empty report would print "✓ union matches (0 files)": a vacuous
  // pass, the same shape as an empty allowlist reading as a clean run. The
  // floor below would reject it too, but only AFTER this line calls it green.
  if (laneFiles.size === 0) {
    console.error(`✗ the lane enumeration at ${lanePath} lists no test files at all.`);
    console.error("  (the fast project collects ~137 spec files; an empty enumeration means");
    console.error("  `--list` did not work — wrong project, bad filter, or a truncated write.");
    console.error("  Comparing nothing against nothing is not coverage.)");
    process.exit(2);
  }
  const missing = [...laneFiles].filter((f) => !observed.has(f)).sort();
  const extra = [...observed].filter((f) => !laneFiles.has(f)).sort();
  if (missing.length || extra.length) {
    console.error(`✗ shard union ≠ lane enumeration (${laneFiles.size} files expected, ${observed.size} observed)`);
    if (missing.length) {
      console.error(`  in the lane but NO shard observed (dropped by the split?): ${missing.join(", ")}`);
    }
    if (extra.length) {
      console.error(`  observed by shards but not in the lane enumeration (stale --list?): ${extra.join(", ")}`);
    }
    console.error("  A partition that quietly drops a file turns 'the suite is green' into");
    console.error("  a lie that looks exactly like success.");
    process.exit(1);
  }
  console.log(`✓ shard union matches the lane enumeration (${observed.size} files)`);
}

// A flake allowlist is the one place in this gate that can hide a regression
// forever: an entry says "a red here is not news", and nothing ever asks the
// entry to justify itself. So every run — green ones included — reports the
// ledger: which entries were clean, and which of them carry no evidence
// comment. A green run that says nothing is indistinguishable from a run that
// checked nothing (the same shape as every silent gate this repo has had to
// dig out), and removing an entry needs exactly this per-file history.
const flakyEntries = [...KNOWN_FLAKY];
const hit = new Set(failed.map((f) => baseName(f.file)));
// "clean" only means something for a file that RAN: a report that filtered the
// lane (or a synthetic one) must not be read as "all nine are fine now".
const ranClean = flakyEntries.filter((f) => observed.has(f) && !hit.has(f));
const notObserved = flakyEntries.filter((f) => !observed.has(f) && !hit.has(f));
const undocumented = (() => {
  try {
    const src = readFileSync(fileURLToPath(import.meta.url), "utf8");
    const block = /const KNOWN_FLAKY = new Set\(\[([\s\S]*?)\]\);/.exec(src)?.[1] ?? "";
    return block
      .split("\n")
      .filter((line) => /^\s*"[^"]+\.spec\.js",?/.test(line))
      .filter((line) => !line.includes("//"))
      .map((line) => line.trim().replace(/,$/, "").replace(/"/g, ""));
  } catch {
    return [];
  }
})();

const ledger = () => {
  console.log(
    `known-flaky ledger: ${ranClean.length} ran clean, ${[...hit].filter((f) => KNOWN_FLAKY.has(f)).length} went red,` +
      ` ${notObserved.length} not exercised by this report`,
  );
  if (ranClean.length) {
    console.log(`  observed & clean (drop after a few more runs like this): ${ranClean.join(", ")}`);
  }
  if (undocumented.length) {
    console.log(
      `  no evidence comment (an entry nobody has measured is a blanket exception): ${undocumented.join(", ")}`,
    );
  }
};

// A report is only evidence if the lane actually ran. An empty (or filtered)
// report has zero failed specs and would otherwise read as "clean" — the same
// "zero objects checked equals undecidable" shape that has produced a silent
// green elsewhere in this repo. The floor is deliberately coarse (a filtered
// run is a deliberate act, so it can say `E2E_MIN_SPEC_FILES=1`); what it must
// catch is the lane dying early and leaving a short report behind. With shard
// reports the floor applies to the AGGREGATE (each shard holds ~1/4 of the
// lane), after the missing-report rule has already rejected a short set of
// files.
//
// 2026-11-15: when `--lane` is given this fixed number is REDUNDANT and can be
// wrong in both directions. Redundant because the exact union check below
// already fails on any file the lane has but the reports lack; wrong because a
// lane that legitimately shrinks (specs deleted, a subset project) would trip a
// hardcoded 100 while the union check — the one that actually knows the lane —
// is satisfied. So with a lane, keep only a sanity floor (a lane below this
// count is not the fast lane at all), and let the union carry the coverage
// requirement.
const MIN_SPEC_FILES = Number(process.env.E2E_MIN_SPEC_FILES ?? (lanePath ? 10 : 100));
if (observed.size < MIN_SPEC_FILES) {
  console.error(
    `✗ the report covers ${observed.size} spec file(s); the fast lane runs ~140 ` +
      `(floor ${MIN_SPEC_FILES}). The lane did not run to completion — a short report is not a clean one.`,
  );
  process.exit(1);
}

const shardLabel = (f) => (f.shard ? `[${f.shard}] ` : "");

// The ledger prints on EVERY evaluated lane — clean, inside budget, or red. It
// used to sit inside the `unexpected === 0` branch, so the one run that gave a
// red (43624475405: plugins-supply + session-open) said nothing about which of
// the other listed files had run clean, which is exactly the evidence needed to
// decide whether the list is still honest.
if (unexpected === 0) {
  console.log(
    `✓ e2e lane clean (${stats.expected ?? "?"} passed` +
      (single ? "" : `, ${reports.length} shard reports`) + ")",
  );
  ledger();
  process.exit(0);
}
console.log(`e2e reds this run: ${unexpected} (budget ${FLAKE_BUDGET})`);
for (const f of failed) console.log(`  · ${shardLabel(f)}${f.file} — ${f.title}`);
ledger();

const unknown = [...new Set(failed.map((f) => baseName(f.file)))].filter((f) => !KNOWN_FLAKY.has(f));
if (unknown.length) {
  console.error(`\n✗ red in spec file(s) with no flake history: ${unknown.join(", ")}`);
  console.error("  A green spec does not go red from load alone. Treat as a regression");
  console.error("  until the file is shown to pass standalone 3× on this commit.");
  process.exit(1);
}

if (unexpected > FLAKE_BUDGET) {
  console.error(`\n✗ ${unexpected} reds exceed the measured flake band (${FLAKE_BUDGET}).`);
  console.error("  A band that size means one shared cause, not nine independent flakes.");
  process.exit(1);
}

console.log("\n✓ all reds are in files with flake history, and inside the budget.");
console.log("  Named above so they are still visible; fix the file, then remove it from");
console.log("  KNOWN_FLAKY in scripts/check-e2e-budget.mjs.");
