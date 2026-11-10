// ── Supply spine store tests (add-supply-store-unification 1.x) ─────────────
//
//   node --test scripts/test-supply-store.mjs
//
// 钉住的契约：
//   · 写闸：无 actor=401 SUPPLY_UNIDENTIFIED_WRITE；legacy-direct=400
//     SUPPLY_LEGACY_DIRECT_WRITE；未知 source=400；每次受理写落审计行；
//   · 未知字段报告不静默丢（upsert/patch 双路）；
//   · fail-closed：visibility 为 NULL 的行对匿名不可见（spec 场景钉），
//     'public'+groups 走组闸，'private' 对任何 viewer 不可见；
//   · 投影：M2M 全量含 private+visibility；?since 增量；
//   · 目录面：endpoint 由公网 gatewayBase 派生——proxy_pass_url（上游）
//     绝不出现在消费者形状（内网拓扑泄漏回归钉）；注释合并 metadata 赢、
//     repo 补缺；禁用行剔除；
//   · HTTP 面：投影通道/写闸各自 token timing-safe，错误映射 status+code。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "supply-store-")));

import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";

const { createSupplyStore, registerSupplyStoreRoutes, SupplyStoreError } = await import(
  "../gateway/supply-store.js"
);

function freshStore({ gatewayBase = "https://mcp.example.test" } = {}) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "supply-store-t-")), "packs.db");
  return createSupplyStore({ file, gatewayBase, now: () => 1_700_000_000_000 });
}

const MCP_ENTRY = {
  id: "/law-bench",
  display_name: "Law Bench",
  description: "legal bench MCP",
  proxy_pass_url: "http://127.0.0.1:30840/mcp",
  num_tools: 52,
  tool_list: [{ name: "list_packs", description: "list packs" }],
  tags: ["legal"],
  license: "MIT",
  provider_organization: "FindData",
  deployment: "remote",
  metadata: { credential_ref: "lex", annotations: { human: { zh: { name: "识律台" } } } },
  visibility: "public",
  groups: [],
  is_enabled: true,
};

test("ensureSchema is idempotent", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "supply-schema-")), "packs.db");
  const a = createSupplyStore({ file, gatewayBase: "https://mcp.example.test" });
  const b = createSupplyStore({ file, gatewayBase: "https://mcp.example.test" });
  a.upsertMcpServer({ actor: "op@finddatatech.cloud", source: "migration", entry: MCP_ENTRY });
  assert.equal(b.listMcpServers().length, 1);
});

test("write gate: missing actor / legacy-direct / unknown source", () => {
  const store = freshStore({});
  assert.throws(
    () => store.upsertMcpServer({ actor: "", source: "gate", entry: MCP_ENTRY }),
    (e) => e instanceof SupplyStoreError && e.status === 401 && e.code === "SUPPLY_UNIDENTIFIED_WRITE",
  );
  assert.throws(
    () => store.upsertMcpServer({ actor: "op@x", source: "legacy-direct", entry: MCP_ENTRY }),
    (e) => e instanceof SupplyStoreError && e.status === 400 && e.code === "SUPPLY_LEGACY_DIRECT_WRITE",
  );
  assert.throws(
    () => store.upsertMcpServer({ actor: "op@x", source: "teleport", entry: MCP_ENTRY }),
    (e) => e instanceof SupplyStoreError && e.status === 400 && e.code === "SUPPLY_UNKNOWN_WRITE_SOURCE",
  );
  assert.equal(store.listMcpServers().length, 0);
  assert.equal(store.listAudit().length, 0);
});

test("upsert stamps actor, dedupes by id, audits every write; unknown field reported", () => {
  const store = freshStore({});
  store.upsertMcpServer({ actor: "op@finddatatech.cloud", source: "migration", entry: MCP_ENTRY });
  store.upsertMcpServer({
    actor: "publisher@finddatatech.cloud",
    source: "facade",
    entry: { ...MCP_ENTRY, description: "updated" },
  });
  const rows = store.listMcpServers();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].description, "updated");
  assert.equal(rows[0].updated_by, "publisher@finddatatech.cloud");
  assert.equal(rows[0].created_at, 1_700_000_000_000);
  const audit = store.listAudit();
  assert.equal(audit.length, 2);
  assert.deepEqual(
    audit.map((a) => [a.actor, a.action, a.entity_type, a.entity_id, a.source]),
    [
      ["publisher@finddatatech.cloud", "upsert", "mcp_server", "/law-bench", "facade"],
      ["op@finddatatech.cloud", "upsert", "mcp_server", "/law-bench", "migration"],
    ],
  );
  assert.throws(
    () => store.upsertMcpServer({ actor: "op@x", source: "gate", entry: { ...MCP_ENTRY, surprise: 1 } }),
    (e) => e instanceof SupplyStoreError && e.status === 400 && e.code === "SUPPLY_UNKNOWN_FIELD",
  );
});

