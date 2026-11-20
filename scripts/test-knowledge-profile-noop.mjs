// add-pack-memory-declaration task 2.3: an existing pack that declares only
// `knowledge.memory` must materialize byte-identically.
//
// "Byte-identical" is a claim about a DIFFERENCE, so a green assertion on today's
// output proves nothing — the expectation would be whatever the new code emits.
// This rebuilds the pre-change module from git (the parent of the commit that
// introduced the `read` spelling and the four-column face) and compares its
// resolved profile against the current one, field for field, on a battery of
// declarations an existing pack can actually contain.
//
// Comparing the PROFILE is enough to claim the injection segment is identical:
// the prompt block is a pure function of `{enabled, scope, budget}` — the ladder
// branches on exactly those three values, nothing else.
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { effectiveProfile, normalizeKnowledgeProfile } from "../server/knowledge-profile.js";

const PAAS = join(dirname(fileURLToPath(import.meta.url)), "..");

function git(args) {
  return execFileSync("git", args, { cwd: PAAS, encoding: "utf8" }).trim();
}

/** Rebuild server/knowledge-profile.js as it stood before the four-axis work. */
function baselineProfileModule() {
  const introducedBy = git(["log", "-S", '"read", "collections"', "--format=%H", "--", "server/knowledge-profile.js"])
    .split("\n")
    .filter(Boolean)
    .at(-1);
  assert.ok(introducedBy, "could not find the commit that introduced the read spelling");
  const dir = mkdtempSync(join(tmpdir(), "kp-baseline-"));
  const archive = execFileSync("git", ["archive", `${introducedBy}^`, "server/knowledge-profile.js"], {
    cwd: PAAS,
    maxBuffer: 64 * 1024 * 1024,
  });
  const untar = spawnSync("tar", ["-x", "-C", dir], { input: archive });
  assert.equal(untar.status, 0, `tar failed: ${untar.stderr}`);
  return { dir, module: join(dir, "server", "knowledge-profile.js") };
}

const clone = (v) => (v === undefined ? undefined : structuredClone(v));

// Declarations an EXISTING pack can carry: only `knowledge.memory` (+ the
// collections refs that predate this work). No `read`, no four-axis block — those
// are new spellings and a difference there would be the point of the change.
const DECLARATIONS = {
  "absent": null,
  "empty object": {},
  "empty memory": { memory: {} },
  "enabled true": { memory: { enabled: true } },
  "scope shared": { memory: { scope: "shared" } },
  "scope off": { memory: { scope: "off" } },
  "scope + budget": { memory: { scope: "shared", budget: 800 } },
  "budget at floor": { memory: { budget: 64 } },
  "budget at ceiling": { memory: { budget: 2000 } },
  "budget below floor": { memory: { budget: 63 } },
  "budget above ceiling": { memory: { budget: 2001 } },
  "fractional budget": { memory: { budget: 120.5 } },
  "unknown scope": { memory: { scope: "own" } },
  "unknown memory key": { memory: { budgt: 900 } },
  "collection ref": { collections: ["library:contracts"] },
  "bad collection ref": { collections: ["contracts"] },
  "defaults written out": { memory: { enabled: true, scope: "own+shared", budget: 1200 } },
};

// What the ONE production consumer actually reads out of a resolved profile:
// `server/fleet-context.js:584` gates the memory block on
// `scope !== "off" && (memory.enabled ?? true)` and caps the ladder at `budget`.
// Nothing else in the profile reaches the prompt, so this triple IS the
// materialized injection segment for any practical purpose.
const injectionView = (resolved) => {
  if (!resolved.ok) return { ok: false, errors: resolved.errors };
  const mem = resolved.profile.memory;
  const injects = mem.scope !== "off" && (mem.enabled ?? true);
  return {
    ok: true,
    injects,
    // The ladder only receives a scope when it injects; when the switch is closed
    // the value is never read, so reporting it here would compare a number nobody
    // uses and call it a difference.
    scope: injects ? mem.scope : null,
    budget: mem.budget,
    collections: resolved.profile.collections,
  };
};

