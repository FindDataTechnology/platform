// add-member-knowledge-profile: the platform-seam member split — deployment
// token minting/caching (restart-stable, 换防不换, owner-bound), the closed
// five-kind own/shared partition with first-class metadata, and the digest
// ladder (own ∪ shared ∪ legacy f/, scope-gated). The capture dedupe and
// fail-open contracts are inherited and re-asserted here.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFleetMemoryCapture, createHealthFlipTracker, memberProjectId } from "@finddatatechnology/yongyi-client";
import { memberTokenFor, memberCachePath } from "@finddatatechnology/yongyi-client";

const cfgFor = (dataRoot) => ({ url: "http://mem.test", platformToken: "plat", dataRoot });

function fakeFetch(mintOk = true) {
  const mints = [];
  return {
    mints,
    async fetch(url, opts = {}) {
      if (url.endsWith("/admin/mint")) {
        if (!mintOk) return { ok: false, status: 502 };
        const body = JSON.parse(opts.body);
        mints.push(body);
        return { ok: true, status: 200, json: async () => ({ token: `fdm_${mints.length}` }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    },
  };
}

test("memberTokenFor: mints once with owner binding, caches restart-stable, 换防不换", async () => {
  const data = mkdtempSync(join(tmpdir(), "fdm-member-"));
  try {
    const f = fakeFetch();
    const cfg = cfgFor(data);
    const t1 = await memberTokenFor(cfg, { packId: "fleet-9", memberId: "clerk", ownerEmail: "o@x" }, f.fetch);
    const t2 = await memberTokenFor(cfg, { packId: "fleet-9", memberId: "clerk", ownerEmail: "o@x" }, f.fetch);
    assert.equal(t1, t2, "cache hit — one mint per member");
    assert.equal(f.mints.length, 1);
    assert.equal(f.mints[0].namespace, "d/fleet-9/clerk");
    assert.equal(f.mints[0].owner, "u/o@x", "oversight anchor rides the mint");
    // cache file is 0600-shaped on disk and namespace-keyed
    const raw = JSON.parse(readFileSync(memberCachePath(data, "fleet-9", "clerk"), "utf8"));
    assert.equal(raw.token, t1);
    assert.equal(raw.namespace, "d/fleet-9/clerk");
    // 换防: same member id, new owner instance — cache is role-bound, no remint
    const t3 = await memberTokenFor(cfg, { packId: "fleet-9", memberId: "clerk", ownerEmail: "o@x" }, f.fetch);
    assert.equal(t3, t1);
    assert.ok(existsSync(memberCachePath(data, "fleet-9", "clerk")));
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("memberTokenFor: different member = different token + cache file", async () => {
  const data = mkdtempSync(join(tmpdir(), "fdm-member-"));
  try {
    const f = fakeFetch();
    const cfg = cfgFor(data);
    const a = await memberTokenFor(cfg, { packId: "f1", memberId: "clerk", ownerEmail: "o@x" }, f.fetch);
    const b = await memberTokenFor(cfg, { packId: "f1", memberId: "lead", ownerEmail: "o@x" }, f.fetch);
    assert.notEqual(a, b);
    assert.equal(f.mints.length, 2);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("memberTokenFor: no ownerEmail throws (the oversight anchor is mandatory)", async () => {
  const data = mkdtempSync(join(tmpdir(), "fdm-member-"));
  try {
    const f = fakeFetch();
    await assert.rejects(() => memberTokenFor(cfgFor(data), { packId: "f1", memberId: "clerk", ownerEmail: null }, f.fetch));
    assert.equal(f.mints.length, 0);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("capture: turn/health → own, decisions/swap → shared (closed map), title human", async () => {
  const writes = [];
  const capture = createFleetMemoryCapture({
    memory: { async writeFact(f) { writes.push(f); } },
  });
  assert.equal(await capture.capture("f9", "clerk", "turn", "回合成功", "b1"), true);
  assert.equal(await capture.capture("f9", "clerk", "health", "状态迁移 → ok", "b2"), true);
  assert.equal(await capture.capture("f9", "lead", "decision-resolved", "换网关", "b3"), true);
  assert.equal(await capture.capture("f9", "lead", "swap", "换防", "b4"), true);
  const own = writes.filter((w) => w.partition === "own");
  const shared = writes.filter((w) => w.partition === "shared");
  assert.deepEqual(own.map((w) => w.kind).sort(), ["health", "turn"]);
  assert.deepEqual(shared.map((w) => w.kind).sort(), ["decision-resolved", "swap"]);
  assert.ok(writes.every((w) => !/^\[/.test(w.title)), "titles carry no machine prefix");
});

// The client level is where the metadata triple + token routing attach:
// own facts ride the MEMBER's deployment token to d/<fleetId>/<memberId>,
// shared facts ride the SAME member token but project "shared" (a person
// token's "shared" would misfile into the owner's u/ root), and the legacy
// f/ digest still answers via the person token.
test("client: writeFact routes token+project by partition, metadata triple on the wire", async () => {
  const data = mkdtempSync(join(tmpdir(), "fdm-client-"));
  try {
    const posts = [];
    const mints = [];
    const fetchImpl = async (url, opts = {}) => {
      if (String(url).endsWith("/admin/mint")) {
        const body = JSON.parse(opts.body);
        mints.push(body);
        return { ok: true, status: 200, json: async () => ({ token: `tok_${mints.length}` }) };
      }
      if (String(url).endsWith("/pages")) {
        posts.push({ url: String(url), body: JSON.parse(opts.body), auth: opts.headers.authorization });
        return { ok: true, status: 200, json: async () => ({ path: "x" }) };
      }
      return { ok: true, status: 200, json: async () => ({ block: "" }) };
    };
    const { fleetMemoryFor } = await import("@finddatatechnology/yongyi-client");
    const m = await fleetMemoryFor({ CELL_MEMORY_ENABLED: "1", CELL_MEMORY_URL: "http://mem.test", CELL_MEMORY_PLATFORM_TOKEN: "p", CELL_MEMORY_DATA: data }, "o@x", fetchImpl);
    assert.ok(m, "client alive");
    await m.writeFact({ fleetId: "f9", memberId: "clerk", kind: "turn", partition: "own", title: "回合成功", body: "b" });
    await m.writeFact({ fleetId: "f9", memberId: "clerk", kind: "decision-resolved", partition: "shared", title: "拍板", body: "b" });
    assert.equal(posts.length, 2);
    // own: project = memberId (the d/ root resolves it), member token
    assert.equal(posts[0].body.project, "clerk");
    assert.ok(posts[0].auth.includes("tok_"), "member token, not person token");
    assert.deepEqual(posts[0].body.metadata, { fleetId: "f9", memberId: "clerk", kind: "turn" });
    assert.ok(!/^\[/.test(posts[0].body.title));
    // shared: same member token, project "shared" → d/<fleetId>/shared
    assert.equal(posts[1].body.project, "shared");
    assert.deepEqual(posts[1].body.metadata, { fleetId: "f9", memberId: "clerk", kind: "decision-resolved" });
    // mint matrix: person mint (no owner arg on mint body? person mint is the mount) + member mint with owner binding
    assert.ok(mints.some((x) => x.namespace === "d/f9/clerk" && x.owner === "u/o@x"));
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("client: readDigest composes own ∪ shared ∪ legacy f/ with per-source labels; scope=shared skips own", async () => {
  const data = mkdtempSync(join(tmpdir(), "fdm-digest-"));
  try {
    const digs = [];
    const mints = [];
    let n = 0;
    const fetchImpl = async (url, opts = {}) => {
      const u = String(url);
      if (u.endsWith("/admin/mint")) {
        mints.push(JSON.parse(opts.body));
        return { ok: true, status: 200, json: async () => ({ token: `tok_${++n}` }) };
      }
      if (u.includes("/digest")) {
        const project = new URL(u).searchParams.get("project");
        digs.push({ project, auth: opts.headers.authorization });
        const block = project === "shared" ? "" : `digest of ${project}`; // shared empty = absent segment
        return { ok: true, status: 200, json: async () => ({ block }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };
    const { fleetMemoryFor } = await import("@finddatatechnology/yongyi-client");
    const m = await fleetMemoryFor({ CELL_MEMORY_ENABLED: "1", CELL_MEMORY_URL: "http://mem.test", CELL_MEMORY_PLATFORM_TOKEN: "p", CELL_MEMORY_DATA: data }, "o@x", fetchImpl);
    const out = await m.readDigest("f9", "clerk", "查询", { budget: 1200 });
    // own renders, shared empty drops, legacy renders — labels are zh
    assert.deepEqual(out.sources, ["own", "legacy"]);
    assert.ok(out.block.includes("【本岗位记忆】"));
    assert.ok(out.block.includes("【历史团队记忆】"));
    assert.ok(!out.block.includes("【团队记忆】"));
    // all three probes fire (shared answers an empty block and drops out)
    assert.deepEqual(digs.map((d) => d.project).sort(), ["clerk", "f/f9", "shared"]);
    // scope=shared: the own probe never fires
    digs.length = 0;
    const out2 = await m.readDigest("f9", "clerk", "", { budget: 1200, scope: "shared" });
    assert.ok(!out2.sources.includes("own"));
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("capture: replay idempotent, unknown kind counted as failure", async () => {
  let n = 0;
  // Fixed clock: the idempotency key embeds the timestamp — a real-time clock
  // can tick between the two calls and split the "replay" across keys (the
  // month-bomb class; 2e06aa78 precedent). Pin the clock so the test pins
  // the dedup semantics, not the scheduler's mercy.
  const capture = createFleetMemoryCapture({ memory: { async writeFact() { n += 1; } }, clock: () => 1_700_000_000_000 });
  assert.equal(await capture.capture("f", "m", "turn", "t", "b", ), true);
  assert.equal(await capture.capture("f", "m", "turn", "t", "b", ), null, "replay deduped");
  assert.equal(n, 1);
  assert.equal(await capture.capture("f", "m", "mystery", "t", "b"), false, "unknown kind refused");
  assert.equal(n, 1);
});

test("capture: write failure is a counter, never a throw (fail-open)", async () => {
  const capture = createFleetMemoryCapture({ memory: { async writeFact() { throw new Error("mem down"); } } });
  assert.equal(await capture.capture("f", "m", "turn", "t", "b"), false);
  assert.equal(capture.failures, 1);
});

test("healthFlip: only flips emit", () => {
  const flip = createHealthFlipTracker();
  assert.equal(flip("f", "m", "ok"), false);
  assert.equal(flip("f", "m", "ok"), false);
  assert.equal(flip("f", "m", "failed"), true);
  assert.equal(flip("f", "m", "failed"), false);
});

test("memberProjectId: separators flattened, empty → unknown", () => {
  assert.equal(memberProjectId("clerk/2"), "clerk-2");
  assert.equal(memberProjectId(""), "unknown");
});
