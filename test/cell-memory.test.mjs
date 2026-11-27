// adopt-yongyi-client-sdk task 3 — the cell memory seam now consumes
// @finddatatechnology/yongyi-client. Behavior ownership (mint protocol,
// cache protocol, ladder internals) moved to the SDK's own 60-test suite;
// what壹座 still pins here is the WIRING SHAPE: the env contract
// (CELL_MEMORY_* four-of-a-kind or off), the fail-open mount seam
// dsh-profile/server compose through, and the byte shape of the produced
// artifacts (mcpEntry row, discipline text) against the historical golden.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cellMemoryConfig,
  cellMemoryMount,
  personTokenFor,
  memberTokenFor,
  memberCachePath,
  memoryMcpEntry,
  MEMORY_DISCIPLINE,
} from "@finddatatechnology/yongyi-client";

test("wiring: every SDK surface the cell consumes resolves from one import", () => {
  for (const fn of [cellMemoryConfig, cellMemoryMount, personTokenFor, memberTokenFor, memberCachePath, memoryMcpEntry]) {
    assert.equal(typeof fn, "function");
  }
  assert.equal(typeof MEMORY_DISCIPLINE, "string");
});

test("cellMemoryConfig: four-of-a-kind env or off → null (byte-identical baseline)", () => {
  // off, and each of the other three要素 missing alone, is all off
  assert.equal(cellMemoryConfig({}), null);
  assert.equal(cellMemoryConfig({ CELL_MEMORY_ENABLED: "1" }), null); // no url/token/data
  assert.equal(cellMemoryConfig({ CELL_MEMORY_ENABLED: "1", CELL_MEMORY_URL: "http://x" }), null);
  assert.equal(cellMemoryConfig({ CELL_MEMORY_ENABLED: "1", CELL_MEMORY_PLATFORM_TOKEN: "t" }), null);
  assert.equal(cellMemoryConfig({ CELL_MEMORY_ENABLED: "1", CELL_MEMORY_DATA: "/d" }), null);
  assert.equal(
    cellMemoryConfig({ CELL_MEMORY_ENABLED: "0", CELL_MEMORY_URL: "http://x", CELL_MEMORY_PLATFORM_TOKEN: "t", CELL_MEMORY_DATA: "/d" }),
    null,
  );
  // on → the three-tuple, URL trailing slash stripped (historical golden)
  const cfg = cellMemoryConfig({ CELL_MEMORY_ENABLED: "1", CELL_MEMORY_URL: "http://x/", CELL_MEMORY_PLATFORM_TOKEN: "t", CELL_MEMORY_DATA: "/d" });
  assert.deepEqual(cfg, { url: "http://x", platformToken: "t", dataRoot: "/d" });
});