test("patch: 404 unknown id, unknown patch field, merge lands", () => {
  const store = freshStore({});
  store.upsertMcpServer({ actor: "op@x", source: "migration", entry: MCP_ENTRY });
  assert.throws(
    () => store.patchMcpServer("/nope", { actor: "op@x", source: "gate", fields: { description: "x" } }),
    (e) => e instanceof SupplyStoreError && e.status === 404 && e.code === "SUPPLY_NOT_FOUND",
  );
  assert.throws(
    () => store.patchMcpServer("/law-bench", { actor: "op@x", source: "gate", fields: { nope: 1 } }),
    (e) => e instanceof SupplyStoreError && e.status === 400 && e.code === "SUPPLY_UNKNOWN_FIELD",
  );
  store.patchMcpServer("/law-bench", { actor: "op@x", source: "facade", fields: { display_name: "识律台" } });
  assert.equal(store.getMcpServer("/law-bench").display_name, "识律台");
});

// ── metadata 补丁按键盘合并（fix-supply-store-metadata-merge）──────────────
// 病史：patchMcpServer 用 {...existing, ...fields} 浅合并，metadata 是整体对象列 →
// 只发一个键就把兄弟键（supported_transports / credential_ref / surface_source）
// 静默抹掉，症状要到网关 405 才暴露。这四条把语义钉死。

const ROUTING_META = {
  supported_transports: ["streamable-http"],
  surface: "mcp",
  credential_ref: "registry",
  surface_source: "self_report",
  surface_report_token_hash: "sha256:deadbeef",
};

test("patch metadata: one key preserves its siblings", () => {
  const store = freshStore({});
  store.upsertMcpServer({
    actor: "op@x", source: "migration",
    entry: { ...MCP_ENTRY, metadata: { ...ROUTING_META } },
  });
  store.patchMcpServer("/law-bench", {
    actor: "op@x", source: "facade", fields: { metadata: { surface: "mcp-v2" } },
  });
  const meta = store.getMcpServer("/law-bench").metadata;
  assert.equal(meta.surface, "mcp-v2", "patched key lands");
  for (const k of ["supported_transports", "credential_ref", "surface_source", "surface_report_token_hash"]) {
    assert.deepEqual(meta[k], ROUTING_META[k], `sibling ${k} must survive a partial patch`);
  }
});

test("patch metadata: explicit null deletes exactly that key", () => {
  const store = freshStore({});
  store.upsertMcpServer({
    actor: "op@x", source: "migration",
    entry: { ...MCP_ENTRY, metadata: { ...ROUTING_META } },
  });
  store.patchMcpServer("/law-bench", {
    actor: "op@x", source: "facade", fields: { metadata: { surface_source: null } },
  });
  const meta = store.getMcpServer("/law-bench").metadata;
  assert.equal(Object.hasOwn(meta, "surface_source"), false, "explicit null must remove the key");
  assert.deepEqual(meta.supported_transports, ROUTING_META.supported_transports);
  assert.equal(meta.credential_ref, "registry");
});

test("patch metadata: whole-column null still clears, non-object still replaces", () => {
  const store = freshStore({});
  store.upsertMcpServer({
    actor: "op@x", source: "migration",
    entry: { ...MCP_ENTRY, metadata: { ...ROUTING_META } },
  });
  store.patchMcpServer("/law-bench", { actor: "op@x", source: "facade", fields: { metadata: null } });
  assert.equal(store.getMcpServer("/law-bench").metadata, null, "metadata:null clears the column");

  store.patchMcpServer("/law-bench", {
    actor: "op@x", source: "facade", fields: { metadata: { ...ROUTING_META } },
  });
  store.patchMcpServer("/law-bench", {
    actor: "op@x", source: "facade", fields: { metadata: "opaque-string" },
  });
  assert.equal(store.getMcpServer("/law-bench").metadata, "opaque-string", "non-object replaces whole");
});

