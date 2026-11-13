// add-pack-memory-declaration: the pack-side shape half of the four-axis memory
// declaration (lib/pack-memory.js). Pure — the publish gate runs in the gateway
// process with no cell state, so nothing here may read a file, a DB or a roster.
//
// The shared fixture in fd-memory is the cross-repo anchor (task 1.5): the same
// documents that the Python and TypeScript resolvers accept/reject must be
// accepted/rejected here, otherwise the pack face would advertise a shape the
// memory service refuses (or vice versa).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import {
  MEMORY_AXES,
  READ_SCOPES,
  STORE_HOMES,
  WRITE_AUTHORITIES,
  checkReadSpellingAgreement,
  validateAgentMemory,
  validateMemoryBlock,
} from "../lib/pack-memory.js";

const codes = (errors) => errors.map((e) => e.code);
const paths = (errors) => errors.map((e) => e.path);

const FIXTURE = new URL("../../fd-memory/fixtures/memory-policy-cases.json", import.meta.url);

/** The cross-repo fixture, or null when the sibling repo is not checked out.
 *
 *  The fixture lives in fd-memory — the cross-repo anchor (task 1.5) — which a
 *  single-repo CI checkout does not have (`ENOENT …/platform/fd-memory/…`, first
 *  sharded run). Every reader goes through this so a new test cannot forget the
 *  guard; skipping on exactly this cause keeps the anchor real where both trees
 *  exist instead of reporting a red that only says "no sibling checkout here".
 */
function crossRepoFixture() {
  return existsSync(FIXTURE) ? JSON.parse(readFileSync(FIXTURE, "utf8")) : null;
}
const SKIP_NO_SIBLING = "fd-memory is not checked out next to this repo — no cross-repo fixture to replay";

// ── accepted shapes ────────────────────────────────────────────────────────

test("an absent block is legal (zero-change for every existing pack)", () => {
  assert.deepEqual(validateMemoryBlock(undefined), []);
  assert.deepEqual(validateMemoryBlock(null), []);
});

test("all four axes with every legal value are accepted", () => {
  for (const home of STORE_HOMES) {
    assert.deepEqual(validateMemoryBlock({ store: { home } }), [], home);
  }
  for (const scope of READ_SCOPES) {
    assert.deepEqual(validateMemoryBlock({ read: { scope } }), [], scope);
  }
  for (const authority of WRITE_AUTHORITIES) {
    assert.deepEqual(validateMemoryBlock({ write: { authority } }), [], authority);
  }
  assert.deepEqual(
    validateMemoryBlock({
      store: { home: "member" },
      read: { scope: "own+shared", budget: 1200 },
      write: { authority: "shared" },
      process: { distill: "on", promote_after: 3, cold_after_days: 0 },
    }),
    [],
  );
});

test("a partial declaration is legal — omission is what lets the next level inherit", () => {
  assert.deepEqual(validateMemoryBlock({ read: { budget: 800 } }), []);
});

// ── rejected shapes, each naming its own field ─────────────────────────────

test("an unknown axis is named", () => {
  const errors = validateMemoryBlock({ storage: { home: "fleet" } });
  assert.deepEqual(codes(errors), ["memory_axis_unknown"]);
  assert.deepEqual(paths(errors), ["memory.storage"]);
});

test("a misspelled sub-key is named with the known set", () => {
  const errors = validateMemoryBlock({ process: { distil: "off" } });
  assert.deepEqual(codes(errors), ["memory_key_unknown"]);
  assert.deepEqual(paths(errors), ["memory.process.distil"]);
  assert.match(errors[0].error, /distill/);
});

test("an address in store.home is refused as a boundary, not as a typo", () => {
  for (const home of ["d-mypack", "d/pack/member", "u/alice/p/proj", "/var/lib/fd-memory", "sqlite:///x"]) {
    const errors = validateMemoryBlock({ store: { home } });
    assert.deepEqual(codes(errors), ["store_home_addressed"], home);
    assert.match(errors[0].error, /resolved from identity/);
  }
});

