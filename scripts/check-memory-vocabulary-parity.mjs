#!/usr/bin/env node
// ── Three-way vocabulary conformance (add-pack-memory-declaration, task 1.5) ─
//
// One declaration is parsed by three implementations:
//
//   fd-agent-graph/fd_agent_graph/memory_decl.py   Python, offline roster check
//   fd-memory/src/policy.ts                        TypeScript, runtime policy face
//   paas/lib/pack-memory.js                        JavaScript, pack publish/install gate
//
// They cannot share code (three languages, three repos, two of them must run with
// no I/O), so they will drift unless something compares them. Drift here is not
// cosmetic: the pack face would advertise a shape the memory service refuses, or
// the roster would accept a value no consumer executes — which is the exact defect
// this effort removed (`read.scope: own`).
//
// This script is the comparison. It is a GATE: non-zero exit names the divergence.
//
//   node scripts/check-memory-vocabulary-parity.mjs
//
// Read-only: it imports the three modules, reads the shared fixture, writes nothing.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAAS = join(HERE, "..");
const WORKSPACE = join(PAAS, "..");
const AGENT_GRAPH = join(WORKSPACE, "fd-agent-graph");
const FIXTURE = join(WORKSPACE, "fd-memory", "fixtures", "memory-policy-cases.json");

const failures = [];
// Checks that could not run. Counted and printed in the verdict: a gate that
// quietly skips a section is indistinguishable from a gate that passed it.
const skips = [];
const ok = (label, detail = "") => console.log(`ok   ${label}${detail ? `: ${detail}` : ""}`);
const bad = (label, detail) => {
  failures.push(`${label}: ${detail}`);
  console.log(`FAIL ${label}: ${detail}`);
};

// ── 1. the process-object vocabulary, from each side ───────────────────────

const paas = await import(join(PAAS, "lib", "pack-memory.js"));

const pythonProbe = (() => {
  // Ask the Python module directly rather than re-typing its vocabulary here:
  // a copy in this file would be a FOURTH implementation of the same set.
  const script = `
import json, sys
sys.path.insert(0, ${JSON.stringify(AGENT_GRAPH)})
from fd_agent_graph import memory_decl as m
print(json.dumps({
  "read_scopes": list(m.READ_SCOPES),
  "store_homes": list(m.STORE_HOMES),
  "distill": list(m.DISTILL_VALUES),
  "executed": sorted(m.EXECUTED_SUBKEYS),
  "budget": [m.BUDGET_MIN, m.BUDGET_MAX],
}))
`;
  try {
    return JSON.parse(execFileSync("python3", ["-c", script], { encoding: "utf8" }));
  } catch (e) {
    bad("python-vocabulary", `could not load fd_agent_graph.memory_decl (${e.message.split("\n")[0]})`);
    return null;
  }
})();

if (pythonProbe) {
  const same = (label, a, b) =>
    JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())
      ? ok(label, JSON.stringify([...a].sort()))
      : bad(label, `python=${JSON.stringify(a)} paas=${JSON.stringify(b)}`);

  same("read.scope vocabulary", pythonProbe.read_scopes, paas.READ_SCOPES);
  same("store.home vocabulary", pythonProbe.store_homes, paas.STORE_HOMES);
  same("process.distill vocabulary", pythonProbe.distill, paas.DISTILL_VALUES);
  same("write.authority vocabulary", ["private", "shared"], paas.WRITE_AUTHORITIES);

  const [pyMin, pyMax] = pythonProbe.budget;
  if (pyMin === paas.MEMORY_BUDGET_MIN && pyMax === paas.MEMORY_BUDGET_MAX) {
    ok("read.budget bounds", `${pyMin}..${pyMax}`);
  } else {
    bad("read.budget bounds", `python=${pyMin}..${pyMax} paas=${paas.MEMORY_BUDGET_MIN}..${paas.MEMORY_BUDGET_MAX}`);
  }

  // `executed` is the change's central claim: a sub-key that resolves but has no
  // consumer must say so. Compare only the PROCESS axis: the root module also
  // lists store/read/write, which are consumed by the injection ladder and the
  // host reconciliation, neither of which this repo can see. Comparing the full
  // sets would report a difference in scope as a difference in truth.
  const pythonProcessExecuted = pythonProbe.executed.filter((s) => s.startsWith("process."));
  const paasExecuted = ["process.distill"];
  if (JSON.stringify(pythonProcessExecuted) === JSON.stringify(paasExecuted)) {
    ok("executed sub-keys (process axis)", pythonProcessExecuted.join(", "));
  } else {
    bad(
      "executed sub-keys (process axis)",
      `python=${JSON.stringify(pythonProcessExecuted)} paas=${JSON.stringify(paasExecuted)}`,
    );
  }
}

// ── 2. both faces agree on every fixtured document ────────────────────────

