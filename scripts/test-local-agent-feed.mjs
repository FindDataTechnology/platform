// Unit tests — local roster feed + deployment store
// (add-local-fleet-control-plane 2.x / 3.x).
// Run: node --test scripts/test-local-agent-feed.mjs
//
//  1.x  entry composition: only enabled, installed, still-serving deployments
//       appear; entries carry the runner's filter fields (metadata.packId,
//       metadata.runner_id, supported_protocol a2a) and are composed through
//       the SAME functions the cloud deploy path uses.
//  2.x  feed HTTP: pagination (total_count/has_next), Bearer gate (401 without
//       the minted loopback token), skill body from the pack-owned row.
//  3.x  write gates: pack not installed / agent without serving declaration /
//       idempotent re-deploy / capacity by RUNTIME GROUP (pod mode: same pack
//       co-hosts, so a second agent of the pack costs no slot; spike 1.1 F2).
//  4.x  lifecycle: stop removes from feed but keeps identity; start restores;
//       remove deletes; uninstalled pack prunes its orphan row.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "local-feed-"));
process.env.DB_PATH = path.join(TMP, "platform.db");
process.env.PLATFORM_DATA_DIR = TMP;
process.env.DSH_HOME = path.join(TMP, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const db = await import("../db.js");
await db.initDb();
const feed = await import("../server/local-agent-feed.js");

const PACK_ID = "fleet-demo";
const SEAT = "desktop-test1234";

function manifestWith({ serving = true } = {}) {
  const base = {
    name: "Fleet Demo",
    description: "demo pack",
    version: 1,
    skills: [{ name: "demo-skill" }],
    agents: [
      {
        id: "worker-a",
        name: "Worker A",
        persona: "worker",
        ...(serving ? { serving: { protocol: "a2a", card: { description: "does work" } } } : {}),
      },
      {
        id: "worker-b",
        name: "Worker B",
        persona: "worker",
        ...(serving ? { serving: { protocol: "a2a" } } : {}),
      },
      { id: "plain", name: "Plain", persona: "worker" },
    ],
  };
  return base;
}

function installPack({ packId = PACK_ID, serving = true } = {}) {
  const manifest = manifestWith({ serving });
  db.upsertInstalledPack({
    packId,
    name: manifest.name,
    version: manifest.version,
    manifest,
    report: { items: [] },
  });
  return manifest;
}

function seedSkill({ packId = PACK_ID, name = "demo-skill", content = "# Demo\n\nbody\n" } = {}) {
  const now = new Date().toISOString();
  db.getDb()
    .prepare(
      `INSERT INTO custom_skills (id, name, description, content, enabled, created_at, updated_at, origin_pack_id, origin_pack_version)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, 1)`,
    )
    .run(`skill-${name}`, name, "demo", content, now, now, packId);
}

function reset() {
  db.getDb().prepare("DELETE FROM local_fleet_deployments").run();
  db.getDb().prepare("DELETE FROM custom_skills").run();
  db.getDb().prepare("DELETE FROM installed_packs").run();
}

test.afterEach(reset);

test("1.1 composeLocalEntries: only enabled + installed + serving", () => {
  installPack();
  const out = feed.deployLocalAgent({ packId: PACK_ID, agentId: "worker-a" });
  assert.ok(out.deployment, JSON.stringify(out));
  feed.deployLocalAgent({ packId: PACK_ID, agentId: "worker-b" });

  const entries = feed.composeLocalEntries({ runnerId: SEAT });
  assert.equal(entries.length, 2);
  for (const e of entries) {
    assert.equal(e.supported_protocol, "a2a");
    assert.equal(e.is_enabled, true);
    assert.equal(e.metadata.packId, PACK_ID);
    assert.equal(e.metadata.runner_id, SEAT);
    assert.equal(e.metadata.desktop_seat, true);
    assert.ok(Array.isArray(e.metadata.skills) && e.metadata.skills.length > 0);
    assert.equal(e.name.length > 0, true);
  }
});

test("1.2 a non-serving agent is not deployable", () => {
  installPack({ serving: false });
  const out = feed.deployLocalAgent({ packId: PACK_ID, agentId: "plain" });
  assert.equal(out.error?.code, "agent_not_serving");
});

test("1.3 uninstalled pack → 404-class refusal", () => {
  const out = feed.deployLocalAgent({ packId: "nope", agentId: "worker-a" });
  assert.equal(out.error?.code, "pack_not_installed");
});

test("2.1 feed HTTP: pagination + bearer gate", async () => {
  installPack();
  feed.deployLocalAgent({ packId: PACK_ID, agentId: "worker-a" });

  const router = feed.createLocalAgentFeed({ env: { WANXING_LOCAL_FEED_TOKEN: "tok-123" } });
  const app = await import("express").then((m) => m.default());
  app.use(feed.LOCAL_FEED_BASE, router);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}${feed.LOCAL_FEED_BASE}`;
  try {
    const unauth = await fetch(`${base}/api/agents?limit=10&offset=0`);
    assert.equal(unauth.status, 401);

    const auth = await fetch(`${base}/api/agents?limit=10&offset=0`, {
      headers: { Authorization: "Bearer tok-123" },
    });
    assert.equal(auth.status, 200);
    const doc = await auth.json();
    assert.equal(doc.total_count, 1);
    assert.equal(doc.has_next, false);
    assert.equal(doc.agents[0].path, `packs/${PACK_ID}/worker-a`);

    // limit smaller than the roster → has_next true (client's multi-page loop).
    feed.deployLocalAgent({ packId: PACK_ID, agentId: "worker-b" });
    const page = await fetch(`${base}/api/agents?limit=1&offset=0`, {
      headers: { Authorization: "Bearer tok-123" },
    });
    const pageDoc = await page.json();
    assert.equal(pageDoc.agents.length, 1);
    assert.equal(pageDoc.total_count, 2);
    assert.equal(pageDoc.has_next, true);

    seedSkill({ content: "# Skill body\n" });
    const skill = await fetch(`${base}/api/skills/packs/${PACK_ID}/demo-skill/content`, {
      headers: { Authorization: "Bearer tok-123" },
    });
    assert.equal(skill.status, 200);
    assert.match((await skill.json()).content, /Skill body/);
  } finally {
    server.close();
  }
});

test("2.2 no token configured = dev posture (loopback open)", async () => {
  const router = feed.createLocalAgentFeed({ env: {} });
  const app = await import("express").then((m) => m.default());
  app.use(feed.LOCAL_FEED_BASE, router);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}${feed.LOCAL_FEED_BASE}`;
  try {
    const res = await fetch(`${base}/api/agents?limit=10&offset=0`);
    assert.equal(res.status, 200);
  } finally {
    server.close();
  }
});

