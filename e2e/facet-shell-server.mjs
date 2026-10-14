// Real facet service for the shell smoke spec (fix-facet-packs-crash): boots
// facet/index.js with its anonymous face (no Logto config), a throwaway
// DATA_ROOT, and one seeded public pack (direct SQLite insert — the
// established hermetic seeding pattern; the service owns schema creation, so
// seeding waits for its health check). The thin SPA is built from facet/web
// src, matching the deployed image (Dockerfile builds facet/web at image
// build), so the spec is a sentinel on SOURCE — the committed dist is never
// what production serves.
//
// Part of the Playwright webServer command chain (same process group, killed
// on teardown). Port: E2E_FACET_SHELL_PORT (default 3209).
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const repo = path.resolve(import.meta.dirname, "..");
const PORT = Number(process.env.E2E_FACET_SHELL_PORT || 3209);
const webDir = path.join(repo, "facet/web");
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "facet-shell-e2e-"));

// Always build unless explicitly skipped (FACET_SHELL_SKIP_BUILD=1, local
// fast iteration): a git checkout gives src and dist identical mtimes, so a
// staleness check would silently test the committed dist in CI.
if (process.env.FACET_SHELL_SKIP_BUILD !== "1") {
  const build = spawnSync("npm", ["run", "build"], { cwd: webDir, stdio: "inherit" });
  if (build.status !== 0) {
    console.error("[facet-shell] facet/web build failed");
    process.exit(1);
  }
}

const service = spawn("node", ["facet/index.js"], {
  cwd: repo,
  stdio: "inherit",
  env: {
    ...process.env,
    PORT: String(PORT),
    FACET_DATA_ROOT: dataRoot,
    FACET_WEB_DIST: path.join(webDir, "dist"),
    // Deliberately no Logto env: anonymous face is a supported degradation of
    // the real service. The internal token arms the proxy identity channel
    // (add-facet-content-management e2e drives the data plane with real
    // forwarded identities); groups line up so creator/admin authorization is
    // exercisable. No usage-source env: the curation board's honest
    // degradation is part of what the spec sees.
    FACET_INTERNAL_TOKEN: process.env.E2E_FACET_TOKEN || "e2e-facet-token",
    PACK_CREATOR_GROUPS: "creators,admin",
    ADMIN_GROUPS: "admin",
    // Registry source (add-facet-infra-pages): the e2e registry stub gives the
    // MCP catalog real entries (tools + provenance) and a skills pair, so the
    // shell sentinel exercises the depth view and skills catalog for real.
    REGISTRY_URL: process.env.E2E_REGISTRY_URL || "http://127.0.0.1:4599",
    MARKET_REGISTRY_TOKEN: process.env.E2E_REGISTRY_TOKEN || "e2e-registry-token",
  },
});
service.on("exit", (code) => {
  console.error(`[facet-shell] facet service exited early (code ${code})`);
  process.exit(1);
});

// Schema is created at boot — wait for health before seeding.
const deadline = Date.now() + 30_000;
for (;;) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
    if (r.ok) break;
  } catch { /* not up yet */ }
  if (Date.now() > deadline) {
    console.error("[facet-shell] facet service never became healthy");
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 200));
}

const db = new Database(path.join(dataRoot, "packs.db"));
const now = Date.now();
db.prepare(
  `INSERT INTO packs (id, author_email, created_at, unlisted, visibility) VALUES (?, ?, ?, 0, 'public')`,
).run("facet-shell-smoke", "smoke@e2e.local", now);
db.prepare(
  `INSERT INTO pack_versions (pack_id, version, name, description, tags, manifest, author_email, published_at)
   VALUES (?, 1, ?, ?, ?, ?, ?, ?)`,
).run(
  "facet-shell-smoke",
  "谦面壳冒烟包",
  "facet shell smoke sentinel pack",
  JSON.stringify(["shell-smoke"]),
  JSON.stringify({ name: "谦面壳冒烟包", description: "sentinel", skills: [], mcpServers: [], agents: [] }),
  "smoke@e2e.local",
  now,
);
db.close();
console.log(`[facet-shell] ready on http://127.0.0.1:${PORT} (seeded 1 public pack)`);

// Stay resident: Playwright tears the whole process group down.
setInterval(() => {}, 1 << 30);
