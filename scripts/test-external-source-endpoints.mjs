#!/usr/bin/env node
// ── External sources HTTP endpoints (add-external-skill-sources 刀一) ─────────
//
// Boots the real Express app with a minimal ctx (no DB needed — the external
// routes are deliberately DB-free), drives the three read-only endpoints with
// a stubbed outbound fetch, and asserts the spec postures:
//   - fan-out groups, per-source failure isolation
//   - disabled source never appears (env gate)
//   - the external route block has NO write paths (read-only spec scenario)
//
//   node --test scripts/test-external-source-endpoints.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ext-src-ep-"));
process.env.DB_PATH = path.join(TMP, "platform.db");
process.env.PLATFORM_DATA_DIR = TMP;
process.env.DSH_HOME = path.join(TMP, "dsh");

const { createExternalSourceRegistry } = await import("../external-sources.js");

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// Minimal express app wired the same way server.js registers extensions.
async function boot({ env = {} } = {}) {
  const express = (await import("express")).default;
  const app = express();
  const reg = createExternalSourceRegistry({
    env,
    fetchImpl: async (url) => {
      if (String(url).includes("skillhub")) {
        if (String(url).includes("boom")) return jsonResponse({}, 503);
        return jsonResponse({ results: [{ slug: "pdf-tools", name: "pdf-tools", displayName: "PDF Tools", description: "d", version: "1.0.0" }] });
      }
      if (String(url).includes("unreachable")) throw new Error("connect ECONNREFUSED");
      return jsonResponse({ skills: [{ slug: "frontend-design", displayName: "Frontend Design", description: "g", gitUrl: "https://github.com/x/y" }] });
    },
  });
  // Drive the same route registration shape the server uses: pass a ctx whose
  // registry is pre-built (the production route builds its own from process.env;
  // for endpoint tests we re-register the three handlers around the stub).
  const state = { reg };
  app.get("/api/extensions/external/sources", (_req, res) => {
    res.json({ sources: state.reg.enabled });
  });
  app.get("/api/extensions/external/search", async (req, res) => {
    const q = String(req.query.q ?? "").trim();
    if (!q) return res.status(400).json({ error: "Missing q" });
    if (q.length > 200) return res.status(400).json({ error: "q too long" });
    try {
      res.json({ query: q, groups: await state.reg.searchAll(q, 20) });
    } catch (err) {
      res.status(502).json({ error: `External source aggregation failed: ${err.message}` });
    }
  });
  app.get("/api/extensions/external/entry/:source/:slug", async (req, res) => {
    const out = await state.reg.getEntry(req.params.source, req.params.slug);
    if (!out) return res.status(404).json({ error: "Entry not found" });
    res.json(out);
  });
  const server = app.listen(0);
  await new Promise((r) => server.on("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, state };
}

test("sources endpoint lists enabled sources", async () => {
  const { server, base, state } = await boot({ env: {} });
  try {
    const res = await fetch(`${base}/api/extensions/external/sources`);
    const doc = await res.json();
    assert.deepEqual(doc.sources.map((s) => s.id).sort(), ["skillhub", "smithery"]);
    assert.ok(state.reg.isEnabled("skillhub"));
  } finally {
    server.close();
  }
});

test("search endpoint groups per source and isolates a failing source", async () => {
  const { server, base } = await boot({ env: { EXTERNAL_SKILL_SOURCES: "skillhub,smithery" } });
  try {
    // Make smithery unreachable through the stub's marker branch.
    // (The stub keys off url content; the search query flows into the URL.)
    const res = await fetch(`${base}/api/extensions/external/search?q=unreachable`);
    const doc = await res.json();
    assert.equal(res.status, 200);
    assert.equal(doc.groups.length, 2);
    const smithery = doc.groups.find((g) => g.source === "smithery");
    const skillhub = doc.groups.find((g) => g.source === "skillhub");
    assert.match(String(smithery.failed || ""), /ECONNREFUSED|connect/i);
    assert.equal(skillhub.entries.length, 1);
  } finally {
    server.close();
  }
});

test("search endpoint requires q", async () => {
  const { server, base } = await boot({});
  try {
    const res = await fetch(`${base}/api/extensions/external/search`);
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test("entry endpoint 404s a disabled source without fetching", async () => {
  const { server, base } = await boot({ env: { EXTERNAL_SKILL_SOURCES: "smithery" } });
  try {
    const res = await fetch(`${base}/api/extensions/external/entry/skillhub/pdf-tools`);
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

test("write boundary: the only install write path requires server-side confirm", async () => {
  const src = fs.readFileSync("server/routes/extensions.js", "utf8");
  const block = src.slice(src.indexOf("── External skill sources"));
  assert.ok(block.includes("app.get(\"/api/extensions/external/sources\""));
  assert.ok(block.includes("app.get(\"/api/extensions/external/search\""));
  assert.ok(block.includes("app.get(\"/api/extensions/external/entry/"));
  assert.ok(block.includes("app.get(\"/api/extensions/external/install-preview/"));
  // 刀二 re-judged the 刀一 read-only pin: the shelf keeps only GETs; the write
  // paths are the install + update POSTs (update added by the explicit-update
  // flow, same consent gate), and the gate is asserted at the route level in
  // the real-app test below (belt) plus this source pin (braces) — a write
  // verb without the confirm check would be a defect.
  const writeVerbs = block.match(/app\.(post|put|patch|delete)\("\/api\/extensions\/external[^"]*"/g) ?? [];
  assert.deepEqual(
    writeVerbs,
    ["app.post(\"/api/extensions/external/install\"", "app.post(\"/api/extensions/external/update\""],
    "the only write paths are the install + update POSTs",
  );
  assert.ok(block.includes("confirm !== true"), "the write paths pin the server-side confirm gate");
});

test("real routes: preview + install against an injected registry (confirm enforced)", async () => {
  const express = (await import("express")).default;
  const { registerExtensionRoutes } = await import("../server/routes/extensions.js");
  const { createExternalSourceRegistry } = await import("../external-sources.js");
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  zip.file("SKILL.md", "---\nname: ep-demo\nwhenToUse: w\n---\n\n# EP");
  zip.file("scripts/a.py", "print(1)");
  const zipBuf = await zip.generateAsync({ type: "nodebuffer" });

  // Registry with a stubbed fetch chain (mirrors the real SkillHub flow).
  const registry = createExternalSourceRegistry({
    env: { EXTERNAL_SKILL_SOURCES: "skillhub" },
    fetchImpl: async (url) => {
      if (String(url).includes("/download")) {
        return { ok: false, status: 302, headers: new Headers({ location: "https://b.myqcloud.com/x.zip" }), json: async () => ({}), text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) };
      }
      if (String(url).includes("myqcloud.com")) {
        return { ok: true, status: 200, headers: new Headers(), json: async () => ({}), text: async () => "", arrayBuffer: async () => zipBuf.buffer.slice(zipBuf.byteOffset, zipBuf.byteOffset + zipBuf.byteLength) };
      }
      if (String(url).includes("/skills/")) {
        return jsonResponse({ slug: "ep-demo", name: "ep-demo", displayName: "EP Demo", description: "d", version: "1.0.0", licenseState: "unknown" });
      }
      return jsonResponse({ results: [] });
    },
  });

  // Real DB + store + materializer so the install path runs end to end.
  const db = await import("../db.js");
  await db.initDb();
  const extensionStore = await import("../extension-store.js");
  const skillMaterialize = await import("../skill-materialize.js");
  const broadcasts = [];
  const app = express();
  app.use(express.json());
  registerExtensionRoutes({
    app,
    db,
    extensionStore,
    skillMaterialize,
    broadcast: (m) => broadcasts.push(m),
    bundle: { skills: [], permissions: {} },
    externalSources: registry, // test seam
  });
  const server = app.listen(0);
  await new Promise((r) => server.on("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // Preview works and describes the package.
    const prev = await (await fetch(`${base}/api/extensions/external/install-preview/skillhub/ep-demo`)).json();
    assert.equal(prev.preview.normalizedName, "ep-demo");
    assert.equal(prev.preview.hasScripts, true);
    assert.ok(prev.preview.files.some((f) => f.path === "scripts/a.py"));
    assert.equal(extensionStore.getCustomSkill("ep-demo"), null, "preview writes nothing");

    // Missing confirm → 400 and zero side effects.
    const refused = await fetch(`${base}/api/extensions/external/install`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "skillhub", slug: "ep-demo" }),
    });
    assert.equal(refused.status, 400);
    assert.equal((await refused.json()).code, "confirm-required");
    assert.equal(extensionStore.getCustomSkill("ep-demo"), null, "unconfirmed install writes nothing");

    // Confirmed → installs, broadcasts, exposes provenance.
    const ok = await fetch(`${base}/api/extensions/external/install`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "skillhub", slug: "ep-demo", confirm: true }),
    });
    assert.equal(ok.status, 200);
    const doc = await ok.json();
    assert.equal(doc.skill.name, "ep-demo");
    assert.equal(doc.skill.originMeta.source, "skillhub");
    assert.equal(doc.replaced, false);
    assert.ok(broadcasts.some((b) => b.resource === "skill" && b.name === "ep-demo"));
    const row = extensionStore.getCustomSkill("ep-demo");
    assert.deepEqual(Object.keys(row.files), ["scripts/a.py"]);
    assert.equal(row.frontmatter.whenToUse, "w");

    // Reinstalling replaces.
    const again = await (await fetch(`${base}/api/extensions/external/install`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "skillhub", slug: "ep-demo", confirm: true }),
    })).json();
    assert.equal(again.replaced, true);

    // 3.4: the skills listing carries the auxiliary file paths + provenance
    // (paths only — contents stay server-side), and legacy single-file rows
    // carry neither.
    const listed = await (await fetch(`${base}/api/extensions/skills`)).json();
    const installed = listed.skills.find((s) => s.name === "ep-demo");
    assert.ok(installed, "installed skill appears in the listing");
    assert.deepEqual(installed.files, ["scripts/a.py"], "listing exposes auxiliary paths only");
    assert.equal(installed.originMeta.source, "skillhub", "listing exposes external provenance");
    assert.equal(typeof installed.originMeta.upstreamName, "string", "upstream name preserved for display");
    const legacy = listed.skills.find((s) => s.source === "database" && s.name !== "ep-demo");
    if (legacy) {
      assert.equal(legacy.files ?? null, null, "legacy rows list no auxiliary files");
      assert.equal(legacy.originMeta ?? null, null, "legacy rows list no provenance");
    }
  } finally {
    server.close();
  }
});
