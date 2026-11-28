// Unit tests — visitor → actor registration (add-served-agent-connector-access D4).
// Run: node --test scripts/test-visitor-actor-registry.mjs
//
// What is being pinned, and why each one matters on its own:
//
//   1.x  three states stay three. `missing` (nobody registered) must never
//        answer `anonymous` (the facade said this visitor has no identity):
//        the first is a broken link, the second is a product fact. Collapsing
//        them is how "registration is down" silently becomes "run as the
//        deployer" — the false success this change exists to remove.
//   2.x  the key is per deployment. A visitor's scope derives from their
//        subject alone, so the same person carries it into every deployment;
//        one deployment's registration must not answer another's turn.
//   3.x  the TTL is real. Expiry is `missing`, never `anonymous`.
//   4.x  registrations are refreshed at every turn start (that is what keeps a
//        multi-hour conversation alive), and re-registering moves the entry to
//        the eviction tail.
//   5.x  garbage in is refused rather than stored: an unhashed subject would
//        put a raw identifier in the serving plane, which C2 forbids.

import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_VISITOR_ACTOR_TTL_MS,
  VISITOR_ACTOR_MAX,
  createVisitorActorRegistry,
  isVisitorScope,
  visitorActorKey,
} from "../lib/visitor-actor-registry.js";

const SCOPE = "0123456789abcdef0123456789abcdef"; // sha256(...).slice(0, 32)
const OTHER_SCOPE = "fedcba9876543210fedcba9876543210";
const DEPLOY = { packId: "pack-1", agentId: "agent-1" };

/** A registry over a hand-driven clock. */
function makeRegistry(opts = {}) {
  let at = 1_000_000;
  const registry = createVisitorActorRegistry({ now: () => at, ...opts });
  return {
    registry,
    advance(ms) {
      at += ms;
    },
    get now() {
      return at;
    },
  };
}

test("1.1 an unregistered scope is `missing`, never `anonymous`", () => {
  const { registry } = makeRegistry();
  assert.deepEqual(registry.lookup({ ...DEPLOY, scope: SCOPE }), { state: "missing" });
});

test("1.2 an explicit null actor is `anonymous` — a positive statement, not an absence", () => {
  const { registry } = makeRegistry();
  assert.deepEqual(registry.register({ ...DEPLOY, scope: SCOPE, actor: null }), { ok: true });
  assert.deepEqual(registry.lookup({ ...DEPLOY, scope: SCOPE }), { state: "anonymous" });
});

test("1.3 a registered actor comes back verbatim", () => {
  const { registry } = makeRegistry();
  registry.register({ ...DEPLOY, scope: SCOPE, actor: "oidc-sub-42" });
  assert.deepEqual(registry.lookup({ ...DEPLOY, scope: SCOPE }), { state: "registered", actor: "oidc-sub-42" });
});

test("1.4 `missing` and `anonymous` are distinguishable in one registry side by side", () => {
  const { registry } = makeRegistry();
  registry.register({ ...DEPLOY, scope: SCOPE, actor: null });
  // Both keys exist in the same map at the same instant; only one was said.
  assert.equal(registry.lookup({ ...DEPLOY, scope: SCOPE }).state, "anonymous");
  assert.equal(registry.lookup({ ...DEPLOY, scope: OTHER_SCOPE }).state, "missing");
});

test("2.1 the same scope under another deployment does not answer", () => {
  const { registry } = makeRegistry();
  registry.register({ packId: "pack-1", agentId: "agent-1", scope: SCOPE, actor: "sub-a" });
  assert.equal(registry.lookup({ packId: "pack-2", agentId: "agent-1", scope: SCOPE }).state, "missing");
  assert.equal(registry.lookup({ packId: "pack-1", agentId: "agent-2", scope: SCOPE }).state, "missing");
});

test("2.2 agentPath disambiguates two deployments of the same agent", () => {
  const { registry } = makeRegistry();
  registry.register({ ...DEPLOY, agentPath: "packs/p/a@1", scope: SCOPE, actor: "sub-a" });
  registry.register({ ...DEPLOY, agentPath: "packs/p/a@2", scope: SCOPE, actor: "sub-b" });
  assert.deepEqual(registry.lookup({ ...DEPLOY, agentPath: "packs/p/a@1", scope: SCOPE }), {
    state: "registered",
    actor: "sub-a",
  });
  assert.deepEqual(registry.lookup({ ...DEPLOY, agentPath: "packs/p/a@2", scope: SCOPE }), {
    state: "registered",
    actor: "sub-b",
  });
  assert.equal(registry.lookup({ ...DEPLOY, scope: SCOPE }).state, "missing");
});

test("3.1 expiry reads as `missing`, never `anonymous`", () => {
  const { registry, advance } = makeRegistry({ ttlMs: 60_000 });
  registry.register({ ...DEPLOY, scope: SCOPE, actor: null });
  assert.equal(registry.lookup({ ...DEPLOY, scope: SCOPE }).state, "anonymous");
  advance(60_001);
  assert.equal(registry.lookup({ ...DEPLOY, scope: SCOPE }).state, "missing");
});

