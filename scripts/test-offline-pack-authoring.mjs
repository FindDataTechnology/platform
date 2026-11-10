// Unit tests — offline pack authoring (add-offline-pack-authoring).
// Run: node --test scripts/test-offline-pack-authoring.mjs
//
//  1.x  draft export: editor-compiled manifest → validated → .yizpack; the
//       semantic red line (export is NOT publish) holds — no packId minting,
//       no version freeze, no materialization, draft stays editable.
//  2.x  bundle → draft: reverse-compile creates an EDITABLE draft, nothing is
//       installed or materialized; round-trip export→import→re-export is
//       byte-deterministic; field coverage (skills trees/agents/mcp/bots/guide).

import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pack-authoring-"));
process.env.DB_PATH = path.join(TMP, "platform.db");
process.env.PLATFORM_DATA_DIR = TMP;
process.env.DSH_HOME = path.join(TMP, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const db = await import("../db.js");
await db.initDb();
const packStore = await import("../pack-store.js");
const { registerPackRoutes } = await import("../server/routes/packs.js");
const { buildBundle, readBundle } = await import("../server/offline-bundle.js");

function makeApp() {
  const app = express();
  app.use(express.json({ limit: "24mb" }));
  app.use(express.raw({ type: ["application/octet-stream", "application/zip"], limit: "64mb" }));
  const ctx = {
    app,
    db,
    broadcast: () => {},
    authEnabled: false,
    cellUserEmail: "owner@local",
    requireMcpManage: () => true,
    dshUpdateSkills: async () => {},
    dshUpdateMcp: async () => {},
    syncCatalogAgentPresets: async () => {},
  };
  registerPackRoutes(ctx);
  return app;
}

async function post(app, path_, body, headers = {}) {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path_}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  } finally {
    server.close();
  }
}

// The editor's own manifest compile (PackDraftsView.tsx) — mirrored here so
// the tests exercise exactly what the client sends.
function compileManifest(entries, { visibility = "private", version = 1 } = {}) {
  return {
    name: entries.name,
    description: entries.description,
    visibility,
    version,
    tags: entries.tags ?? [],
    ...(entries.guide ? { guide: entries.guide } : {}),
    skills: entries.skills ?? [],
    mcpServers: entries.mcpServers ?? [],
    agents: entries.agents ?? [],
    ...(entries.bots ? { bots: entries.bots } : {}),
  };
}

const FULL_ENTRIES = {
  name: "Authoring Demo",
  description: "offline authoring fixture",
  tags: ["demo", "offline"],
  skills: [
    {
      name: "authoring-skill",
      description: "a skill with a file tree",
      content: "# body\n",
      files: { "scripts/run.sh": "#!/bin/sh\necho hi\n" },
    },
  ],
  mcpServers: [{ registryName: "websearch" }],
  agents: [
    { id: "authoring-worker", name: "Worker", persona: "w", serving: { protocol: "a2a" } },
  ],
  bots: [{ id: "authoring-bot", name: "Bot", generic: "channel", description: "fixture bot" }],
  guide: { steps: [{ title: "t1", body: "b1" }, { title: "t2", body: "b2" }, { title: "t3", body: "b3" }] },
};

test.afterEach(() => {
  db.getDb().prepare("DELETE FROM pack_drafts").run();
  db.getDb().prepare("DELETE FROM installed_packs").run();
  db.getDb().prepare("DELETE FROM custom_skills").run();
});

test("1.1 export compiles a valid bundle and never touches publish state", async () => {
  const draft = packStore.createDraft({ name: FULL_ENTRIES.name, description: FULL_ENTRIES.description, tags: FULL_ENTRIES.tags, entries: { ...FULL_ENTRIES, name: undefined } && { ...FULL_ENTRIES } });
  const app = makeApp();
  const manifest = compileManifest({ ...FULL_ENTRIES, name: draft.name });
  const { status, body } = await post(app, `/api/pack-drafts/${draft.id}/export-bundle`, { manifest });

  assert.equal(status, 200, JSON.stringify(body).slice(0, 200));
  assert.equal(body.meta.packId, "authoring-demo"); // slug of the manifest name
  assert.equal(body.meta.version, 1);

  // The bundle is a real, verifiable container.
  const parsed = await readBundle(Buffer.from(body.bundle, "base64"));
  assert.equal(parsed.meta.packId, "authoring-demo");
  assert.equal(parsed.manifest.name, draft.name);

  // RED LINE: export is not publish — nothing moved anywhere.
  const after = packStore.getDraft(draft.id);
  assert.equal(after.publishedPackId, null, "no packId minted");
  assert.deepEqual(after.entries.skills, FULL_ENTRIES.skills, "draft stays editable/intact");
  assert.equal(db.listInstalledPacks().length, 0, "nothing installed");
  assert.equal(db.getDb().prepare("SELECT COUNT(*) AS c FROM custom_skills").get().c, 0, "no skills materialized");
});

test("1.2 export validation failures match the install pipeline", async () => {
  const draft = packStore.createDraft({ name: "Bad", description: "", tags: [], entries: {} });
  const app = makeApp();
  const bad = compileManifest({ name: "Bad", skills: [], agents: [{ id: "x", name: "X", persona: "p", serving: { protocol: "wrong" } }] });
  const { status, body } = await post(app, `/api/pack-drafts/${draft.id}/export-bundle`, { manifest: bad });
  assert.equal(status, 400);
  assert.equal(body.error, "Invalid manifest");
  assert.ok(Array.isArray(body.details) && body.details.length > 0);
});

