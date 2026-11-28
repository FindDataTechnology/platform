// ── App 卡片的品牌归属要真的到达浏览器（add-paper-trading-board 3.1）─────────
//
//   node --test scripts/test-catalog-app-line-attribution.mjs
//
// agents.json 的 app 条目自 2026-10 就带 `line` 字段（crm-desk / fleet-templates），
// appCatalog.ts 的 brandOf 也声明消费它——但 catalog.js 的 serialize 白名单一直没转发，
// 字段死在服务端，两张卡静默落到「未归属」组排最后。这里钉住：带 line 的 app
// 条目经 /api/catalog 序列化后 line 原样在（改了 white-list 删这行，此测试红）。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fd-line-attr-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = path.join(tmpRoot, "data");
process.env.DSH_HOME = path.join(tmpRoot, "dsh-home");
process.env.MCP_CONFIG_PATH = path.join(tmpRoot, "mcp.json");
process.env.SESSIONS_STORE_DIR = path.join(tmpRoot, "sessions-store");
process.env.CATALOG_REFRESH_SECS = "0";
fs.mkdirSync(process.env.PLATFORM_DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(process.env.PLATFORM_DATA_DIR, "data"), { recursive: true });
fs.writeFileSync(process.env.MCP_CONFIG_PATH, JSON.stringify({ mcpServers: {} }));

// catalog.js binds its agents.json at import — isolate cwd so the repo's own
// catalog never loads, and serve a fixture that carries the attribution.
const cwdFixture = path.join(process.env.PLATFORM_DATA_DIR, "cwd");
fs.mkdirSync(cwdFixture, { recursive: true });
fs.writeFileSync(
  path.join(cwdFixture, "agents.json"),
  JSON.stringify({
    agents: [],
    apps: [
      {
        id: "paper-trading",
        type: "app",
        kind: "link",
        name: "柏讯·模拟交易",
        url: "https://paper.finddatatech.cloud",
        description: "A 股纸面交易与策略演练",
        line: "wire",
      },
    ],
  }),
);
process.chdir(cwdFixture);

const catalog = await import("../catalog.js");
await catalog.initCatalog({ broadcast: () => {}, onChange: () => {} });

test("an app entry's line attribution survives serialization", () => {
  const app = catalog.getCatalogFor(null).apps.find((a) => a.id === "paper-trading");
  assert.ok(app, "the fixture app is served");
  assert.equal(app.line, "wire", "line must reach the client — brandOf reads it");
  assert.equal(app.kind, "link");
  assert.equal(app.url, "https://paper.finddatatech.cloud");
});

test("an app entry without line omits the field (no invented default)", () => {
  const none = catalog.getCatalogFor(null).apps.find((a) => a.id === "no-line");
  assert.equal(none?.line, undefined, "missing line stays missing — never defaulted");
});

test.after?.(() => {
  fs.rmSync(process.env.PLATFORM_DATA_DIR, { recursive: true, force: true });
});
