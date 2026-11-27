// fleet-scoped-bench-credentials (3.3): the store gate's judgement, pinned.
//
// The gate exists because the ghost fleet of 2026-11-14 passed every other
// check: the bench side only validated the string, the platform only validated
// its own rows, and nothing asked whether the two named the same entity. These
// cases hold that line — including the one that matters most: an unreadable
// store must be "undecidable", never "no orphans".
import assert from "node:assert/strict";
import { test } from "node:test";
import { judge, normalizeStore, verdictOf } from "../scripts/check-fleet-credential-store.mjs";

const j = (input) => judge(normalizeStore(input));

test("healthy sole holder is green and says which fleet the shared patch carries", () => {
  const r = j({ fleets: [{ id: "fleet_A" }], credentials: [{ fleetId: "fleet_A", kind: "bench", tokenTail: "1111" }], orphaned: [] });
  assert.equal(r.findings.length, 0);
  assert.equal(verdictOf(r), "ok");
  assert.ok(r.notes.some((n) => /携带 fleet_A 的令牌/.test(n)), r.notes.join(" | "));
});

test("zero holders is a legal pre-seed state and still speaks", () => {
  const r = j({ fleets: [{ id: "fleet_A" }], credentials: [], orphaned: [] });
  assert.equal(r.findings.length, 0);
  assert.ok(r.notes.some((n) => /0 支舰队持有/.test(n)), "an empty store must say so — silence reads as 'nothing to report'");
});

test("credential row pointing at a missing fleet is red (R1)", () => {
  const r = j({ fleets: [{ id: "fleet_B" }], credentials: [{ fleetId: "fleet_ghost", kind: "bench", tokenTail: "1111" }], orphaned: [] });
  assert.equal(verdictOf(r), "fail");
  assert.equal(r.findings[0].code, "R1");
  assert.ok(r.notes.every((n) => !/携带 fleet_ghost 的令牌/.test(n)), "a ghost is never described as a holder");
});

test("unknown kind is red (R2) — a kind with no resolver cannot be scoped", () => {
  const r = j({ fleets: [{ id: "fleet_A" }], credentials: [{ fleetId: "fleet_A", kind: "wire", tokenTail: "1111" }], orphaned: [] });
  assert.equal(verdictOf(r), "fail");
  assert.ok(r.findings.some((f) => f.code === "R2"));
});

test("empty fingerprint is red (R3) — the row would scope nothing", () => {
  const r = j({ fleets: [{ id: "fleet_A" }], credentials: [{ fleetId: "fleet_A", kind: "bench", tokenTail: "" }], orphaned: [] });
  assert.ok(r.findings.some((f) => f.code === "R3"));
});

test("the store's own orphan view is cross-checked (R4), and its absence is not a pass", () => {
  const hit = j({ fleets: [{ id: "fleet_A" }], credentials: [], orphaned: [{ fleetId: "fleet_gone", kind: "bench" }] });
  assert.ok(hit.findings.some((f) => f.code === "R4"));
  const noView = j({ fleets: [{ id: "fleet_A" }], credentials: [] });
  assert.ok(noView.notes.some((n) => /R4 未判/.test(n)), "missing input must be reported as unjudged, not as green");
});

test("two holders ⇒ the note names multiple (shared patch carries none)", () => {
  const r = j({
    fleets: [{ id: "fleet_A" }, { id: "fleet_B" }],
    credentials: [
      { fleetId: "fleet_A", kind: "bench", tokenTail: "1111" },
      { fleetId: "fleet_B", kind: "bench", tokenTail: "2222" },
    ],
    orphaned: [],
  });
  assert.equal(r.findings.length, 0);
  assert.ok(r.notes.some((n) => /持有者 2 支/.test(n) && /不带 bench 行/.test(n)), r.notes.join(" | "));
});

test("malformed input throws (the caller turns that into exit 2, never a silent empty set)", () => {
  assert.throws(() => normalizeStore(null));
  assert.throws(() => normalizeStore({ credentials: [] }), /缺 fleets/);
});