const fixture = JSON.parse(readFileSync(FIXTURE, "utf8"));

let accepted = 0;
for (const c of fixture.cases) {
  for (const [label, doc] of [...c.levels, ["deployment", c.deployment ?? {}]]) {
    if (!doc || Object.keys(doc).length === 0) continue;
    const errors = paas.validateMemoryBlock({ process: doc });
    if (errors.length === 0) accepted += 1;
    else bad("fixture-accepted", `${c.name}/${label} refused by the pack face: ${errors[0].code}`);
  }
}
ok("fixtured declarations accepted by the pack face", `${accepted} document(s)`);

let refused = 0;
for (const r of fixture.rejections) {
  const errors = paas.validateMemoryBlock({ process: r.doc });
  if (errors.length === 0) {
    bad("fixture-rejected", `${r.name} accepted by the pack face`);
    continue;
  }
  if (errors[0].path !== `memory.${r.expect_key}`) {
    bad("fixture-rejected", `${r.name}: named ${errors[0].path}, expected memory.${r.expect_key}`);
    continue;
  }
  refused += 1;
}
ok("fixtured rejections refused, same offending key", `${refused} case(s)`);

// ── 3. the pack face and the read face agree on the read axis ─────────────

const knowledge = await import(join(PAAS, "server", "knowledge-profile.js"));
if (JSON.stringify([...knowledge.KNOWLEDGE_SCOPE_VALUES].sort()) === JSON.stringify([...paas.READ_SCOPES].sort())) {
  ok("read axis: pack face == injection face", JSON.stringify([...paas.READ_SCOPES].sort()));
} else {
  bad(
    "read axis: pack face == injection face",
    `pack=${JSON.stringify(paas.READ_SCOPES)} injection=${JSON.stringify(knowledge.KNOWLEDGE_SCOPE_VALUES)}`,
  );
}

// `own` is the value that started this: both faces must refuse it for the same
// reason, and neither may quietly fall back to a neighbouring value.
for (const [label, run] of [
  ["pack face", () => paas.validateMemoryBlock({ read: { scope: "own" } })],
  ["injection face", () => knowledge.normalizeKnowledgeProfile({ read: { scope: "own" } }).errors],
]) {
  const errors = run();
  const code = label === "pack face" ? "read_scope_unexecutable" : "memory_scope_invalid";
  if (errors.length > 0 && errors[0].code === code) ok(`own refused by the ${label}`, code);
  else bad(`own refused by the ${label}`, `got ${errors[0]?.code ?? "accepted"}`);
}

// ── 4. probed negatives the fixture cannot express ────────────────────────
//
// The fixture is shared with the two resolvers, and they have no `store` axis at
// all (storage is resolved from identity on their side). So the address rule has
// no fixtured case — and a rule with no probe is a rule this gate cannot defend.
// Measured the hard way: replacing the address check with `if (false)` left this
// script green, i.e. the boundary could be deleted without anything noticing.
//
// These probes are paas-only conjunctions: they assert the pack face refuses a
// shape that no fixture covers, and that it refuses it for the ADDRESS reason
// rather than the generic "unknown enum" one.
const ADDRESS_PROBES = [
  ["store.home", { store: { home: "d/mypack/agentA" } }, "store_home_addressed"],
  ["store.home", { store: { home: "u/alice/p/proj" } }, "store_home_addressed"],
  ["store.home", { store: { home: "/var/lib/fd-memory" } }, "store_home_addressed"],
  ["store.home", { store: { home: "sqlite:///x.db" } }, "store_home_addressed"],
  ["read.scope", { read: { scope: "own" } }, "read_scope_unexecutable"],
  ["read.budget", { read: { budget: 8 } }, "read_budget_invalid"],
  ["write.authority", { write: { authority: "local" } }, "write_authority_invalid"],
  ["process.distill", { process: { distil: "off" } }, "memory_key_unknown"],
];
for (const [field, block, expectCode] of ADDRESS_PROBES) {
  const errors = paas.validateMemoryBlock(block);
  const got = errors[0]?.code ?? "accepted";
  if (got === expectCode) ok(`probe ${field} refused`, expectCode);
  else bad(`probe ${field}`, `expected ${expectCode}, got ${got}`);
}

// The pack face must also refuse an authority value in the storage slot — the
// exact defect that motivated this whole change.
{
  const errors = paas.validateMemoryBlock({ write: { authority: "project" } });
  if (errors[0]?.code === "write_authority_invalid" && /not a storage location/.test(errors[0].error)) {
    ok("authority is refused in the storage slot", "write_authority_invalid");
  } else {
    bad("authority is refused in the storage slot", `got ${errors[0]?.code ?? "accepted"}`);
  }
}

