// Tests for the `bench` ability declaration (openspec: add-pack-bench-ability).
//
// Run: node --test scripts/test-pack-bench.mjs
//
// Each assertion has a negative case below it — a rule that has never failed is
// a wish, not a gate.

import test from "node:test";
import assert from "node:assert/strict";

import { validateBench } from "../lib/pack-bench.js";
import { validatePackManifest } from "../lib/pack-manifest.js";
import { deriveCapabilities } from "../lib/capability-layer.js";
import { derivePillars } from "../lib/pack-pillars.js";
import { installBenchEntry } from "../lib/bench-ability.js";
import { benchStoreView, resolveStore, enrollFleet } from "../lib/bench-store.js";

const SOURCE = { tier: "official", name: "erp-base", version: 3, digest: "a".repeat(64) };

const VALID_USE = {
  mode: "use",
  assets: ["ontology", "ruler"],
  source: SOURCE,
  store: { home: "platform" },
};

const VALID_FORK = {
  mode: "fork",
  assets: ["ontology"],
  source: SOURCE,
  store: { home: "customer" },
  fork: { diff: { added: ["project"] } },
};

const SHARED_ENVELOPE = {
  kind: "ontology-template",
  name: "erp-base",
  version: 3,
  digest: "a".repeat(64),
  payload: { entity_types: ["company"] },
};

const VALID_SHARE = {
  mode: "share",
  assets: ["ontology", "gold"],
  source: SOURCE,
  store: { home: "customer" },
  share: { visibility: "tenant", asset_classes: ["ontology"], envelopes: [SHARED_ENVELOPE] },
};

test("valid use/fork/share declarations pass", () => {
  for (const block of [VALID_USE, VALID_FORK, VALID_SHARE]) {
    assert.deepEqual(validateBench(block), []);
  }
});

test("store.home that looks like a DSN is refused as a boundary, not a typo", () => {
  const errors = validateBench({ ...VALID_USE, store: { home: "postgres://db/x" } });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "bench_store_home_addressed");
  assert.match(errors[0].error, /address/);
});

test("mode=use rejects fork/share fields", () => {
  const errors = validateBench({ ...VALID_USE, fork: { diff: { x: 1 } } });
  assert.ok(errors.some((e) => e.code === "bench_mode_fields_mismatch"));
});

test("fork without a written difference is refused", () => {
  const block = { ...VALID_FORK, fork: {} };
  const errors = validateBench(block);
  assert.ok(errors.some((e) => e.code === "bench_fork_diff_missing"));
});

test("share.asset_classes must be declared in assets", () => {
  const errors = validateBench({ ...VALID_SHARE, share: { visibility: "public", asset_classes: ["ruler"] } });
  assert.ok(errors.some((e) => e.code === "bench_share_class_not_declared"));
});

test("source must be pinned by name + version + digest", () => {
  const errors = validateBench({ ...VALID_USE, source: { tier: "official", name: "x" } });
  assert.ok(errors.some((e) => e.code === "bench_source_version_invalid"));
  assert.ok(errors.some((e) => e.code === "bench_source_digest_invalid"));
});

test("unknown keys are named, never silently ignored", () => {
  const errors = validateBench({ ...VALID_USE, dsn: "x" });
  assert.ok(errors.some((e) => e.code === "bench_key_unknown"));
});

test("a manifest without bench is unchanged; with bench it validates", () => {
  const base = {
    name: "demo",
    description: "demo pack",
    skills: [{ name: "s", description: "d", content: "# s" }],
  };
  assert.deepEqual(validatePackManifest(base), []);
  assert.deepEqual(validatePackManifest({ ...base, bench: VALID_USE }), []);
  assert.ok(validatePackManifest({ ...base, bench: { mode: "nope" } }).length > 0);
});

test("the capability layer exposes one bench entry per asset", () => {
  const result = deriveCapabilities({ bench: VALID_USE, name: "demo" });
  const bench = result.capabilities.filter((c) => c.kind === "bench");
  assert.equal(bench.length, 2);
  assert.ok(bench.every((c) => c.origin === "pack" && c.name.includes("erp-base")));
});

test("the bench pillar distinguishes declared from executed", () => {
  const present = derivePillars({ bench: VALID_SHARE });
  assert.equal(present.bench.state, "present");
  assert.equal(present.bench.rows["share.asset_classes"].executed, false);
  assert.equal(present.bench.rows["store.home"].executed, true);

  const undeclared = derivePillars({});
  assert.equal(undeclared.bench.state, "undeclared");

  const broken = derivePillars({ bench: { mode: "nope" } });
  assert.equal(broken.bench.state, "invalid");
  assert.ok(broken.bench.errors.length > 0);
});