test("a plain wrong enum value is invalid, not addressed", () => {
  const errors = validateMemoryBlock({ store: { home: "team" } });
  assert.deepEqual(codes(errors), ["store_home_invalid"]);
});

test("own is refused as unexecutable, with the reason", () => {
  const errors = validateMemoryBlock({ read: { scope: "own" } });
  assert.deepEqual(codes(errors), ["read_scope_unexecutable"]);
  assert.match(errors[0].error, /no consumer that executes it/);
});

test("an out-of-range budget is refused, never clamped", () => {
  for (const budget of [63, 2001, 0, 800.5, "800"]) {
    const errors = validateMemoryBlock({ read: { budget } });
    assert.deepEqual(codes(errors), ["read_budget_invalid"], String(budget));
    assert.match(errors[0].error, /refused rather than clamped/);
  }
});

test("authority rejects storage-location values", () => {
  for (const authority of ["user", "project", "local"]) {
    const errors = validateMemoryBlock({ write: { authority } });
    assert.deepEqual(codes(errors), ["write_authority_invalid"], authority);
    assert.match(errors[0].error, /not a storage location/);
  }
});

test("process bounds are refused, not floored", () => {
  assert.deepEqual(codes(validateMemoryBlock({ process: { promote_after: 0 } })), ["process_promote_after_invalid"]);
  assert.deepEqual(codes(validateMemoryBlock({ process: { cold_after_days: -1 } })), ["process_cold_after_days_invalid"]);
  assert.deepEqual(codes(validateMemoryBlock({ process: { distill: "maybe" } })), ["process_distill_invalid"]);
});

test("every problem in one block is reported in one pass", () => {
  const errors = validateMemoryBlock({
    store: { home: "d-x" },
    read: { scope: "own", budget: 9 },
    bogus: {},
  });
  assert.equal(errors.length, 4);
  assert.deepEqual(paths(errors).sort(), ["memory.bogus", "memory.read.budget", "memory.read.scope", "memory.store.home"]);
});

// ── agent entry: block + legacy shorthand ──────────────────────────────────

test("memory_scope alone is legal and means write.authority", () => {
  assert.deepEqual(validateAgentMemory(undefined, "private", "agents[0].memory"), []);
});

test("the two spellings must agree", () => {
  const errors = validateAgentMemory(
    { write: { authority: "shared" } },
    "private",
    "agents[0].memory",
  );
  assert.deepEqual(codes(errors), ["memory_authority_conflict"]);
  assert.match(errors[0].error, /private/);
  assert.match(errors[0].error, /shared/);
});

test("agreeing spellings are accepted", () => {
  assert.deepEqual(validateAgentMemory({ write: { authority: "shared" } }, "shared", "agents[0].memory"), []);
});

test("an invalid shorthand value is refused by name", () => {
  const errors = validateAgentMemory(undefined, "team", "agents[0].memory");
  assert.deepEqual(codes(errors), ["memory_scope_invalid"]);
  assert.deepEqual(paths(errors), ["agents[0].memory_scope"]);
});

test("the pre-existing guidance prose is not an axis and is not refused", () => {
  // add-agent-self-iteration already ships `agents[].memory.guidance`. Refusing
  // it would break every pack that declares it — the change promised the
  // opposite. It is also not an axis: guidance says what to write down,
  // write.authority says whether the conclusion counts.
  assert.deepEqual(validateAgentMemory({ guidance: "记下每次口径变更与原因" }, undefined, "agents[0].memory"), []);
  // …and it may sit next to the axes.
  assert.deepEqual(
    validateAgentMemory(
      { guidance: "记口径", write: { authority: "shared" } },
      undefined,
      "agents[0].memory",
    ),
    [],
  );
  // Pack level has no consumer for guidance, so it stays refused there.
  const packLevel = validateMemoryBlock({ guidance: "记口径" });
  assert.deepEqual(codes(packLevel), ["memory_axis_unknown"]);
});

test("agent-level errors carry the agent path", () => {
  const errors = validateAgentMemory({ store: { home: "d-p" } }, undefined, "agents[3].memory");
  assert.deepEqual(paths(errors), ["agents[3].memory.store.home"]);
});