test("fail-closed visibility: NULL not anonymous-visible even with matching group", () => {
  const store = freshStore({});
  store.upsertMcpServer({ actor: "op@x", source: "migration", entry: { ...MCP_ENTRY, visibility: null, groups: [] } });
  const row = store.getMcpServer("/law-bench");
  assert.equal(row.visibility, null);
  assert.equal(store.visibleToViewer(row, []), false);
  assert.equal(store.visibleToViewer(row, ["lex"]), false);
  store.setMcpServerVisibility("/law-bench", { actor: "op@x", source: "gate", visibility: "private", groups: [] });
  assert.equal(store.visibleToViewer(store.getMcpServer("/law-bench"), ["lex"]), false);
  store.setMcpServerVisibility("/law-bench", { actor: "op@x", source: "gate", visibility: "public", groups: ["lex"] });
  assert.equal(store.visibleToViewer(store.getMcpServer("/law-bench"), []), false);
  assert.equal(store.visibleToViewer(store.getMcpServer("/law-bench"), ["lex"]), true);
  store.setMcpServerVisibility("/law-bench", { actor: "op@x", source: "gate", visibility: "public", groups: [] });
  assert.equal(store.visibleToViewer(store.getMcpServer("/law-bench"), []), true);
});

test("projection: full M2M rows incl. private; since filter is incremental", () => {
  let clock = 1_000;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "supply-proj-")), "packs.db");
  const store = createSupplyStore({ file, gatewayBase: "https://mcp.example.test", now: () => clock });
  store.upsertMcpServer({ actor: "op@x", source: "migration", entry: { ...MCP_ENTRY, visibility: "private" } });
  clock = 2_000;
  store.upsertSkill({ actor: "op@x", source: "migration", entry: { name: "lex-search", description: "d", visibility: "public" } });
  const full = store.projectionPayload();
  assert.equal(full.mcpServers.length, 1);
  assert.equal(full.mcpServers[0].visibility, "private");
  assert.equal(full.skills.length, 1);
  const inc = store.projectionPayload({ since: 1_500 });
  assert.equal(inc.mcpServers.length, 0);
  assert.equal(inc.skills.length, 1);
  assert.equal(inc.asOf, 2_000);
});

test("catalog entries: endpoint derived from public gateway base, never the upstream", () => {
  const store = freshStore({ gatewayBase: "https://mcp.finddatatech.cloud" });
  store.upsertMcpServer({ actor: "op@x", source: "migration", entry: MCP_ENTRY });
  store.upsertMcpServer({
    actor: "op@x",
    source: "migration",
    entry: { ...MCP_ENTRY, id: "/disabled-srv", is_enabled: false },
  });
  const entries = store.catalogMcpEntries();
  assert.equal(entries.length, 1);
  const e = entries[0];
  assert.equal(e.name, "law-bench");
  assert.equal(e.configTemplate.url, "https://mcp.finddatatech.cloud/law-bench/mcp");
  assert.ok(!JSON.stringify(e).includes("127.0.0.1:30840"), "upstream proxy_pass_url must not leak to consumer shape");
  assert.equal(e.visibility, "public");
  assert.deepEqual(e.toolList, ["list_packs"]);
  assert.deepEqual(e.toolDetails, [{ name: "list_packs", description: "list packs" }]);
  assert.equal(e.credentialRef, "lex");
  assert.equal(e.annotations.human.zh.name, "识律台");
});

test("catalog annotations: metadata wins over repo file, missing human locales backfilled", () => {
  const store = freshStore({});
  store.upsertMcpServer({ actor: "op@x", source: "migration", entry: MCP_ENTRY });
  const entries = store.catalogMcpEntries({
    repoAnnotationFn: (name) => (name === "law-bench" ? { human: { en: { name: "Law Bench" } } } : null),
  });
  assert.equal(entries[0].annotations.human.zh.name, "识律台");
  assert.equal(entries[0].annotations.human.en.name, "Law Bench");
  assert.equal(entries[0].annotations.provenance.source, "registry");
});