test("install reports awaiting-store-binding when no store is configured", async () => {
  const item = await installBenchEntry({ manifest: { bench: VALID_FORK }, db: null, env: {} });
  assert.equal(item.status, "awaiting-store-binding");
  assert.match(item.reason, /deployment binding/);
});

test("install reports the store's conformance failure, never bound", async () => {
  const item = await installBenchEntry({
    manifest: { bench: VALID_USE },
    env: { TOKEN: "t" },
    hooks: {
      resolveBenchStore: () => ({
        id: "s1",
        home: "platform",
        base_url: "http://bench.invalid",
        token_env_ref: "TOKEN",
        conformance_status: "failed",
      }),
    },
  });
  assert.equal(item.status, "conformance-failed");
});

test("share with no store binding is absent, not silently accepted", async () => {
  const item = await installBenchEntry({ manifest: { bench: VALID_SHARE }, env: {} });
  assert.equal(item.status, "awaiting-store-binding");
});

test("use with an unreachable store is unreachable, not bound", async (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("ECONNREFUSED");
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  const item = await installBenchEntry({
    manifest: { bench: VALID_USE },
    env: { TOKEN: "t" },
    hooks: {
      resolveBenchStore: () => ({
        id: "s1",
        home: "platform",
        base_url: "http://bench.invalid",
        token_env_ref: "TOKEN",
        conformance_status: "pass",
      }),
    },
  });
  assert.equal(item.status, "unreachable");
});

test("a digest mismatch is missing, not bound", async (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ kind: "ontology-template", digest: "b".repeat(64) }),
  });
  t.after(() => {
    globalThis.fetch = original;
  });
  const item = await installBenchEntry({
    manifest: { bench: VALID_USE },
    env: { TOKEN: "t" },
    hooks: {
      resolveBenchStore: () => ({
        id: "s1",
        home: "platform",
        base_url: "http://bench.invalid",
        token_env_ref: "TOKEN",
        conformance_status: "pass",
      }),
    },
  });
  assert.equal(item.status, "missing");
  assert.match(item.reason, /different digest/);
});

test("fork reads from the platform store and writes into the customer store", async (t) => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, method: init?.method ?? "GET" });
    if ((init?.method ?? "GET") === "GET") {
      return { ok: true, status: 200, json: async () => ({ digest: SOURCE.digest, payload: {} }) };
    }
    return { ok: true, status: 200, json: async () => ({ created: true }) };
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  const stores = {
    platform: { id: "p", home: "platform", base_url: "http://platform.invalid", token_env_ref: "P", conformance_status: "pass" },
    customer: { id: "c", home: "customer", base_url: "http://customer.invalid", token_env_ref: "C", conformance_status: "pass" },
  };
  const item = await installBenchEntry({
    manifest: { bench: VALID_FORK },
    env: { P: "pt", C: "ct" },
    hooks: { resolveBenchStore: ({ home }) => stores[home] },
  });
  assert.equal(item.status, "forked");
  assert.match(calls[0].url, /platform\.invalid\/api\/v1\/assets\/ontology\/export/);
  assert.match(calls[1].url, /customer\.invalid\/api\/v1\/assets\/import/);
});

test("the store read face exposes only the token's last 4 chars", () => {
  const row = {
    id: "c1",
    home: "customer",
    adapter_system: "law-bench",
    base_url: "http://bench.invalid",
    token_env_ref: "BENCH_TOKEN",
    conformance_status: "pass",
    created_at: "2026-01-01",
  };
  const view = benchStoreView(row, { BENCH_TOKEN: "supersecret-9876" });
  assert.equal(view.token_hint, "…9876");
  assert.equal(view.token_configured, true);
  assert.equal(JSON.stringify(view).includes("supersecret"), false);

  const unset = benchStoreView(row, {});
  assert.equal(unset.token_hint, null);
  assert.equal(unset.token_configured, false);
});

test("a share without its assets is refused", () => {
  const errors = validateBench({ ...VALID_SHARE, share: { visibility: "tenant", asset_classes: ["ontology"] } });
  assert.ok(errors.some((e) => e.code === "bench_share_envelopes_missing"));
});

test("a shared envelope outside asset_classes is refused", () => {
  const errors = validateBench({
    ...VALID_SHARE,
    share: { visibility: "tenant", asset_classes: ["gold"], envelopes: [SHARED_ENVELOPE] },
  });
  assert.ok(errors.some((e) => e.code === "bench_share_envelope_class_not_shared"));
});

