// ── Supply-store migration tool tests (add-supply-store-unification 3.1/3.4) ─
//
//   node --test scripts/test-supply-store-migrate.mjs
//
// 钉住的契约：
//   · dry-run 默认：只出逐行计划+未知字段+visibility 缺失名单+统计，零写入；
//   · confirm：经真写闸（createSupplyStore + registerSupplyStoreRoutes，真
//     express 随机端口）写入，source="migration"，actor 落审计；
//   · 未知字段：报告点名 + 写闸 400 SUPPLY_UNKNOWN_FIELD 拒单（不裁剪不硬塞），
//     exit 1；
//   · visibility 缺失：写入 null（fail-closed，绝不补 public）且报告点名；
//   · groups：来自 registry-groups.json（bridge groupsFor 语义），缺失行如实
//     groups:[] 并点名；
//   · 分页：list 端点被 mock 钳到 2 行/页，翻页到尽（has_next 契约）；
//   · 对账：写后拉投影逐行逐字段 diff，AGREE 打印 N/N，漂移 exit 1；
//   · 退出码：0 全对账一致 / 1 未知字段或漂移或写失败 / 2 用法与连接错误；
//   · dual-read（3.4）：投影 vs registry 全量逐字段比对，漂移表 + exit 1。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";

const { createSupplyStore, registerSupplyStoreRoutes } = await import(
  "../gateway/supply-store.js"
);

const MIGRATE = fileURLToPath(new URL("./supply-store-migrate.mjs", import.meta.url));
const DUAL_READ = fileURLToPath(new URL("./supply-store-dual-read.mjs", import.meta.url));

const WRITE_TOKEN = "w-tok";
const PROJECTION_TOKEN = "p-tok";
const REGISTRY_TOKEN = "reg-tok";

// ── fixtures ──────────────────────────────────────────────────────────────────
// 3 个 server 行：一行全字段正常、一行带未知字段、一行 visibility 缺失；
// 1 个 skill 行（bridge mapSkill 形状：path + display 用 name 字段）。

const GROUPS_DOC = {
  servers: { "alpha-svc": ["g1"] },
  skills: { "beta-skill": ["g2"] },
  agents: {},
};

const MCP_ALPHA = {
  path: "/alpha-svc",
  display_name: "Alpha",
  description: "alpha mcp",
  proxy_pass_url: "http://up-a/mcp",
  num_tools: 2,
  tool_list: [{ name: "t1", description: "first" }, { name: "t2" }],
  tags: ["tag-a"],
  license: "MIT",
  provider_organization: "FD",
  deployment: "remote",
  metadata: { credential_ref: "lex", annotations: { human: { zh: { name: "阿尔法" } } } },
  visibility: "public",
  is_enabled: true,
};
const MCP_GAMMA = { ...MCP_ALPHA, path: "/gamma-svc", display_name: "Gamma", visibility: "private", totally_unknown_field: "x" };
const MCP_DELTA = { ...MCP_ALPHA, path: "/delta-svc", display_name: "Delta" };
delete MCP_DELTA.visibility; // visibility 缺失行
const SKILL_BETA = {
  path: "/skills/beta-skill",
  name: "Beta Skill",
  description: "beta skill",
  repository_url: "https://repo.test/beta",
  author: "fd",
  version: "1.2.0",
  tags: ["tag-b"],
  license: "Apache-2.0",
  metadata: { extra: true },
  visibility: "public",
  is_enabled: true,
};

function makeGroupsFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "supply-mig-groups-"));
  const file = path.join(dir, "registry-groups.json");
  fs.writeFileSync(file, JSON.stringify(GROUPS_DOC));
  return file;
}

// ── mock registry：分页被钳到 clamp 行/页，鉴权 Bearer，命中计数可断言 ─────────
function startRegistry({ servers, skills, clamp = 2 }) {
  const hits = { servers: 0, skills: 0 };
  const app = express();
  app.use((req, res, next) => {
    if (req.headers.authorization !== `Bearer ${REGISTRY_TOKEN}`) {
      return res.status(401).json({ error: "registry auth required" });
    }
    next();
  });
  const pageOf = (rows, req, key) => {
    const limit = Math.min(Number(req.query.limit) || 20, clamp);
    const offset = Number(req.query.offset) || 0;
    const page = rows.slice(offset, offset + limit);
    return { [key]: page, total_count: rows.length, limit, offset, has_next: offset + page.length < rows.length };
  };
  app.get("/api/servers", (req, res) => {
    hits.servers += 1;
    res.json(pageOf(servers, req, "servers"));
  });
  app.get("/api/skills", (req, res) => {
    hits.skills += 1;
    res.json(pageOf(skills, req, "skills"));
  });
  const server = app.listen(0);
  return {
    hits,
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => server.close(),
  };
}

