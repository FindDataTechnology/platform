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
  `INSERT INTO packs (id, author_email, created_at, unlisted, visibility, category, domains) VALUES (?, ?, ?, 0, 'public', ?, ?)`,
  // domains (overhaul-market-catalog-presentation P1): a declared domain set so
  // the shell spec can drive the two-row facet strip (line axis + domain axis).
).run("facet-shell-smoke", "smoke@e2e.local", now, "wire", JSON.stringify(["investing"]));
db.prepare(
  `INSERT INTO pack_versions (pack_id, version, name, description, tags, manifest, author_email, published_at)
   VALUES (?, 1, ?, ?, ?, ?, ?, ?)`,
).run(
  "facet-shell-smoke",
  "谦面壳冒烟包",
  "壳冒烟哨兵包。",
  JSON.stringify(["shell-smoke"]),
  // The seed carries a line-mappable category and an en overlay (overhaul-
  // market-catalog-presentation P0): the shell spec's locale-switch test
  // drives the real server path — canonical zh line word + projected chip
  // label, cross-track search, and the dialog's language refetch.
  JSON.stringify({
    name: "谦面壳冒烟包",
    description: "壳冒烟哨兵包。这是第二句，用来钉卡片承诺位只取首句。",
    notes: "壳冒烟哨兵包的版本说明。",
    guide: {
      steps: [
        { title: "第一步", body: "说明一" },
        { title: "第二步", body: "说明二" },
        { title: "第三步", body: "说明三" },
      ],
      examples: [{ title: "示例问法", text: "示例指令哨兵全文" }],
    },
    category: "wire",
    skills: [],
    mcpServers: [],
    agents: [],
    i18n: {
      en: {
        name: "Facet Shell Smoke Pack",
        description: "English sentinel description for the shell smoke pack.",
        notes: "English version note of the shell smoke pack.",
        tags: ["shell-smoke"],
        guide: {
          steps: [
            { title: "Step one", body: "English note one" },
            { title: "Step two", body: "English note two" },
            { title: "Step three", body: "English note three" },
          ],
        },
        skills: {},
        agents: {},
      },
    },
  }),
  "smoke@e2e.local",
  now,
);
// 第二支种子（overhaul-market-catalog-presentation P3 4.5）：带 v2 display 块，
// publishedAt 更早 → 排序在后，.first() 仍是无 display 的哨兵包（降级链用例
// 不被扰动）；它自己钉「声明的 display 进卡片与详情」的透传用例。
db.prepare(
  `INSERT INTO packs (id, author_email, created_at, unlisted, visibility, category, domains) VALUES (?, ?, ?, 0, 'public', ?, ?)`,
).run("facet-shell-v2", "smoke@e2e.local", now - 5000, "wire", JSON.stringify(["legal"]));
db.prepare(
  `INSERT INTO pack_versions (pack_id, version, name, description, tags, manifest, author_email, published_at)
   VALUES (?, 1, ?, ?, ?, ?, ?, ?)`,
).run(
  "facet-shell-v2",
  "显示 v2 包",
  "普通描述。第二句不该顶替声明承诺。",
  JSON.stringify(["v2"]),
  JSON.stringify({
    name: "显示 v2 包",
    description: "普通描述。第二句不该顶替声明承诺。",
    category: "wire",
    domain: ["legal"],
    identity: { mark: { kind: "glyph", value: "律" }, accent: "wire" },
    promise: "声明承诺：一屏可见的风险清单。",
    audience: ["legal"],
    outcomes: [
      { title: "风险清单", detail: "逐条定位到条款" },
      { title: "修订建议" },
    ],
    examples: [
      { title: "问风险", prompt: "声明示例提示词全文" },
      { title: "要建议", prompt: "给出修订建议" },
    ],
    skills: [{ name: "s", description: "d", content: "# s" }],
    mcpServers: [],
    agents: [],
  }),
  "smoke@e2e.local",
  now - 5000,
);
db.close();
console.log(`[facet-shell] ready on http://127.0.0.1:${PORT} (seeded 2 public packs)`);

// Stay resident: Playwright tears the whole process group down.
setInterval(() => {}, 1 << 30);