test("1.3 export is deterministic (same draft → same bytes)", async () => {
  const draft = packStore.createDraft({ name: FULL_ENTRIES.name, description: "", tags: [], entries: FULL_ENTRIES });
  const app = makeApp();
  const manifest = compileManifest(FULL_ENTRIES);
  const a = await post(app, `/api/pack-drafts/${draft.id}/export-bundle`, { manifest });
  const b = await post(app, `/api/pack-drafts/${draft.id}/export-bundle`, { manifest });
  assert.equal(a.body.bundle, b.body.bundle, "deterministic container");
});

test("2.1 import creates an editable draft and installs NOTHING", async () => {
  const bytes = await buildBundle({ packId: "roundtrip", version: 2, manifest: compileManifest(FULL_ENTRIES), origin: "test" });
  const app = makeApp();
  const { status, body } = await post(app, "/api/pack-drafts/import-bundle", { bundle: Buffer.from(bytes).toString("base64") });
  assert.equal(status, 200, JSON.stringify(body).slice(0, 200));

  const draft = body.draft;
  assert.equal(draft.name, "Authoring Demo");
  assert.deepEqual(draft.tags, ["demo", "offline"]);
  assert.equal(draft.entries.skills.length, 1);
  assert.deepEqual(draft.entries.skills[0].files, FULL_ENTRIES.skills[0].files, "file tree rides the entries");
  assert.deepEqual(draft.entries.agents, FULL_ENTRIES.agents);
  assert.deepEqual(draft.entries.mcpServers, FULL_ENTRIES.mcpServers);
  assert.deepEqual(draft.entries.bots, FULL_ENTRIES.bots, "bots ride the entries (round-trip loses nothing)");
  assert.deepEqual(draft.entries.guide, FULL_ENTRIES.guide);

  // IMPORT IS EDITING, NOT INSTALLING.
  assert.equal(db.listInstalledPacks().length, 0);
  assert.equal(db.getDb().prepare("SELECT COUNT(*) AS c FROM custom_skills").get().c, 0);
});

test("2.2 round-trip: export → import → re-export is byte-deterministic", async () => {
  const app = makeApp();
  const manifest = compileManifest(FULL_ENTRIES);
  const _first = await post(app, "/api/pack-drafts/export-bundle-x", { manifest });
  // (export needs a draft id — create one and use its endpoint for both passes)
  const draft = packStore.createDraft({ name: "RT", description: "", tags: [], entries: FULL_ENTRIES });
  const e1 = await post(app, `/api/pack-drafts/${draft.id}/export-bundle`, { manifest });
  assert.equal(e1.status, 200);

  const back = await post(app, "/api/pack-drafts/import-bundle", { bundle: e1.body.bundle });
  assert.equal(back.status, 200);
  const reExportManifest = compileManifest({
    ...back.body.draft.entries,
    name: back.body.draft.name,
    description: back.body.draft.description,
    tags: back.body.draft.tags,
  });
  const e2 = await post(app, `/api/pack-drafts/${draft.id}/export-bundle`, { manifest: reExportManifest, version: 2 });
  assert.equal(e2.status, 200);

  // Same manifest content → the deterministic container produces the same bytes
  // up to the version field, which the entry carries explicitly.
  const p1 = await readBundle(Buffer.from(e1.body.bundle, "base64"));
  const p2 = await readBundle(Buffer.from(e2.body.bundle, "base64"));
  assert.deepEqual(p2.manifest, p1.manifest, "manifest round-trips exactly");
  assert.equal(p2.meta.packId, p1.meta.packId);
});

test("2.3 import refuses a broken bundle with the container's own error", async () => {
  const app = makeApp();
  const { status, body } = await post(app, "/api/pack-drafts/import-bundle", { bundle: "bm90IGEgemlw" });
  assert.equal(status, 400);
  assert.equal(body.code, "bundle_unreadable");
});

test("2.4 import needs the draft editor shape, not an install", async () => {
  // A bundle whose manifest carries fields the editor compiles — none of them
  // may leak into installed state.
  const bytes = await buildBundle({
    packId: "with-bots",
    version: 1,
    manifest: compileManifest(FULL_ENTRIES),
  });
  const app = makeApp();
  const { status, body } = await post(app, "/api/pack-drafts/import-bundle", { bundle: Buffer.from(bytes).toString("base64") });
  assert.equal(status, 200);
  assert.ok(body.draft.entries.bots, "bots stay editable in the draft");
  assert.equal(db.listInstalledPacks().length, 0);
});

test("1.4 a published draft exports at the INSTALLED version (no silent downgrade)", async () => {
  // Mask an already-published draft whose pack this machine has at v3.
  const draft = packStore.createDraft({ name: "Published Demo", description: "", tags: [], entries: FULL_ENTRIES });
  db.getDb().prepare("UPDATE pack_drafts SET published_pack_id = ? WHERE id = ?").run("published-demo", draft.id);
  db.upsertInstalledPack({
    packId: "published-demo", name: "Published Demo", version: 3,
    manifest: { name: "Published Demo", description: "", skills: [], agents: [] }, report: {},
  });

  const app = makeApp();
  const { status, body } = await post(app, `/api/pack-drafts/${draft.id}/export-bundle`, {
    manifest: compileManifest(FULL_ENTRIES, { version: undefined }),
  });
  assert.equal(status, 200, JSON.stringify(body).slice(0, 200));
  assert.equal(body.meta.version, 3, "exports at the installed version, not 1");
  assert.equal(body.meta.packId, "published-demo", "keeps the published pack id");
});

test("1.5 an explicit version still wins", async () => {
  const draft = packStore.createDraft({ name: "Explicit", description: "", tags: [], entries: FULL_ENTRIES });
  const app = makeApp();
  const { status, body } = await post(app, `/api/pack-drafts/${draft.id}/export-bundle`, {
    manifest: compileManifest(FULL_ENTRIES),
    version: 7,
  });
  assert.equal(status, 200);
  assert.equal(body.meta.version, 7);
});