test("3.2 the default TTL outlasts any configurable turn budget", () => {
  // A turn that outlives its registration would fail closed mid-conversation.
  assert.ok(DEFAULT_VISITOR_ACTOR_TTL_MS >= 60 * 60_000);
});

test("4.1 re-registering refreshes the expiry", () => {
  const { registry, advance } = makeRegistry({ ttlMs: 60_000 });
  registry.register({ ...DEPLOY, scope: SCOPE, actor: "sub-a" });
  advance(50_000);
  registry.register({ ...DEPLOY, scope: SCOPE, actor: "sub-a" });
  advance(50_000);
  // 100s after the first write, 50s after the second: still live.
  assert.deepEqual(registry.lookup({ ...DEPLOY, scope: SCOPE }), { state: "registered", actor: "sub-a" });
});

test("4.2 a later turn may correct the actor (the visitor changed account)", () => {
  const { registry } = makeRegistry();
  registry.register({ ...DEPLOY, scope: SCOPE, actor: "sub-a" });
  registry.register({ ...DEPLOY, scope: SCOPE, actor: "sub-b" });
  assert.deepEqual(registry.lookup({ ...DEPLOY, scope: SCOPE }), { state: "registered", actor: "sub-b" });
});

test("4.3 the map is bounded: at capacity the oldest entry is evicted, newest survives", () => {
  const { registry } = makeRegistry({ maxEntries: 2 });
  const a = "a".repeat(32);
  const b = "b".repeat(32);
  const c = "c".repeat(32);
  registry.register({ ...DEPLOY, scope: a, actor: "sub-a" });
  registry.register({ ...DEPLOY, scope: b, actor: "sub-b" });
  registry.register({ ...DEPLOY, scope: c, actor: "sub-c" });
  assert.equal(registry.size, 2);
  assert.equal(registry.lookup({ ...DEPLOY, scope: a }).state, "missing");
  assert.equal(registry.lookup({ ...DEPLOY, scope: c }).state, "registered");
});

test("4.4 touching an entry moves it to the eviction tail", () => {
  const { registry } = makeRegistry({ maxEntries: 2 });
  const a = "a".repeat(32);
  const b = "b".repeat(32);
  const c = "c".repeat(32);
  registry.register({ ...DEPLOY, scope: a, actor: "sub-a" });
  registry.register({ ...DEPLOY, scope: b, actor: "sub-b" });
  registry.register({ ...DEPLOY, scope: a, actor: "sub-a" }); // refresh a
  registry.register({ ...DEPLOY, scope: c, actor: "sub-c" }); // evicts b
  assert.equal(registry.lookup({ ...DEPLOY, scope: a }).state, "registered");
  assert.equal(registry.lookup({ ...DEPLOY, scope: b }).state, "missing");
});

test("5.1 an unhashed subject is refused — C2 forbids a raw identifier here", () => {
  const { registry } = makeRegistry();
  assert.deepEqual(registry.register({ ...DEPLOY, scope: "user@example.com", actor: "sub-a" }), {
    ok: false,
    code: "invalid_scope",
  });
  assert.deepEqual(registry.register({ ...DEPLOY, scope: "", actor: "sub-a" }), { ok: false, code: "invalid_scope" });
  assert.equal(registry.size, 0);
});

test("5.2 a blank or over-long actor is refused", () => {
  const { registry } = makeRegistry();
  assert.deepEqual(registry.register({ ...DEPLOY, scope: SCOPE, actor: "   " }), { ok: false, code: "invalid_actor" });
  assert.deepEqual(registry.register({ ...DEPLOY, scope: SCOPE, actor: "x".repeat(VISITOR_ACTOR_MAX + 1) }), {
    ok: false,
    code: "invalid_actor",
  });
  assert.equal(registry.size, 0);
});

test("5.3 registration needs a deployment identity", () => {
  const { registry } = makeRegistry();
  assert.deepEqual(registry.register({ packId: "", agentId: "a", scope: SCOPE, actor: "sub" }), {
    ok: false,
    code: "deployment_identity_required",
  });
});

test("5.4 forget drops exactly one registration", () => {
  const { registry } = makeRegistry();
  registry.register({ ...DEPLOY, scope: SCOPE, actor: "sub-a" });
  registry.forget({ ...DEPLOY, scope: SCOPE });
  assert.equal(registry.lookup({ ...DEPLOY, scope: SCOPE }).state, "missing");
});

test("scope shape and key shape are stable contracts", () => {
  assert.equal(isVisitorScope(SCOPE), true);
  assert.equal(isVisitorScope("short"), false);
  assert.equal(isVisitorScope(null), false);
  assert.equal(
    visitorActorKey({ packId: "p", agentId: "a", scope: SCOPE }),
    ["p", "a", "", SCOPE].join("\u0000"),
  );
});