// ── 5. the ROW computation, against the same fixture the other two use ────
//
// Sections 1-4 compare vocabulary and acceptance: what words are legal. That is
// not enough for the four-column read face — two implementations can agree on
// every enum and still resolve an inheritance chain differently (per-key vs
// wholesale, whether `inherit` is a value, whether a deployment default counts as
// a declaration). The fixture states the EXPECTED rows, and both other
// implementations assert against it; this does the same, so paas's row builder is
// held to the same contract instead of to whatever it happens to produce.
//
// The fixture's documents are process docs (`{distill: ...}`), while this
// function takes four-axis declarations, so each level is wrapped the same way
// fd-agent-graph's own parity test wraps it.
{
  const wrap = (doc) => ({ process: doc });
  let checked = 0;
  for (const c of fixture.cases) {
    const levels = c.levels.map(([label, doc]) => [label, wrap(doc)]);
    const rows = paas.memoryRows(levels, { deploymentDefaults: wrap(c.deployment ?? {}) });
    for (const [key, expect] of Object.entries(c.expect)) {
      const got = rows[`process.${key}`];
      if (JSON.stringify(got) === JSON.stringify(expect)) checked += 1;
      else bad("fixture-rows", `${c.name}: process.${key}\n    expect: ${JSON.stringify(expect)}\n    got:    ${JSON.stringify(got)}`);
    }
    const notExecuted = paas.unexecutedMemory(rows).map((s) => s.slice(s.indexOf(".") + 1));
    if (JSON.stringify(notExecuted) === JSON.stringify(c.not_executed)) checked += 1;
    else bad("fixture-rows", `${c.name}: not_executed expect ${JSON.stringify(c.not_executed)} got ${JSON.stringify(notExecuted)}`);
  }
  ok("fixtured rows reproduced exactly", `${checked} row/column assertion(s)`);
}

// The read face is four columns over all four axes, not just the process axis the
// fixture covers. These are the two assertions task 3.3 is written against — one
// declared-but-unexecuted sub-key, one executed one — so the distinction cannot be
// lost by a later refactor that treats `executed` as a constant.
{
  const rows = paas.memoryRows([["pack", { process: { cold_after_days: 90, distill: "off" } }]]);
  const cold = rows["process.cold_after_days"];
  if (cold.declared === 90 && cold.effective === 90 && cold.executed === false) {
    ok("declared cold_after_days resolves but is reported unexecuted", "executed=false");
  } else {
    bad("declared cold_after_days", JSON.stringify(cold));
  }
  const listed = paas.unexecutedMemory(rows);
  if (JSON.stringify(listed) === JSON.stringify(["process.cold_after_days"])) {
    ok("the unexecuted list names exactly the unhonoured declaration", listed.join(", "));
  } else {
    bad("the unexecuted list", `got ${JSON.stringify(listed)}`);
  }
  const distill = rows["process.distill"];
  if (distill.declared === "off" && distill.effective === "off" && distill.executed === true) {
    ok("declared distill is reported executed", "executed=true");
  } else {
    bad("declared distill", JSON.stringify(distill));
  }
  // Every axis must appear, including ones nobody declared — a table that only
  // shows the axes someone wrote cannot answer "what is in force for store?".
  const missing = paas.MEMORY_SUBKEYS.filter((s) => !rows[s]);
  if (missing.length === 0) ok("all four axes appear in the table", `${paas.MEMORY_SUBKEYS.length} row(s)`);
  else bad("all four axes appear", `missing ${missing.join(", ")}`);
  // `inherit` is an instruction, not a value: a distill of inherit must fall
  // through to the next level rather than become the effective value.
  const inherited = paas.memoryRows([
    ["pack", { process: { distill: "inherit" } }],
    ["deployment", { process: { distill: "off" } }],
  ]);
  if (inherited["process.distill"].effective === "off" && inherited["process.distill"].inherited_from === "deployment") {
    ok("inherit keeps looking upward", "deployment=off");
  } else {
    bad("inherit keeps looking upward", JSON.stringify(inherited["process.distill"]));
  }
}

// A `null` in a declaration or a deployment default means "no opinion", and the
// reference implementation skips it. Compared against the Python module rather
// than against an expectation I wrote: if the two disagree here, one of them
// would report a different `effective` for the same document, and the read face
// would show a value that is not in force.
{
  const probe = `
import json, sys
sys.path.insert(0, ${JSON.stringify(AGENT_GRAPH)})
from fd_agent_graph import memory_decl as m
rows = m.resolve_effective(
  [("pack", {"process": {"distill": None}})],
  {"process": {"distill": None}},
)
print(json.dumps(rows["process.distill"]))
`;
  let pythonRow = null;
  try {
    pythonRow = JSON.parse(execFileSync("python3", ["-c", probe], { encoding: "utf8" }));
  } catch (e) {
    bad("null-means-no-opinion", `python probe failed (${e.message.split("\n")[0]})`);
  }
  if (pythonRow) {
    // The discriminating shape is "nothing else supplies a value": if a level
    // already named one, the deployment default is never consulted and the probe
    // passes whether or not null is handled — measured while writing this, the
    // first version of this probe stayed green with the bug re-injected.
    const paasRow = paas.memoryRows([["pack", { process: { distill: null } }]], {
      deploymentDefaults: { process: { distill: null } },
    })["process.distill"];
    if (JSON.stringify(paasRow) === JSON.stringify(pythonRow)) {
      ok("null means no opinion in both implementations", `effective=${paasRow.effective} from ${paasRow.inherited_from}`);
    } else {
      bad("null means no opinion", `python=${JSON.stringify(pythonRow)} paas=${JSON.stringify(paasRow)}`);
    }
  }
}