test("3.1 re-deploy is idempotent (one row, reused)", () => {
  installPack();
  const first = feed.deployLocalAgent({ packId: PACK_ID, agentId: "worker-a" });
  const second = feed.deployLocalAgent({ packId: PACK_ID, agentId: "worker-a" });
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(feed.listDeployments().length, 1);
});

test("3.2 capacity counts runtime GROUPS in pod mode", () => {
  process.env.AGENT_RUNNER_POD_MODE = "1";
  process.env.AGENT_RUNNER_MAX_CHILDREN = "1";
  try {
    installPack({ packId: "pack-one" });
    installPack({ packId: "pack-two" });
    // First pack: both agents fit — one pod child hosts the whole pack.
    assert.ok(feed.deployLocalAgent({ packId: "pack-one", agentId: "worker-a" }).deployment);
    assert.ok(feed.deployLocalAgent({ packId: "pack-one", agentId: "worker-b" }).deployment);
    // Second pack would need a second child: refused with the structure the
    // UI turns into "remove one to free a slot".
    const refused = feed.deployLocalAgent({ packId: "pack-two", agentId: "worker-a" });
    assert.equal(refused.error?.code, "capacity_exceeded");
    assert.equal(refused.error?.cap, 1);
    assert.equal(refused.error?.unit, "groups");
  } finally {
    delete process.env.AGENT_RUNNER_POD_MODE;
    delete process.env.AGENT_RUNNER_MAX_CHILDREN;
  }
});

test("3.3 solo mode counts per agent", () => {
  process.env.AGENT_RUNNER_MAX_CHILDREN = "1";
  try {
    installPack();
    assert.ok(feed.deployLocalAgent({ packId: PACK_ID, agentId: "worker-a" }).deployment);
    const refused = feed.deployLocalAgent({ packId: PACK_ID, agentId: "worker-b" });
    assert.equal(refused.error?.code, "capacity_exceeded");
  } finally {
    delete process.env.AGENT_RUNNER_MAX_CHILDREN;
  }
});

test("3.4 external runner id is refused (v1 is this seat only)", () => {
  installPack();
  const out = feed.deployLocalAgent({
    packId: PACK_ID,
    agentId: "worker-a",
    runnerId: SEAT,
    externalRunnerId: "some-cloud-runner",
  });
  assert.equal(out.error?.code, "external_runner_unsupported");
});

test("4.1 stop keeps identity, start restores, remove deletes", () => {
  installPack();
  feed.deployLocalAgent({ packId: PACK_ID, agentId: "worker-a" });
  const agentPath = `packs/${PACK_ID}/worker-a`;

  feed.setDeploymentEnabled(agentPath, false);
  assert.equal(feed.composeLocalEntries({ runnerId: SEAT }).length, 0);
  assert.equal(feed.getDeployment(agentPath)?.enabled, false); // identity kept

  feed.setDeploymentEnabled(agentPath, true);
  assert.equal(feed.composeLocalEntries({ runnerId: SEAT }).length, 1);
  assert.equal(feed.composeLocalEntries({ runnerId: SEAT })[0].metadata.agentId, "worker-a");

  feed.removeDeployment(agentPath);
  assert.equal(feed.getDeployment(agentPath), null);
});