// The baseline is "the parent of the commit that introduced the `read` spelling",
// which only names the pre-change code in a history made of real commits. The
// public repo's main is a SQUASHED export (one commit per release), so there the
// `-S` hit is the snapshot itself and its parent is the previous RELEASE — days
// of unrelated changes, not the pre-change file. Comparing against that yields a
// red, or a green, that says nothing about this claim; the honest move is to say
// so. Measured 2026-11-13 on the published snapshot: depth 1, so ALL FOUR tests
// below need this — one of them had the check and the other three went red with
// `git archive <head>^: not a valid object name`.
const HISTORY_DEPTH = Number(git(["rev-list", "--count", "HEAD"]));
function hasPreChangeBaseline(t) {
  if (HISTORY_DEPTH >= 10) return true;
  t.skip(`squashed history (${HISTORY_DEPTH} commits) — no pre-change baseline to compare against`);
  return false;
}

test("a knowledge.memory-only pack materializes the same injection input before and after", async (t) => {
  // The baseline is "the parent of the commit that introduced the `read`
  // spelling". That only names the pre-change code in a history made of real
  // commits. The public repo's main is a SQUASHED export (one commit per
  // release: "Platform v1.3.0 — initial open-source release (snapshot of
  // gitee/…)"), so there the `-S` hit is the snapshot itself and its parent is
  // the previous RELEASE — three days of unrelated changes, not the pre-change
  // file. Comparing against that yields a red, or a green, that says nothing
  // about this claim; the honest move is to say so.
  if (!hasPreChangeBaseline(t)) return;
  const baseline = baselineProfileModule();
  try {
    const old = await import(baseline.module);
    const differences = [];
    for (const [label, decl] of Object.entries(DECLARATIONS)) {
      const before = injectionView(old.normalizeKnowledgeProfile(clone(decl)));
      const after = injectionView(normalizeKnowledgeProfile(clone(decl)));
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        differences.push(`${label}\n  before: ${JSON.stringify(before)}\n  after:  ${JSON.stringify(after)}`);
      }
    }
    assert.deepEqual(
      differences,
      [],
      `the four-axis work changed what an existing declaration injects:\n${differences.join("\n")}`,
    );
  } finally {
    rmSync(baseline.dir, { recursive: true, force: true });
  }
});

// The profile object itself must also be identical, EXCEPT for the one pair the
// change canonicalizes (see the dedicated test at the bottom). Proving the
// difference is confined to `enabled`/`scope` is stronger than ignoring those
// fields: an unexpected difference anywhere else would still surface.
test("the resolved profile is identical except for the enabled/scope pair", async (t) => {
  if (!hasPreChangeBaseline(t)) return;
  const baseline = baselineProfileModule();
  try {
    const old = await import(baseline.module);
    const differences = [];
    for (const [label, decl] of Object.entries(DECLARATIONS)) {
      const before = old.normalizeKnowledgeProfile(clone(decl));
      const after = normalizeKnowledgeProfile(clone(decl));
      if (!before.ok || !after.ok) {
        if (JSON.stringify(before) !== JSON.stringify(after)) {
          differences.push(`${label}: refusals differ\n  before: ${JSON.stringify(before)}\n  after:  ${JSON.stringify(after)}`);
        }
        continue;
      }
      const strip = (p) => ({ ...p, memory: { budget: p.memory.budget }, collections: p.collections });
      if (JSON.stringify(strip(before.profile)) !== JSON.stringify(strip(after.profile))) {
        differences.push(`${label}\n  before: ${JSON.stringify(before.profile)}\n  after:  ${JSON.stringify(after.profile)}`);
      }
      // Outside that pair, every field must match exactly.
      if (JSON.stringify(before.profile.collections) !== JSON.stringify(after.profile.collections)) {
        differences.push(`${label}: collections differ`);
      }
    }
    assert.deepEqual(differences, [], `unexpected differences:\n${differences.join("\n")}`);
  } finally {
    rmSync(baseline.dir, { recursive: true, force: true });
  }
});

test("the battery is not vacuous (errors and non-defaults must both appear)", async (t) => {
  if (!hasPreChangeBaseline(t)) return;
  const baseline = baselineProfileModule();
  try {
    const old = await import(baseline.module);
    const results = Object.values(DECLARATIONS).map((decl) => old.normalizeKnowledgeProfile(clone(decl)));
    const errors = results.filter((r) => !r.ok).length;
    const nonDefault = results.filter(
      (r) =>
        r.ok &&
        JSON.stringify(r.profile) !== JSON.stringify(old.normalizeKnowledgeProfile(null).profile),
    ).length;
    assert.ok(errors >= 4, `expected several refusals, got ${errors}`);
    assert.ok(nonDefault >= 4, `expected several non-default profiles, got ${nonDefault}`);
  } finally {
    rmSync(baseline.dir, { recursive: true, force: true });
  }
});