// ── 真脊柱：真 store 文件 + 真 HTTP 写闸/投影（express 随机端口）────────────────
function startSpine({ distort = false } = {}) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "supply-mig-spine-")), "packs.db");
  const store = createSupplyStore({ file, gatewayBase: "https://mcp.example.test" });
  const app = express();
  app.use(express.json());
  if (distort) {
    // 对账漂移注入：投影响应里篡改一行 display_name，模拟窗口期单侧被改。
    app.use((req, res, next) => {
      if (req.path === "/api/supply-store/projection") {
        const orig = res.json.bind(res);
        res.json = (body) => {
          if (body && Array.isArray(body.mcpServers)) {
            body.mcpServers = body.mcpServers.map((r) =>
              r.id === "/alpha-svc" ? { ...r, display_name: "DISTORTED" } : r,
            );
          }
          return orig(body);
        };
      }
      next();
    });
  }
  registerSupplyStoreRoutes(app, { store, projectionToken: PROJECTION_TOKEN, writeToken: WRITE_TOKEN });
  const server = app.listen(0);
  return {
    store,
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => server.close(),
  };
}

function baseEnv(registryBase, spineBase) {
  return {
    REGISTRY_URL: registryBase,
    MARKET_REGISTRY_URL: "", // bridge 先读 MARKET_*——显式清空防开发壳漏 env
    MARKET_REGISTRY_TOKEN: REGISTRY_TOKEN,
    SUPPLY_STORE_BASE: spineBase,
    SUPPLY_STORE_WRITE_TOKEN: WRITE_TOKEN,
    SUPPLY_STORE_PROJECTION_TOKEN: PROJECTION_TOKEN,
    SUPPLY_MIGRATE_ACTOR: "",
  };
}

// Async spawn — MUST NOT be spawnSync: a sync wait blocks this process's event
// loop, and this same process hosts the mock registry + spine servers; the
// child's HTTP requests would never be served and every fetch would ride its
// AbortSignal timeout out. (First test run hit exactly that: 30s timeouts.)
function spawnTool(script, args, envOverrides) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { ...process.env, ...envOverrides },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", (err) => resolve({ status: -1, stdout, stderr: `${stderr}${err.message}` }));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

// ── tests ─────────────────────────────────────────────────────────────────────