test("4.2 uninstalling the pack prunes its orphan deployment", () => {
  installPack();
  feed.deployLocalAgent({ packId: PACK_ID, agentId: "worker-a" });
  db.deleteInstalledPack(PACK_ID);
  assert.equal(feed.pruneOrphanDeployments(), 1);
  assert.equal(feed.listDeployments().length, 0);
});

// ── Contract against the spike golden (task 5.1) ────────────────────────────
// spike/golden-agents.json is the exact body a real agent-runner consumed in
// spike 1.1 (zero code change). If the local feed ever stops exposing a field
// that fixture carries, the runner's filter/spawn path could silently go
// blind — so the golden's consumed-shape is pinned here.
test("5.1 entry shape stays a superset of the spike golden", () => {
  // The change was archived on 2026-10-28 (its spike moved under archive/);
  // resolve whichever path exists. In distribution trees (public snapshot)
  // openspec/ is pruned wholesale — skip there rather than fake-red.
  const candidates = [
    "../openspec/changes/archive/2026-10-28-add-local-fleet-control-plane/spike/golden-agents.json",
    "../openspec/changes/add-local-fleet-control-plane/spike/golden-agents.json",
  ];
  const goldenPath = candidates
    .map((rel) => new URL(rel, import.meta.url))
    .find((u) => fs.existsSync(u));
  if (!goldenPath) {
    console.log("5.1 skipped: spike golden not present in this tree (distribution prune)");
    return;
  }
  const golden = JSON.parse(fs.readFileSync(goldenPath, "utf8"));
  const goldenEntry = golden.agents[0];

  installPack();
  feed.deployLocalAgent({ packId: PACK_ID, agentId: "worker-a" });
  const [entry] = feed.composeLocalEntries({ runnerId: SEAT });

  // Every top-level field the runner consumed is still present…
  for (const key of Object.keys(goldenEntry)) {
    assert.ok(Object.hasOwn(entry, key), `entry is missing the golden field '${key}'`);
  }
  // …and the filter/spawn-critical values are the documented ones.
  assert.equal(entry.supported_protocol, goldenEntry.supported_protocol);
  assert.equal(entry.is_enabled, true);
  assert.equal(typeof entry.metadata.packId, "string");
  assert.equal(entry.metadata.runner_id, SEAT);
  assert.ok(Array.isArray(entry.metadata.skills), "descriptor.skills drives the runner's skill fetch");
});

// ── Write → feed → runner-client cadence (task 5.2) ─────────────────────────
// The whole point of the local control plane: a write must become visible to
// the RUNNER'S OWN registry client (agent-runner/registry.js) — not merely to
// our own read helpers — or the console would show a deployment that never
// gets served (the fake-green failure the spec forbids).
test("5.2 a write is visible to the runner's registry client on the next poll", async () => {
  installPack();
  const router = feed.createLocalAgentFeed({ env: {}, runnerId: SEAT });
  const app = await import("express").then((m) => m.default());
  app.use(feed.LOCAL_FEED_BASE, router);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}${feed.LOCAL_FEED_BASE}`;
  const { createRegistryClient } = await import("../agent-runner/registry.js");
  const client = createRegistryClient({
    registryUrl: base,
    runnerId: SEAT,
    defaultRunnerId: "cloud-default",
    // The client hands fetchImpl a RELATIVE path (its default impl prepends
    // registryUrl); this seam is exactly how a test points it at a server.
    fetchImpl: (p, init) => fetch(`${base}${p}`, init),
  });
  try {
    assert.equal((await client.listServedAgents()).length, 0, "nothing deployed yet");

    const out = feed.deployLocalAgent({ packId: PACK_ID, agentId: "worker-a", externalRunnerId: null });
    assert.ok(out.deployment);

    // The runner's own filter must accept it: enabled + a2a + packId metadata
    // + the seat's runner_id shard.
    const served = await client.listServedAgents();
    assert.equal(served.length, 1);
    assert.equal(served[0].path, `packs/${PACK_ID}/worker-a`);

    // Stop: the entry leaves the roster on the very next poll.
    feed.setDeploymentEnabled(`packs/${PACK_ID}/worker-a`, false);
    assert.equal((await client.listServedAgents()).length, 0);

    // Start again: same identity comes back.
    feed.setDeploymentEnabled(`packs/${PACK_ID}/worker-a`, true);
    const again = await client.listServedAgents();
    assert.equal(again.length, 1);
    assert.equal(again[0].path, `packs/${PACK_ID}/worker-a`);
  } finally {
    server.close();
  }
});