// ── knowledge.memory vs memory.read ────────────────────────────────────────

test("only one spelling present is never a conflict", () => {
  assert.deepEqual(checkReadSpellingAgreement({ scope: "shared" }, undefined), []);
  assert.deepEqual(checkReadSpellingAgreement(undefined, { scope: "shared" }), []);
});

test("disagreeing spellings are refused, naming both values", () => {
  const errors = checkReadSpellingAgreement({ scope: "shared" }, { scope: "own+shared" });
  assert.deepEqual(codes(errors), ["read_memory_conflict"]);
  assert.match(errors[0].error, /shared/);
  assert.match(errors[0].error, /own\+shared/);
});

test("enabled:false and scope:off are the same statement, not a conflict", () => {
  assert.deepEqual(checkReadSpellingAgreement({ enabled: false }, { scope: "off" }), []);
  assert.deepEqual(checkReadSpellingAgreement({ scope: "shared" }, { scope: "shared" }), []);
  const errors = checkReadSpellingAgreement({ enabled: false }, { scope: "shared" });
  assert.deepEqual(codes(errors), ["read_memory_conflict"]);
});

test("a budget disagreement is its own conflict", () => {
  const errors = checkReadSpellingAgreement({ budget: 800 }, { budget: 900 });
  assert.deepEqual(paths(errors), ["memory.read.budget"]);
});

// ── cross-repo fixture ────────────────────────────────────────────────────

test("every fixtured declaration is accepted by the pack face too", (t) => {
  const fixture = crossRepoFixture();
  if (!fixture) {
    t.skip(SKIP_NO_SIBLING);
    return;
  }
  for (const c of fixture.cases) {
    for (const [label, doc] of c.levels) {
      const errors = validateMemoryBlock({ process: doc }, "memory");
      assert.deepEqual(errors, [], `${c.name}/${label}: the pack face refuses a document the resolvers accept`);
    }
    const deployment = c.deployment ?? {};
    if (Object.keys(deployment).length > 0) {
      assert.deepEqual(validateMemoryBlock({ process: deployment }, "memory"), [], `${c.name}/deployment`);
    }
  }
});

test("every fixtured rejection is refused here, naming the same key", (t) => {
  const fixture = crossRepoFixture();
  if (!fixture) {
    t.skip(SKIP_NO_SIBLING);
    return;
  }
  for (const r of fixture.rejections) {
    const errors = validateMemoryBlock({ process: r.doc }, "memory");
    assert.ok(errors.length > 0, `${r.name}: the pack face accepts a document the resolvers refuse`);
    assert.equal(errors[0].path, `memory.${r.expect_key}`, `${r.name}: wrong offending key named`);
  }
});

test("the axis list is closed at four — adding one is a spec change", () => {
  assert.deepEqual([...MEMORY_AXES], ["store", "read", "write", "process"]);
});

// ── the authoring doc's own example must validate ──────────────────────────

test("the example in docs/creating-packs.md passes the validator", () => {
  // A doc example that the validator rejects is worse than no example: the
  // author copies it, publishes, and meets the error at the worst moment. This
  // reads the real document, so editing the example without editing its shape
  // goes red here.
  const doc = readFileSync(new URL("../docs/creating-packs.md", import.meta.url), "utf8");
  const section = doc.split("### 3.2 记忆声明")[1];
  assert.ok(section, "the memory section is gone from the authoring doc");
  const block = section.match(/```json\n([\s\S]*?)```/);
  assert.ok(block, "the memory section no longer carries a json example");
  const example = JSON.parse(block[1]);
  assert.ok(example.memory, "the example must show the memory block");
  assert.deepEqual(validateMemoryBlock(example.memory), []);

  // The three traps the prose promises must be visible in the example itself,
  // otherwise the text and the sample teach different things.
  assert.equal(example.memory.store.home, "member");
  assert.notEqual(example.memory.read.scope, "own");
  assert.ok("cold_after_days" in example.memory.process);
});