test("dry-run: 逐行计划、分页翻尽、零写入、未知字段与 visibility 缺失名单点名", async () => {
  const groupsFile = makeGroupsFile();
  const reg = startRegistry({ servers: [MCP_ALPHA, MCP_GAMMA, MCP_DELTA], skills: [SKILL_BETA] });
  const spine = startSpine();
  try {
    const r = await spawnTool(MIGRATE, ["--groups-file", groupsFile], baseEnv(reg.base, spine.base));
    assert.equal(r.status, 1, `dry-run exits 1 on unknown fields\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);

    // 分页翻尽：3 行 / 钳 2 行每页 → servers 恰 2 页；skills 1 页。
    assert.equal(reg.hits.servers, 2);
    assert.equal(reg.hits.skills, 1);

    // 逐行计划 + 未知字段点名 + visibility 缺失点名 + groups 语义。
    assert.ok(r.stdout.includes("mode=dry-run"), r.stdout);
    assert.ok(r.stdout.includes("PLAN  /alpha-svc"), r.stdout);
    assert.ok(r.stdout.includes("unknown-field(s): totally_unknown_field"), r.stdout);
    assert.ok(r.stdout.includes("PLAN  /gamma-svc"), r.stdout);
    assert.ok(r.stdout.includes("visibility=MISSING→null(fail-closed)"), r.stdout);
    assert.ok(r.stdout.includes("PLAN  /delta-svc"), r.stdout);
    assert.ok(r.stdout.includes("groups=" + JSON.stringify(["g1"])), r.stdout);
    assert.ok(r.stdout.includes("groups unmapped → [] (2): /gamma-svc, /delta-svc"), r.stdout);
    assert.ok(r.stdout.includes("PLAN  beta-skill"), r.stdout);

    // dry-run 绝不写入。
    assert.equal(spine.store.listMcpServers().length, 0);
    assert.equal(spine.store.listSkills().length, 0);
    assert.equal(spine.store.listAudit().length, 0);
  } finally {
    reg.close();
    spine.close();
  }
});

test("confirm: 真写闸写入、未知字段行被 400 SUPPLY_UNKNOWN_FIELD 拒、对账 3/3 AGREE、exit 1", async () => {
  const groupsFile = makeGroupsFile();
  const reg = startRegistry({ servers: [MCP_ALPHA, MCP_GAMMA, MCP_DELTA], skills: [SKILL_BETA] });
  const spine = startSpine();
  try {
    const r = await spawnTool(MIGRATE, ["--confirm", "--actor", "op@example.com", "--groups-file", groupsFile], baseEnv(reg.base, spine.base));
    assert.equal(r.status, 1, `unknown fields → exit 1\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);

    // 写闸错误码透传到报告，不吞错。
    assert.ok(r.stdout.includes("REJECT  /gamma-svc"), r.stdout);
    assert.ok(r.stdout.includes("SUPPLY_UNKNOWN_FIELD"), r.stdout);
    assert.ok(r.stdout.includes("unknown-field(s)") || r.stdout.includes("unknown fields"), r.stdout);
    // 其余行照写，对账全 AGREE（2 mcp + 1 skill）。
    assert.ok(r.stdout.includes("WRITE  /alpha-svc"), r.stdout);
    assert.ok(r.stdout.includes("row-level reconciliation: 3/3 AGREE"), r.stdout);
    assert.ok(r.stdout.includes("visibility missing → written as null, fail-closed, review (1): /delta-svc"), r.stdout);

    // 脊柱实况：2 mcp 行 + 1 skill 行。
    const mcp = spine.store.listMcpServers();
    assert.equal(mcp.length, 2);
    const alpha = mcp.find((x) => x.id === "/alpha-svc");
    assert.equal(alpha.display_name, "Alpha");
    assert.equal(alpha.visibility, "public");
    assert.deepEqual(alpha.groups, ["g1"]);
    assert.deepEqual(alpha.metadata, MCP_ALPHA.metadata); // metadata 整体透传（credential_ref / annotations 在内）
    assert.deepEqual(alpha.tool_list, MCP_ALPHA.tool_list);
    assert.equal(alpha.updated_by, "op@example.com");
    const delta = mcp.find((x) => x.id === "/delta-svc");
    assert.equal(delta.visibility, null); // fail-closed：缺失不补 public
    assert.deepEqual(delta.groups, []);
    const skills = spine.store.listSkills();
    assert.equal(skills.length, 1);
    assert.equal(skills[0].name, "beta-skill");
    assert.equal(skills[0].display_name, "Beta Skill"); // registry skill `name` → display_name
    assert.deepEqual(skills[0].groups, ["g2"]);

    // 审计落账：每次受理写一行，source 固定 migration，actor 为操作者。
    const audit = spine.store.listAudit();
    assert.equal(audit.length, 3);
    assert.ok(audit.every((a) => a.source === "migration" && a.actor === "op@example.com"), JSON.stringify(audit));
  } finally {
    reg.close();
    spine.close();
  }
});

