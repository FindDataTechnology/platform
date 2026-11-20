// Caller identity adapters (openspec: add-team-as-a2a-agent, 2.1–2.2).
//
// The property under test is not "a token resolves" but "nothing else can":
//   • no credential, an expired one, and a credential of the wrong shape each
//     return `{ok:false}` — never a caller;
//   • an EMPTY registry returns `{ok:false}` (proving there is no default
//     identity branch to fall through to);
//   • an adapter that throws or claims without producing a subject is refused,
//     not trusted;
//   • a source scan forbids the fallback idioms (`?? owner`, `|| "system"`, …)
//     anywhere in the module — the shape of the code, not just its behavior.
//
// The last one matters because the failure the spec forbids is a *future* edit
// adding one `??`. Behavior tests cannot see that edit; a scan can.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const {
  createCallerIdentity,
  createPlatformCallerIdentity,
  IDENTITY_FAILURES,
  CALLER_KINDS,
} = await import("../server/caller-identity.js");

const ROOT = path.resolve(import.meta.dirname, "..");
const SOURCE = fs.readFileSync(path.join(ROOT, "server/caller-identity.js"), "utf8");

// ── 2.1 registry shape ─────────────────────────────────────────────────────

test("an empty registry refuses everyone: there is no default caller", async () => {
  const identity = createCallerIdentity({ adapters: [] });
  assert.deepEqual(identity.ids, []);
  const out = await identity.resolve({ headers: { authorization: "Bearer whatever" }, session: { email: "a@x.test" } });
  assert.equal(out.ok, false, "an empty registry must not fall back to the provided session");
  assert.equal(out.code, "unauthorized");
  assert.equal(out.reason, "no_adapter");
});

test("no credential, expired credential, and wrong-shaped credential all fail closed", async () => {
  let calls = 0;
  const identity = createPlatformCallerIdentity({
    resolveSession: () => {
      calls += 1;
      // A resolver that would hand out an identity for anything — the adapter
      // must never even call it without a credential present.
      return { email: "should-never-be-used@x.test" };
    },
  });

  const missing = await identity.resolve({ headers: {}, session: null });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, "missing");
  assert.equal(calls, 0, "no resolver call without a credential");

  const malformed = await identity.resolve({ headers: { authorization: "Basic abc" }, session: null });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.reason, "malformed");
  assert.equal(calls, 0);

  const expired = await createPlatformCallerIdentity({ resolveSession: () => null }).resolve({
    headers: { authorization: "Bearer expired-token" },
    session: null,
  });
  assert.equal(expired.ok, false);
  assert.equal(expired.reason, "invalid_or_expired");
  assert.equal(expired.code, "unauthorized");
});

test("an adapter that throws is a refusal, never a 500 and never an identity", async () => {
  const identity = createCallerIdentity({
    adapters: [{ id: "boom", kind: "session", resolve: () => { throw new Error("kaboom"); } }],
  });
  const out = await identity.resolve({ headers: { authorization: "Bearer x" } });
  assert.equal(out.ok, false);
  assert.equal(out.code, "unauthorized");
});

test("an adapter that claims a request but yields no subject is refused", async () => {
  const identity = createCallerIdentity({
    adapters: [{ id: "hollow", kind: "session", resolve: () => ({ ok: true, caller: {} }) }],
  });
  const out = await identity.resolve({ headers: {} });
  assert.equal(out.ok, false);
  assert.equal(out.reason, "malformed");
});

test("adapters are tried in order and a null answer moves on", async () => {
  const seen = [];
  const identity = createCallerIdentity({
    adapters: [
      { id: "first", kind: "registry", resolve: () => { seen.push("first"); return null; } },
      { id: "second", kind: "session", resolve: () => { seen.push("second"); return { ok: true, caller: { kind: "session", subject: "b@x.test" } }; } },
    ],
  });
  const out = await identity.resolve({ headers: {} });
  assert.deepEqual(seen, ["first", "second"]);
  assert.equal(out.ok, true);
  assert.equal(out.caller.subject, "b@x.test");
  assert.equal(out.adapter, "second");
  assert.equal(CALLER_KINDS.includes(out.caller.kind), true);
});

// ── 2.2 the platform session adapter ──────────────────────────────────────

test("a valid platform session resolves to a caller that survives to the record", async () => {
  const identity = createPlatformCallerIdentity({
    resolveSession: ({ headers }) =>
      headers.authorization === "Bearer good" ? { email: "caller@x.test", groups: ["staff"] } : null,
  });
  const out = await identity.resolve({ headers: { authorization: "Bearer good" }, session: null });
  assert.equal(out.ok, true);
  assert.deepEqual(out.caller, { kind: "session", subject: "caller@x.test", groups: ["staff"] });

  // A session already resolved by the route's middleware is used directly —
  // one resolution per request, no second token verify.
  const reused = await identity.resolve({ headers: {}, session: { email: "m@x.test", groups: [] } });
  assert.equal(reused.ok, true);
  assert.equal(reused.caller.subject, "m@x.test");
});

test("the reason vocabulary is closed", async () => {
  const identity = createPlatformCallerIdentity({ resolveSession: () => null });
  for (const headers of [{}, { authorization: "Basic x" }, { authorization: "Bearer bad" }]) {
    const out = await identity.resolve({ headers, session: null });
    assert.equal(IDENTITY_FAILURES.includes(out.reason), true, `unexpected reason ${out.reason}`);
  }
  assert.deepEqual([...IDENTITY_FAILURES].sort(), ["invalid_or_expired", "malformed", "missing", "no_adapter"]);
});

test("the source contains no default-identity fallback", () => {
  // The spec's red line, as a shape assertion. A legitimate `?? []` for groups
  // stays allowed; what may never appear is a fallback that produces a SUBJECT.
  const banned = [
    /\?\?\s*["'][^"']*@/, // ?? "someone@…"
    /\|\|\s*["'](owner|system|admin|anonymous)["']/i, // || "owner"
    /caller\.subject\s*\?\?\s*["']/, // subject ?? "…"
    /subject\s*=\s*[^;]*\?\?[^;]*(owner|admin|system)/i,
  ];
  for (const re of banned) {
    assert.equal(re.test(SOURCE), false, `forbidden fallback idiom in caller-identity.js: ${re}`);
  }
  // And the registry must not CONSTRUCT a caller: passing an adapter's caller
  // through is the only legal way out `resolve()`. Building one here would be
  // the default-identity branch in disguise.
  const adapterless = SOURCE.split("async resolve(")[1] ?? "";
  const resolveBody = adapterless.split("\n    },\n")[0] ?? "";
  assert.equal(/\bkind:\s*["']/.test(resolveBody), false, "resolve() must not construct a caller{kind}");
  assert.equal(/\bsubject:\s*/.test(resolveBody), false, "resolve() must not construct a subject");
});
