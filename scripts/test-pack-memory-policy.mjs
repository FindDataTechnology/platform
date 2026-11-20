// add-pack-memory-declaration 4.1-4.4 (compile layer): a pack's process axis
// becomes ONE policy document under ONE root — the pack's, not the fleet's.
//
// The claims under test are the ones a later refactor would get wrong without a
// red test: the root is keyed by pack (so two owners' teams cannot own
// contradictory documents), only declared keys are written (so a default never
// masquerades as a declaration), and an empty declaration produces NO write (an
// empty document is the clear operation, which would delete a sibling's policy).
import assert from "node:assert/strict";
import { test } from "node:test";
import { compilePackMemoryPolicy, isSamePolicyWrite, packMemoryRootKey } from "../lib/pack-memory-policy.js";

test("the policy root is the pack's, not the fleet's", () => {
  assert.equal(packMemoryRootKey("legal-crew"), "d-legal-crew");
  // The exact failure this prevents: two owners landing the same pack get two
  // fleet ids but ONE memory root, so the policy must not mention the fleet.
  const ownerA = compilePackMemoryPolicy({ process: { distill: "off" } }, { packId: "legal-crew" });
  const ownerB = compilePackMemoryPolicy({ process: { distill: "off" } }, { packId: "legal-crew" });
  assert.equal(ownerA.rootKey, ownerB.rootKey);
  assert.ok(isSamePolicyWrite(ownerA, ownerB), "same pack + same declaration must be the same write");
});

test("a pack id that would change the namespace shape is refused", () => {
  for (const bad of ["", "  ", "legal/crew", "legal.crew", "-".repeat(65)]) {
    assert.equal(packMemoryRootKey(bad), null, `${JSON.stringify(bad)} must not become a root key`);
    const r = compilePackMemoryPolicy({ process: { distill: "off" } }, { packId: bad });
    assert.equal(r.ok, false);
    assert.equal(r.errors[0].code, "pack_id_invalid");
  }
});

test("only declared process keys are written, in a fixed order", () => {
  const r = compilePackMemoryPolicy(
    { process: { cold_after_days: 90, distill: "off" } },
    { packId: "p" },
  );
  assert.equal(r.ok, true);
  // Declaration order was cold_after_days first; the document order is the
  // vocabulary's. Two compilations of one pack must serialize byte-identically or
  // the idempotency check (4.2) reads a reshuffle as a change.
  assert.deepEqual(Object.keys(r.doc), ["distill", "cold_after_days"]);
  assert.deepEqual(r.doc, { distill: "off", cold_after_days: 90 });
  const again = compilePackMemoryPolicy(
    { process: { distill: "off", cold_after_days: 90 } },
    { packId: "p" },
  );
  assert.ok(isSamePolicyWrite(r, again));
});

test("platform defaults are NOT materialized into the document", () => {
  const r = compilePackMemoryPolicy({ process: { distill: "off" } }, { packId: "p" });
  assert.deepEqual(r.doc, { distill: "off" });
  // promote_after/cold_after_days resolve to 3/0 by platform default; writing them
  // here would make the team look like it declared values nobody chose, and a
  // later default change would never reach it.
  assert.equal(r.doc.promote_after, undefined);
  assert.equal(r.doc.cold_after_days, undefined);
});

test("no process declaration means NO write (an empty doc would clear a sibling's policy)", () => {
  // JSON cannot carry an explicit `undefined`, so these are the shapes a real
  // manifest can have. Note `{ read: {...} }`: a pack that declares only the read
  // axis must still materialize fine — it simply has no policy to write.
  for (const decl of [undefined, null, {}, { read: { scope: "shared" } }, { write: { authority: "private" } }]) {
    const r = compilePackMemoryPolicy(decl, { packId: "p" });
    assert.equal(r.ok, true, `${JSON.stringify(decl)} must not be an error`);
    assert.equal(r.empty, true, `${JSON.stringify(decl)} must produce no write`);
    assert.deepEqual(r.doc, {});
  }
  // And the clear path is explicit, not accidental: an author who wants to roll a
  // team back writes nothing (task 4.4), so `empty` is the signal, not `{}`.
  const withProcess = compilePackMemoryPolicy({ process: {} }, { packId: "p" });
  assert.equal(withProcess.empty, true, "an empty process block is still no declaration");
});

test("other axes are validated but not carried into the policy document", () => {
  // Carrying them would put a declaration where nothing reads it; refusing them
  // would fail materialization for most packs, since most declare a read scope.
  const r = compilePackMemoryPolicy(
    {
      store: { home: "member" },
      read: { scope: "shared", budget: 900 },
      write: { authority: "shared" },
      process: { distill: "off" },
    },
    { packId: "p" },
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.doc, { distill: "off" }, "only the process axis is a policy document");
  // A typo on any axis still fails, though — the validator runs over the whole
  // declaration before this module decides what to carry.
  const typo = compilePackMemoryPolicy({ read: { scop: "shared" } }, { packId: "p" });
  assert.equal(typo.ok, false);
  assert.equal(typo.errors[0].code, "memory_key_unknown");
});

test("an invalid value is refused by the shared validator, not by this module", () => {
  const r = compilePackMemoryPolicy({ process: { distil: "off" } }, { packId: "p" });
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].code, "memory_key_unknown");
  assert.equal(r.errors[0].path, "memory.process.distil");
});