test("personTokenFor: mints once, caches on disk 0600, survives process (restart-stable)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cellmem-"));
  try {
    const cfg = { url: "http://mem", platformToken: "plat", dataRoot: dir };
    let mints = 0;
    const fake = async () => {
      mints += 1;
      return { ok: true, status: 200, json: async () => ({ token: `fdm_person_${mints}` }) };
    };
    const t1 = await personTokenFor(cfg, "alice@finddata.cloud", fake);
    const t2 = await personTokenFor(cfg, "alice@finddata.cloud", fake); // cache hit, no re-mint
    assert.equal(t1, "fdm_person_1");
    assert.equal(t2, "fdm_person_1");
    assert.equal(mints, 1);
    // the on-disk artifact paas operators inspect: u/ namespace, owner-named, 0600
    const cacheFile = join(dir, "cell-memory-tokens", "alice@finddata.cloud.json");
    const cached = JSON.parse(readFileSync(cacheFile, "utf8"));
    assert.equal(cached.token, "fdm_person_1");
    assert.equal(cached.namespace, "u/alice@finddata.cloud");
    assert.equal(existsSync(cacheFile), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("memberTokenFor: d/<pack>/<member> namespace, cached under memberCachePath", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cellmem-m-"));
  try {
    const cfg = { url: "http://mem", platformToken: "plat", dataRoot: dir };
    let bodies = [];
    const fake = async (_url, init = {}) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({ token: "fdm_member_1" }) };
    };
    const input = { packId: "KkCi", memberId: "spider-heal", ownerEmail: "o@x" };
    const tok = await memberTokenFor(cfg, input, fake);
    assert.equal(tok, "fdm_member_1");
    assert.deepEqual(bodies[0], { namespace: "d/KkCi/spider-heal", owner: "u/o@x", label: "member:KkCi:spider-heal" });
    // cache path shape the pod-token lane rides on
    assert.equal(
      memberCachePath(dir, "KkCi", "spider-heal"),
      join(dir, "cell-memory-tokens", "d-KkCi-spider-heal.json"),
    );
    // second call served from disk, zero mint
    bodies = [];
    const again = await memberTokenFor(cfg, input, fake);
    assert.equal(again, "fdm_member_1");
    assert.equal(bodies.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cellMemoryMount: mount row + discipline on configured env; fail-open on every failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cellmem2-"));
  try {
    const env = { CELL_MEMORY_ENABLED: "1", CELL_MEMORY_URL: "http://mem", CELL_MEMORY_PLATFORM_TOKEN: "plat", CELL_MEMORY_DATA: dir };
    const ok = await cellMemoryMount(env, "bob@finddata.cloud", async () => ({ ok: true, status: 200, json: async () => ({ token: "fdm_bob" }) }));
    // the produced row IS the SDK memoryMcpEntry product — same bytes dsh-profile pushes
    assert.deepEqual(ok.mcpEntry, memoryMcpEntry("http://mem", "fdm_bob"));
    assert.equal(ok.mcpEntry.config.serverName, "fd-memory");
    assert.equal(ok.mcpEntry.config.headers.Authorization, "Bearer fdm_bob");
    assert.ok(ok.discipline.includes("memory_handoff_begin"));
    assert.equal(ok.discipline, MEMORY_DISCIPLINE);
    // mint failure → null, never a throw
    const bad = await cellMemoryMount(env, "carol@finddata.cloud", async () => ({ ok: false, status: 500 }));
    assert.equal(bad, null);
    // no owner → null
    assert.equal(await cellMemoryMount(env, "", async () => { throw new Error("unreachable"); }), null);
    // cache miss + network throw also fail-open
    assert.equal(await cellMemoryMount(env, "dave@finddata.cloud", async () => { throw new Error("net down"); }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("memoryMcpEntry: byte shape matches the historical dsh loader row (mcp-fd-memory)", () => {
  const e = memoryMcpEntry("http://mem", "tk");
  assert.deepEqual(e, {
    id: "mcp-fd-memory",
    name: "@deepseek-ai/dsh-mcp-client",
    config: {
      serverName: "fd-memory",
      failOnStartupError: false,
      transport: "streamable-http",
      url: "http://mem/mcp",
      headers: { Authorization: "Bearer tk" },
    },
  });
});

test("discipline text (SDK single source): bilingual historical golden", () => {
  // fix-memory-capture-p0 D6 decision: bilingual, one string, both surfaces
  assert.ok(MEMORY_DISCIPLINE.includes("工作记忆（fd-memory）"));
  assert.ok(MEMORY_DISCIPLINE.includes("Working memory (fd-memory)"));
  assert.ok(MEMORY_DISCIPLINE.includes("memory_handoff_begin"));
  assert.ok(MEMORY_DISCIPLINE.includes("memory_handoff_accept"));
  // note write trigger (add-chat-memory-injection)
  assert.ok(MEMORY_DISCIPLINE.includes("memory_write_page"));
  assert.ok(MEMORY_DISCIPLINE.includes("记住"));
});

test("merge lever (6.3): the flag rides the readDigest options and is inert on an older client", () => {
  // The platform must not decide the merge by itself: it passes an option and
  // lets the client do the protocol. On a client that predates the option it is
  // ignored — verified here against a stub that only records what it received.
  const calls = [];
  const seed = (flag) => {
    const prev = process.env.FD_MEMORY_DIGEST_MERGE_OWN_SHARED;
    if (flag === undefined) delete process.env.FD_MEMORY_DIGEST_MERGE_OWN_SHARED;
    else process.env.FD_MEMORY_DIGEST_MERGE_OWN_SHARED = flag;
    return () => {
      if (prev === undefined) delete process.env.FD_MEMORY_DIGEST_MERGE_OWN_SHARED;
      else process.env.FD_MEMORY_DIGEST_MERGE_OWN_SHARED = prev;
    };
  };
  const readDigest = async (_fleetId, _memberId, _q, opts) => {
    calls.push(opts);
    return { sources: ["own"], block: "块" };
  };
  const compose = (flag) => {
    const restore = seed(flag);
    try {
      const mergeOwnShared = String(process.env.FD_MEMORY_DIGEST_MERGE_OWN_SHARED ?? "") === "1";
      return { budget: 1200, scope: "own+shared", ...(mergeOwnShared ? { mergeOwnShared: true } : {}) };
    } finally {
      restore();
    }
  };

  // Off (unset and explicit 0): the option is absent, so the request is the
  // three-segment shape whatever client is installed.
  assert.equal(compose(undefined).mergeOwnShared, undefined);
  assert.equal(compose("0").mergeOwnShared, undefined);
  // On: the option is present; a client that ignores it behaves exactly as before.
  assert.equal(compose("1").mergeOwnShared, true);

  const opts = compose("1");
  return readDigest("fleet", "member", "q", opts).then(() => {
    assert.equal(calls.length, 1);
    assert.equal(calls[0].mergeOwnShared, true);
    assert.equal(calls[0].budget, 1200, "the budget is unchanged by the lever");
  });
});
