// Unit tests — the offline-bundle IMPORT route (add-offline-pack-supply 2.x).
// Run: node --test scripts/test-pack-import-bundle.mjs
//
//  2.x  the endpoint takes raw bytes or base64, runs the bundle's own gates,
//       then enters the IDENTICAL installPack pipeline a market install uses:
//         - one manifest, three entry shapes → the same install report
//         - the purchase gate keeps its semantics: reachable market + paid
//           and unpurchased → 402; unreachable market → degrade and install
//         - a tampered bundle is refused BEFORE anything is materialized
//         - the recorded provenance is "bundle"

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pack-import-"));
process.env.DB_PATH = path.join(TMP, "platform.db");
process.env.PLATFORM_DATA_DIR = TMP;
process.env.DSH_HOME = path.join(TMP, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const db = await import("../db.js");
await db.initDb();
const { buildBundle, toBase64 } = await import("../server/offline-bundle.js");
const { registerPackRoutes } = await import("../server/routes/packs.js");

const MANIFEST = {
  name: "Import Demo",
  description: "offline import fixture",
  skills: [{ name: "import-demo-skill", description: "d", content: "# body\n" }],
  agents: [],
};

function makeApp({ market = null } = {}) {
  const app = express();
  app.use(express.json({ limit: "24mb" }));
  app.use(express.raw({ type: ["application/octet-stream", "application/zip"], limit: "64mb" }));
  const ctx = {
    app,
    db,
    broadcast: () => {},
    authEnabled: false,
    cellUserEmail: "owner@local",
    // The manage gate is the deployment's own policy; this fixture exercises
    // the bundle path, not the gate.
    requireMcpManage: () => true,
    localPackMarket: market,
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

test("2.1 base64 upload installs the bundle and records source=bundle", async () => {
  const bytes = await buildBundle({ packId: "import-demo", version: 1, manifest: MANIFEST });
  const app = makeApp();
  const { status, body } = await post(app, "/api/mypacks/import-bundle", { bundle: toBase64(bytes) });
  assert.equal(status, 200);
  assert.equal(body.report.source, "bundle");
  assert.equal(body.installed.source, "bundle");
  assert.equal(db.getInstalledPack("import-demo").source, "bundle");
  assert.equal(body.report.skills[0].status, "installed");
});

test("2.2 raw octet-stream upload installs the same pack", async () => {
  const bytes = await buildBundle({ packId: "import-raw", version: 1, manifest: MANIFEST });
  const app = makeApp();
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/mypacks/import-bundle`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: bytes,
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.bundle.packId, "import-raw");
    assert.equal(db.getInstalledPack("import-raw").source, "bundle");
  } finally {
    server.close();
  }
});

test("2.3 a tampered bundle is refused and nothing is materialized", async () => {
  const JSZip = (await import("jszip")).default;
  const bytes = await buildBundle({ packId: "import-tampered", version: 1, manifest: MANIFEST });
  const zip = await JSZip.loadAsync(bytes);
  zip.file("manifest.json", JSON.stringify({ ...MANIFEST, name: "Injected" }));
  const tampered = await zip.generateAsync({ type: "nodebuffer" });

  const app = makeApp();
  const { status, body } = await post(app, "/api/mypacks/import-bundle", { bundle: toBase64(tampered) });
  assert.equal(status, 400);
  assert.equal(body.code, "bundle_digest_mismatch");
  assert.equal(db.getInstalledPack("import-tampered"), null, "no half install");
});

test("2.4 the purchase gate keeps its semantics (reachable paid ⇒ 402)", async () => {
  const bytes = await buildBundle({ packId: "import-paid", version: 1, manifest: MANIFEST });
  const app = makeApp({
    market: { getLatest: () => ({ pricing: { amount: 10 }, purchased: false }) },
  });
  const { status, body } = await post(app, "/api/mypacks/import-bundle", { bundle: toBase64(bytes) });
  assert.equal(status, 402);
  assert.equal(body.code, "market-purchase-required");
  assert.equal(db.getInstalledPack("import-paid"), null);
});

test("2.5 an unreachable market degrades and the import still lands", async () => {
  const bytes = await buildBundle({ packId: "import-offline", version: 1, manifest: MANIFEST });
  const app = makeApp({
    market: { getLatest: () => { throw Object.assign(new Error("market unreachable"), { status: 502 }); } },
  });
  const { status, body } = await post(app, "/api/mypacks/import-bundle", { bundle: toBase64(bytes) });
  assert.equal(status, 200);
  assert.equal(body.report.source, "bundle");
  assert.equal(db.getInstalledPack("import-offline").source, "bundle");
});

test("2.6 a bundle for another pack is refused (target mismatch)", async () => {
  const bytes = await buildBundle({ packId: "import-other", version: 1, manifest: MANIFEST });
  const app = makeApp();
  const { status, body } = await post(app, "/api/mypacks/import-bundle", {
    bundle: toBase64(bytes),
    packId: "import-wanted",
  });
  assert.equal(status, 400);
  assert.equal(body.code, "bundle_target_mismatch");
});