test("share installs its embedded envelopes into the declared store", async (t) => {
  const posts = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    posts.push(url);
    return { ok: true, status: 200, json: async () => ({ created: true }) };
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  const item = await installBenchEntry({
    manifest: { bench: VALID_SHARE },
    env: { C: "ct" },
    hooks: {
      resolveBenchStore: () => ({
        id: "c1",
        home: "customer",
        base_url: "http://customer.invalid",
        token_env_ref: "C",
        conformance_status: "pass",
      }),
    },
  });
  assert.equal(item.status, "forked");
  assert.equal(posts.length, 1);
  assert.match(posts[0], /customer\.invalid\/api\/v1\/assets\/import/);
});

test("re-installing a share is bound when the store already has it", async (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ created: false }) });
  t.after(() => {
    globalThis.fetch = original;
  });
  const item = await installBenchEntry({
    manifest: { bench: VALID_SHARE },
    env: { C: "ct" },
    hooks: {
      resolveBenchStore: () => ({
        id: "c1",
        home: "customer",
        base_url: "http://customer.invalid",
        token_env_ref: "C",
        conformance_status: "pass",
      }),
    },
  });
  assert.equal(item.status, "bound");
});

test("an optional domain must be a key, not an address", () => {
  assert.deepEqual(validateBench({ ...VALID_USE, domain: "legal" }), []);
  const errors = validateBench({ ...VALID_USE, domain: "https://bench/x" });
  assert.ok(errors.some((e) => e.code === "bench_domain_invalid"));
});

test("enrollFleet returns the one-time token and treats 409 as already-enrolled", async (t) => {
  const original = globalThis.fetch;
  let reply = { ok: true, status: 200, json: async () => ({ token: "flt_new", fleet_ref: "f1" }) };
  globalThis.fetch = async () => reply;
  t.after(() => {
    globalThis.fetch = original;
  });
  const store = { base_url: "http://bench.invalid", token_env_ref: "T" };
  const out = await enrollFleet(store, "fda_x", { fleetRef: "f1", domain: "legal" });
  assert.equal(out.ok, true);
  assert.equal(out.token, "flt_new");
  reply = { ok: false, status: 409, json: async () => ({ detail: "already" }) };
  const again = await enrollFleet(store, "fda_x", { fleetRef: "f1", domain: "legal" });
  assert.equal(again.ok, false);
  assert.equal(again.status, "already-enrolled");
});

test("the env store binding serves only its declared home", () => {
  const env = { BENCH_STORE_URL: "http://bench.invalid/", BENCH_STORE_HOME: "platform" };
  const platform = resolveStore("platform", { env });
  assert.equal(platform.base_url, "http://bench.invalid");
  assert.equal(platform.token_env_ref, "BENCH_STORE_TOKEN");
  // A customer declaration must NOT fall back to the platform store.
  assert.equal(resolveStore("customer", { env }), null);
});

test("a per-cell row wins over the env binding", () => {
  const db = {
    prepare: () => ({ get: () => ({ id: "row", home: "platform", base_url: "http://row.invalid", token_env_ref: "T" }) }),
  };
  const store = resolveStore("platform", { db, env: { BENCH_STORE_URL: "http://env.invalid" } });
  assert.equal(store.id, "row");
});

test("a law-bench API key rides X-API-Key; other tokens ride Bearer", async (t) => {
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push(init?.headers ?? {});
    return { ok: true, status: 200, json: async () => ({ digest: "a".repeat(64) }) };
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  const { probeSource } = await import("../lib/bench-store.js");
  const store = { base_url: "http://bench.invalid", token_env_ref: "T" };
  await probeSource(store, "lbk_abc", { asset: "ontology", source: SOURCE });
  await probeSource(store, "fda_abc", { asset: "ontology", source: SOURCE });
  await probeSource(store, "plain-token", { asset: "ontology", source: SOURCE });
  assert.equal(seen[0]["X-API-Key"], "lbk_abc");
  assert.equal(seen[0].Authorization, undefined);
  assert.equal(seen[1]["X-Consumer-Token"], "fda_abc");
  assert.equal(seen[1]["X-API-Key"], undefined);
  assert.equal(seen[2].Authorization, "Bearer plain-token");
  assert.equal(seen[2]["X-API-Key"], undefined);
  assert.equal(seen[2]["X-Consumer-Token"], undefined);
});

test("a matching digest is bound", async (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ kind: "ontology-template", digest: SOURCE.digest }),
  });
  t.after(() => {
    globalThis.fetch = original;
  });
  const item = await installBenchEntry({
    manifest: { bench: VALID_USE },
    env: { TOKEN: "t" },
    hooks: {
      resolveBenchStore: () => ({
        id: "s1",
        home: "platform",
        base_url: "http://bench.invalid",
        token_env_ref: "TOKEN",
        conformance_status: "pass",
      }),
    },
  });
  assert.equal(item.status, "bound");
});