test("catalog endpoint: client-visible mcp_endpoint override wins, internal-form falls back", () => {
  const store = freshStore({ gatewayBase: "https://mcp.finddatatech.cloud" });
  store.upsertMcpServer({
    actor: "op@x",
    source: "migration",
    entry: {
      ...MCP_ENTRY,
      id: "/overridden",
      metadata: { ...MCP_ENTRY.metadata, mcp_endpoint: "https://mcp.finddatatech.cloud/custom/mcp" },
    },
  });
  store.upsertMcpServer({
    actor: "op@x",
    source: "migration",
    entry: {
      ...MCP_ENTRY,
      id: "/internal-override",
      metadata: { ...MCP_ENTRY.metadata, mcp_endpoint: "http://localhost:18080/internal/mcp" },
    },
  });
  const byName = Object.fromEntries(store.catalogMcpEntries().map((e) => [e.name, e]));
  assert.equal(byName.overridden.configTemplate.url, "https://mcp.finddatatech.cloud/custom/mcp");
  assert.equal(
    byName["internal-override"].configTemplate.url,
    "https://mcp.finddatatech.cloud/internal-override/mcp",
    "internal-form override must fall back to the gateway-derived endpoint",
  );
});

test("skills: upsert/patch/visibility/delete with the same gate discipline", () => {
  const store = freshStore({});
  store.upsertSkill({ actor: "op@x", source: "migration", entry: { name: "lex-search", description: "d", tags: ["legal"], visibility: "public" } });
  assert.throws(
    () => store.upsertSkill({ actor: "op@x", source: "migration", entry: { name: "bad", nope: 1 } }),
    (e) => e instanceof SupplyStoreError && e.code === "SUPPLY_UNKNOWN_FIELD",
  );
  store.patchSkill("lex-search", { actor: "op@x", source: "facade", fields: { version: "v3" } });
  const row = store.getSkill("lex-search");
  assert.equal(row.version, "v3");
  assert.equal(row.updated_by, "op@x");
  store.deleteSkill("lex-search", { actor: "op@x", source: "gate" });
  assert.equal(store.getSkill("lex-search"), null);
  assert.throws(
    () => store.deleteSkill("lex-search", { actor: "op@x", source: "gate" }),
    (e) => e instanceof SupplyStoreError && e.status === 404,
  );
});

test("HTTP: projection token timing-safe, write gate errors map to status+code", async () => {
  const store = freshStore({});
  const app = express();
  app.use(express.json());
  registerSupplyStoreRoutes(app, {
    store,
    projectionToken: "proj-sec",
    writeToken: "write-sec",
  });
  const server = app.listen(0);
  await new Promise((r) => server.on("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const noAuth = await fetch(`${base}/api/supply-store/projection`);
    assert.equal(noAuth.status, 401);
    assert.equal((await noAuth.json()).code, "SUPPLY_UNAUTHORIZED");
    const badAuth = await fetch(`${base}/api/supply-store/projection`, { headers: { Authorization: "Bearer wrong" } });
    assert.equal(badAuth.status, 401);
    const okAuth = await fetch(`${base}/api/supply-store/projection`, { headers: { Authorization: "Bearer proj-sec" } });
    assert.equal(okAuth.status, 200);
    assert.deepEqual((await okAuth.json()).mcpServers, []);

    const noToken = await fetch(`${base}/api/supply-store/mcp-servers/upsert`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor: "op@x", entry: MCP_ENTRY }),
    });
    assert.equal(noToken.status, 401);
    const okWrite = await fetch(`${base}/api/supply-store/mcp-servers/upsert`, {
      method: "POST",
      headers: { Authorization: "Bearer write-sec", "content-type": "application/json" },
      body: JSON.stringify({ actor: "registry-facade", source: "facade", entry: { ...MCP_ENTRY, visibility: null } }),
    });
    assert.equal(okWrite.status, 200);
    const badWrite = await fetch(`${base}/api/supply-store/mcp-servers/upsert`, {
      method: "POST",
      headers: { Authorization: "Bearer write-sec", "content-type": "application/json" },
      body: JSON.stringify({ actor: "", source: "facade", entry: MCP_ENTRY }),
    });
    assert.equal(badWrite.status, 401);
    assert.equal((await badWrite.json()).code, "SUPPLY_UNIDENTIFIED_WRITE");

    const afterWrite = await (await fetch(`${base}/api/supply-store/projection`, { headers: { Authorization: "Bearer proj-sec" } })).json();
    assert.equal(afterWrite.mcpServers.length, 1);
    assert.equal(afterWrite.mcpServers[0].id, "/law-bench");
  } finally {
    server.close();
  }
});