// ── 6. the document paas compiles must be one the memory service accepts ───
//
// The three-way comparison above is about VOCABULARY and ROWS. Neither answers
// the question the write path actually asks: does the document
// compilePackMemoryPolicy() would PUT survive the receiving side's own
// normalizer, unchanged? A key fd-memory has never heard of, or a value it clamps,
// would land a row that differs from what the pack declared — and the read face
// would then show the clamped value as if the pack had asked for it.
//
// Checked against fd-memory's compiled module (dist/policy.js) rather than against
// a retyped list, so this is a comparison and not a fourth opinion. If the sibling
// is checked out but not built, say so out loud and count it as skipped — a check
// that silently does not run is the failure mode this whole gate exists to catch.
{
  const FDMEM_POLICY = join(WORKSPACE, "fd-memory", "dist", "policy.js");
  let fdm = null;
  try {
    fdm = await import(FDMEM_POLICY);
  } catch {
    skips.push("fd-memory contract (sibling not built: run `npm test` or `npm run build` in fd-memory)");
  }
  if (fdm) {
    const { compilePackMemoryPolicy } = await import(join(PAAS, "lib", "pack-memory-policy.js"));
    const sameList = (a, b) => JSON.stringify([...a]) === JSON.stringify([...b]);

    if (sameList(paas.MEMORY_AXIS_KEYS.process, fdm.PROCESS_KEYS)) {
      ok("policy document keys agree with the memory service", JSON.stringify([...fdm.PROCESS_KEYS]));
    } else {
      bad("policy document keys", `memory-service=${JSON.stringify(fdm.PROCESS_KEYS)} pack-face=${JSON.stringify(paas.MEMORY_AXIS_KEYS.process)}`);
    }

    // Every document the compiler can produce must be accepted AND come back
    // unchanged. Enumerated from the compiler, not from a hand-written list.
    const DECLS = [
      { process: { distill: "off" } },
      { process: { distill: "on" } },
      { process: { distill: "inherit" } },
      { process: { promote_after: 5 } },
      { process: { cold_after_days: 0 } },
      { process: { distill: "off", promote_after: 3, cold_after_days: 90 } },
    ];
    let landed = 0;
    for (const decl of DECLS) {
      const compiled = compilePackMemoryPolicy(decl, { packId: "legal-crew" });
      if (!compiled.ok) {
        bad("compiled document accepted by the memory service", `${JSON.stringify(decl)} did not compile: ${compiled.errors[0].code}`);
        continue;
      }
      if (compiled.empty) continue;
      const normalized = fdm.normalizePolicy(compiled.doc, "process");
      if (!normalized.ok) {
        bad("compiled document accepted by the memory service", `${JSON.stringify(compiled.doc)} refused: ${JSON.stringify(normalized.errors?.[0] ?? null)}`);
        continue;
      }
      if (!sameList(Object.keys(compiled.doc), Object.keys(normalized.doc))) {
        bad("compiled document round-trips unchanged", `sent ${JSON.stringify(compiled.doc)} got ${JSON.stringify(normalized.doc)}`);
        continue;
      }
      for (const key of Object.keys(compiled.doc)) {
        if (compiled.doc[key] !== normalized.doc[key]) {
          bad("compiled document round-trips unchanged", `${key}: sent ${JSON.stringify(compiled.doc[key])} got ${JSON.stringify(normalized.doc[key])}`);
        }
      }
      landed += 1;
    }
    ok("compiled documents accepted and unchanged", `${landed} document(s)`);
  }
}

// ── verdict ───────────────────────────────────────────────────────────────

console.log("");
if (skips.length > 0) {
  console.log(`skip ${skips.length} check(s) that could not run:`);
  for (const s of skips) console.log(`  - ${s}`);
  console.log("");
}
if (failures.length > 0) {
  console.error(`${failures.length} divergence(s) between the three implementations:`);
  for (const f of failures) console.error(`  - ${f}`);
  console.error("\nFix the vocabulary in ONE place (the root change owns it) and re-run.");
  process.exit(1);
}
console.log("three implementations agree");