test("confirm 干净集：exit 0、AGREE、actor 走 env SUPPLY_MIGRATE_ACTOR", async () => {
  const groupsFile = makeGroupsFile();
  const reg = startRegistry({ servers: [MCP_ALPHA], skills: [SKILL_BETA] });
  const spine = startSpine();
  try {
    const r = await spawnTool(
      MIGRATE,
      ["--confirm", "--groups-file", groupsFile],
      { ...baseEnv(reg.base, spine.base), SUPPLY_MIGRATE_ACTOR: "env-actor@example.com" },
    );
    assert.equal(r.status, 0, `clean confirm exits 0\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.ok(r.stdout.includes("row-level reconciliation: 2/2 AGREE"), r.stdout);
    assert.ok(!r.stdout.includes("REJECT"), r.stdout);
    assert.equal(spine.store.listAudit()[0].actor, "env-actor@example.com");
  } finally {
    reg.close();
    spine.close();
  }
});

test("confirm: 投影漂移（窗口期单侧被改）→ 漂移表 + exit 1", async () => {
  const groupsFile = makeGroupsFile();
  const reg = startRegistry({ servers: [MCP_ALPHA], skills: [SKILL_BETA] });
  const spine = startSpine({ distort: true });
  try {
    const r = await spawnTool(MIGRATE, ["--confirm", "--actor", "op@example.com", "--groups-file", groupsFile], baseEnv(reg.base, spine.base));
    assert.equal(r.status, 1, `drift → exit 1\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.ok(r.stdout.includes("DRIFT mcp_servers /alpha-svc display_name"), r.stdout);
    assert.ok(r.stdout.includes('"DISTORTED"'), r.stdout);
    assert.ok(r.stdout.includes("MISMATCH"), r.stdout);
    assert.ok(!r.stdout.includes("AGREE"), r.stdout);
  } finally {
    reg.close();
    spine.close();
  }
});

test("用法与连接错误 → exit 2", async () => {
  const groupsFile = makeGroupsFile();
  const reg = startRegistry({ servers: [MCP_ALPHA], skills: [] });
  const spine = startSpine();
  try {
    const noActor = await spawnTool(MIGRATE, ["--confirm", "--groups-file", groupsFile], baseEnv(reg.base, spine.base));
    assert.equal(noActor.status, 2);
    assert.ok(noActor.stderr.includes("--actor"), noActor.stderr);
    const deadRegistry = await spawnTool(
      MIGRATE,
      [],
      { ...baseEnv("http://127.0.0.1:1", spine.base), SUPPLY_MIGRATE_ACTOR: "op@example.com" },
    );
    assert.equal(deadRegistry.status, 2);
    assert.ok(deadRegistry.stderr.includes("connection"), deadRegistry.stderr);
  } finally {
    reg.close();
    spine.close();
  }
});

// ── dual-read（3.4）────────────────────────────────────────────────────────────

function seedSpine(spine) {
  // 直接经真 store 写入迁移终态行（与迁移器映射输出同形状）。
  spine.store.upsertMcpServer({
    actor: "op@example.com",
    source: "migration",
    entry: {
      id: "/alpha-svc",
      display_name: "Alpha",
      description: MCP_ALPHA.description,
      proxy_pass_url: MCP_ALPHA.proxy_pass_url,
      num_tools: 2,
      tool_list: MCP_ALPHA.tool_list,
      tags: MCP_ALPHA.tags,
      license: "MIT",
      provider_organization: "FD",
      deployment: "remote",
      metadata: MCP_ALPHA.metadata,
      visibility: "public",
      groups: ["g1"],
      is_enabled: true,
    },
  });
  spine.store.upsertSkill({
    actor: "op@example.com",
    source: "migration",
    entry: {
      name: "beta-skill",
      display_name: "Beta Skill",
      description: SKILL_BETA.description,
      repository_url: SKILL_BETA.repository_url,
      author: SKILL_BETA.author,
      version: SKILL_BETA.version,
      tags: SKILL_BETA.tags,
      license: SKILL_BETA.license,
      metadata: SKILL_BETA.metadata,
      visibility: "public",
      groups: ["g2"],
      is_enabled: true,
    },
  });
}

function dualEnv(registryBase, spineBase) {
  return {
    REGISTRY_URL: registryBase,
    MARKET_REGISTRY_URL: "",
    MARKET_REGISTRY_TOKEN: REGISTRY_TOKEN,
    SUPPLY_STORE_BASE: spineBase,
    SUPPLY_STORE_PROJECTION_TOKEN: PROJECTION_TOKEN,
  };
}

test("dual-read: 零漂移 exit 0；单字段漂移给出漂移表并 exit 1", async () => {
  const cleanReg = startRegistry({ servers: [MCP_ALPHA], skills: [SKILL_BETA] });
  const cleanSpine = startSpine();
  const driftReg = startRegistry({ servers: [{ ...MCP_ALPHA, display_name: "Alpha Renamed" }], skills: [SKILL_BETA] });
  const driftSpine = startSpine();
  try {
    seedSpine(cleanSpine);
    seedSpine(driftSpine);

    const clean = await spawnTool(DUAL_READ, [], dualEnv(cleanReg.base, cleanSpine.base));
    assert.equal(clean.status, 0, `no drift → exit 0\nstdout: ${clean.stdout}\nstderr: ${clean.stderr}`);
    assert.ok(clean.stdout.includes("2 spine rows compared, 0 drift"), clean.stdout);
    // groups 是显式声明的跳过字段（registry 列表带不了组元数据）。
    assert.ok(clean.stdout.includes("skipped (declared): groups"), clean.stdout);

    const drifted = await spawnTool(DUAL_READ, [], dualEnv(driftReg.base, driftSpine.base));
    assert.equal(drifted.status, 1, `drift → exit 1\nstdout: ${drifted.stdout}\nstderr: ${drifted.stderr}`);
    assert.ok(drifted.stdout.includes("DRIFT mcp_servers /alpha-svc display_name"), drifted.stdout);
    assert.ok(drifted.stdout.includes('"Alpha"') && drifted.stdout.includes('"Alpha Renamed"'), drifted.stdout);
  } finally {
    cleanReg.close();
    cleanSpine.close();
    driftReg.close();
    driftSpine.close();
  }
});