test("the wholesale merge of cell default over deployment override is unchanged", async (t) => {
  if (!hasPreChangeBaseline(t)) return;
  const baseline = baselineProfileModule();
  try {
    const old = await import(baseline.module);
    const PAIRS = {
      "nothing anywhere": [null, null],
      "cell only": [{ memory: { scope: "shared", budget: 700 } }, null],
      "deployment wins wholesale": [{ memory: { scope: "shared", budget: 700 } }, { memory: { budget: 900 } }],
      "deployment segment resets to platform defaults": [{ memory: { budget: 700 } }, { memory: {} }],
      "null segment resets": [{ memory: { scope: "shared" } }, { memory: null }],
      "collections inherit independently": [{ collections: ["library:a"] }, { memory: { budget: 600 } }],
      "deployment mentions collections too": [{ collections: ["library:a"] }, { collections: ["library:b"] }],
      "bad override": [null, { memory: { scope: "nope" } }],
    };
    const differences = [];
    for (const [label, [cell, deployment]] of Object.entries(PAIRS)) {
      const before = old.effectiveProfile(clone(cell), clone(deployment));
      const after = effectiveProfile(clone(cell), clone(deployment));
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        differences.push(`${label}\n  before: ${JSON.stringify(before)}\n  after:  ${JSON.stringify(after)}`);
      }
    }
    assert.deepEqual(differences, [], `the merge contract changed:\n${differences.join("\n")}`);
  } finally {
    rmSync(baseline.dir, { recursive: true, force: true });
  }
});

// ── the intentional change, stated rather than hidden ──────────────────────
//
// MEASURED, not assumed: `enabled` and `scope` used to be two switches behind one
// readiness verdict, in both directions —
//
//   {enabled: false}  →  {enabled: false, scope: "own+shared"}   (scope says read)
//   {scope: "off"}    →  {enabled: true,  scope: "off"}          (flag says on)
//
// The change canonicalizes the pair to one verdict: off in either spelling closes
// both. This is INERT at the only consumer — `server/fleet-context.js:584` gates
// on `scope !== "off" && (memory.enabled ?? true)`, so a half-switched profile
// already yielded no memory block before this change. The value of the fix is that
// the pair can no longer disagree in storage and mislead the next reader (or the
// next consumer, which would reasonably read only one of the two).
test("enabled=false and scope=off now close each other, and that is deliberate", async (t) => {
  if (!hasPreChangeBaseline(t)) return;
  const baseline = baselineProfileModule();
  try {
    const old = await import(baseline.module);
    assert.deepEqual(old.normalizeKnowledgeProfile({ memory: { enabled: false } }).profile, {
      memory: { enabled: false, scope: "own+shared", budget: 1200 },
      collections: [],
    });
    assert.deepEqual(normalizeKnowledgeProfile({ memory: { enabled: false } }).profile, {
      memory: { enabled: false, scope: "off", budget: 1200 },
      collections: [],
    });
    assert.deepEqual(old.normalizeKnowledgeProfile({ memory: { scope: "off" } }).profile, {
      memory: { enabled: true, scope: "off", budget: 1200 },
      collections: [],
    });
    assert.deepEqual(normalizeKnowledgeProfile({ memory: { scope: "off" } }).profile, {
      memory: { enabled: false, scope: "off", budget: 1200 },
      collections: [],
    });
    // The half-switched profiles both meant "no memory" to the consumer; assert
    // that explicitly so the inertness claim is tested, not just written down.
    const view = (r) => injectionView(r);
    assert.deepEqual(
      view(old.normalizeKnowledgeProfile({ memory: { enabled: false } })),
      view(normalizeKnowledgeProfile({ memory: { enabled: false } })),
    );
    assert.deepEqual(
      view(old.normalizeKnowledgeProfile({ memory: { scope: "off" } })),
      view(normalizeKnowledgeProfile({ memory: { scope: "off" } })),
    );
  } finally {
    rmSync(baseline.dir, { recursive: true, force: true });
  }
});
