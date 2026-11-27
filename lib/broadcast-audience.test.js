// Tests for broadcast audience resolution (add-broadcast-and-notification-inbox 1.3).
//
// The properties that matter — each is a failure this file exists to prevent:
//   · zero hits REFUSES rather than "succeeding with 0 deliveries";
//   · an unreachable identity source REFUSES rather than widening the audience;
//   · the caller cannot smuggle platform internals in as recipients.
import test from "node:test";
import assert from "node:assert/strict";
import { resolveAudience, describeAudience, AudienceError } from "./broadcast-audience.js";

function source(overrides = {}) {
  return {
    usersInOrg: async (id) => (id === "lex-customers" ? ["u1@x", "u2@x", "u3@x"] : []),
    usersWithRole: async (r) => (r === "legal" ? ["u1@x", "u4@x"] : []),
    allEmails: async () => ["u1@x", "u2@x", "u3@x", "u4@x"],
    ...overrides,
  };
}

test("org: expands to that org's members", async () => {
  const r = await resolveAudience({ kind: "org", id: "lex-customers" }, source());
  assert.deepEqual(r.recipients, ["u1@x", "u2@x", "u3@x"]);
  assert.equal(r.kind, "org");
});

test("role: expands to holders of that primary role", async () => {
  const r = await resolveAudience({ kind: "role", id: "legal" }, source());
  assert.deepEqual(r.recipients, ["u1@x", "u4@x"]);
});

test("userIds: an explicit list is deduped", async () => {
  const r = await resolveAudience({ kind: "userIds", ids: ["u1@x", "u1@x", "u2@x", ""] }, source());
  assert.deepEqual(r.recipients, ["u1@x", "u2@x"]);
});

test("all: expands to every user", async () => {
  const r = await resolveAudience({ kind: "all" }, source());
  assert.equal(r.recipients.length, 4);
});

test("unknown kind is refused by name", async () => {
  await assert.rejects(
    () => resolveAudience({ kind: "everyone-in-lex" }, source()),
    (e) => e instanceof AudienceError && e.code === "unknown-kind",
  );
});

test("a missing selector id is refused, not treated as 'all'", async () => {
  await assert.rejects(
    () => resolveAudience({ kind: "org" }, source()),
    (e) => e.code === "bad-selector",
  );
});

test("zero hits REFUSES — a broadcast reaching nobody must not read as success", async () => {
  await assert.rejects(
    () => resolveAudience({ kind: "org", id: "empty-org" }, source()),
    (e) => e instanceof AudienceError && e.code === "zero-hits",
  );
});

test("an unreachable identity source refuses rather than widening to everyone", async () => {
  // The dangerous alternative would be catching this and returning allUserIds().
  const broken = source({
    usersInOrg: async () => {
      throw new Error("logto unreachable");
    },
  });
  await assert.rejects(
    () => resolveAudience({ kind: "org", id: "lex-customers" }, broken),
    (e) => e.code === "identity-source-unavailable",
  );
});

test("platform internals smuggled into the selector are ignored", async () => {
  // cell dir / chat key must never become a delivery target.
  const r = await resolveAudience(
    { kind: "userIds", ids: ["u1@x"], cell: "0f483a072f22ae37", chatKey: "1:9", bindingId: "b_x" },
    source(),
  );
  assert.deepEqual(r.recipients, ["u1@x"], "only the declared ids are recipients");
});

test("describeAudience records what was ASKED, without expanding it", () => {
  assert.match(describeAudience({ kind: "org", id: "lex-customers" }), /lex-customers/);
  assert.match(describeAudience({ kind: "role", id: "legal" }), /legal/);
  assert.match(describeAudience({ kind: "userIds", ids: ["a", "b"] }), /2/);
  assert.match(describeAudience({ kind: "all" }), /全体/);
  assert.match(describeAudience({ kind: "weird" }), /未知/);
});