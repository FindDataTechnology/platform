// facet 市场仓投影（add-pack-marketplace-git-channel）
// 收录口径与 Claude 端点同源；插件树、路径安全、凭据扫描、自检、last-good。
// 运行：node --test scripts/test-facet-marketplace-repo.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.dirname(new URL(import.meta.url).pathname);
const repoMod = await import(pathToFileURL(path.join(root, "..", "facet", "marketplace-repo.js")).href);
const jsonMod = await import(pathToFileURL(path.join(root, "..", "facet", "marketplace-json.js")).href);
const packsMod = await import(pathToFileURL(path.join(root, "..", "gateway", "packs.js")).href);
const express = (await import("express")).default;

const AUTHORS = { email: "op@finddata.tech" };

function manifest(letter, extra = {}) {
  return {
    name: `Pack ${letter}`,
    description: `${letter} 描述`,
    skills: [
      {
        name: `skill-${letter.toLowerCase()}`,
        description: `技能 ${letter}`,
        content: `\n# ${letter} 正文\n`,
        ...(extra.files ? { files: extra.files } : {}),
      },
    ],
    ...(extra.mcpServers ? { mcpServers: extra.mcpServers } : {}),
    ...(extra.agents ? { agents: extra.agents } : {}),
  };
}

// Fresh registry per test: state is a file, so a shared one would leak.
async function boot() {
  const dir = await mkdtemp(path.join(tmpdir(), "facet-repo-"));
  const registry = packsMod.createPackRegistry({ file: path.join(dir, "packs.db") });
  const cleanup = () => rm(dir, { recursive: true, force: true });
  return { registry, dir, cleanup };
}

const ACTOR = { email: AUTHORS.email, admin: true };
function seedListed(registry) {
  const a = registry.publish({ email: AUTHORS.email, manifest: manifest("A") });
  registry.setCuration({ id: a.id, actor: ACTOR, category: "data", featured: false });
  return a;
}

test("清单形状：根 .codebuddy-plugin/marketplace.json 与相对 source", async () => {
  const { registry, cleanup } = await boot();
  try {
    const a = seedListed(registry);
    const built = repoMod.buildMarketplaceRepo(registry, { env: {} });
    assert.equal(built.manifest.name, "facet");
    assert.equal(built.manifest.owner.name.length > 0, true);
    assert.equal(built.manifest.plugins.length, 1);
    const entry = built.manifest.plugins[0];
    assert.equal(entry.name, a.id);
    assert.equal(entry.source, `./plugins/${a.id}`);
    assert.equal(entry.version, String(a.version));
    assert.equal(typeof entry.description, "string");
    const files = built.plugins.get(a.id);
    assert.ok(files.has(".codebuddy-plugin/plugin.json"));
    assert.ok(files.has(`skills/skill-a/SKILL.md`));
  } finally { await cleanup(); }
});

test("插件树：技能 SKILL.md 带 frontmatter、辅助文件原样落、agents 成 md", async () => {
  const { registry, cleanup } = await boot();
  try {
    const p = registry.publish({
      email: AUTHORS.email,
      manifest: manifest("B", {
        files: { "scripts/run.py": "print('hi')\n", "references/notes.md": "notes\n" },
        agents: [{ id: "writer", name: "写作岗", description: "写东西", persona: "你负责写作。", resources: { skills: ["skill-b"] } }],
      }),
    });
    registry.setCuration({ id: p.id, actor: ACTOR, category: "docs", featured: false });
    const built = repoMod.buildMarketplaceRepo(registry, { env: {} });
    const files = built.plugins.get(p.id);
    const md = files.get("skills/skill-b/SKILL.md");
    assert.match(md, /^---\nname: "skill-b"\ndescription: "技能 B"\n---\n/);
    assert.match(md, /# B 正文/);
    assert.equal(files.get("skills/skill-b/scripts/run.py"), "print('hi')\n");
    assert.equal(files.get("skills/skill-b/references/notes.md"), "notes\n");
    const agent = files.get("agents/writer.md");
    assert.match(agent, /^---\nname: "写作岗"/);
    assert.match(agent, /你负责写作。/);
    assert.match(agent, /本角色使用技能：skill-b/);
  } finally { await cleanup(); }
});

test("收录与端点同源：策展在列、未策展缺席、unlisted 缺席", async () => {
  const { registry, cleanup } = await boot();
  try {
    const listed = registry.publish({ email: AUTHORS.email, manifest: manifest("A") });
    registry.setCuration({ id: listed.id, actor: ACTOR, category: "data", featured: false });
    const uncurated = registry.publish({ email: AUTHORS.email, manifest: manifest("B") });
    const gone = registry.publish({ email: AUTHORS.email, manifest: manifest("C") });
    registry.setCuration({ id: gone.id, actor: ACTOR, category: "data", featured: false });
    registry.setUnlisted({ email: AUTHORS.email, id: gone.id });

    const built = repoMod.buildMarketplaceRepo(registry, { env: {} });
    const ids = built.manifest.plugins.map((p) => p.name);
    assert.deepEqual(ids, [listed.id]);
    assert.equal(built.plugins.has(uncurated.id), false);
    assert.equal(built.plugins.has(gone.id), false);

    // Same source the endpoint reads — assert the two sets directly.
    const direct = jsonMod.loadListedPacks(registry, { env: {} }).map((p) => p.id);
    assert.deepEqual(direct, ids);
  } finally { await cleanup(); }
});

test("白名单覆写：FACET_MARKETPLACE_PACK_IDS 决定清单，且两面一致", async () => {
  const { registry, cleanup } = await boot();
  try {
    const a = registry.publish({ email: AUTHORS.email, manifest: manifest("A") }); // 未策展
    const env = { FACET_MARKETPLACE_PACK_IDS: a.id };
    const built = repoMod.buildMarketplaceRepo(registry, { env });
    assert.deepEqual(built.manifest.plugins.map((p) => p.name), [a.id]);
    const direct = jsonMod.loadListedPacks(registry, { env }).map((p) => p.id);
    assert.deepEqual(direct, [a.id]);
    // 无白名单时同一包缺席（策展门生效）
    assert.deepEqual(repoMod.buildMarketplaceRepo(registry, { env: {} }).manifest.plugins, []);
  } finally { await cleanup(); }
});

test("MCP 只做指引：插件本体无 mcpServers 键、README 给端点与凭据说明", async () => {
  const { registry, cleanup } = await boot();
  try {
    const p = registry.publish({
      email: AUTHORS.email,
      manifest: manifest("D", { mcpServers: [{ registryName: "law-bench", requiredGroup: "legal" }] }),
    });
    registry.setCuration({ id: p.id, actor: ACTOR, category: "legal", featured: false });
    const built = repoMod.buildMarketplaceRepo(registry, { env: { FACET_REGISTRY_BASE: "https://reg.example" } });
    const files = built.plugins.get(p.id);
    const pluginJson = JSON.parse(files.get(".codebuddy-plugin/plugin.json"));
    assert.equal("mcpServers" in pluginJson, false);
    for (const [rel, text] of files) {
      assert.equal(/"mcpServers"\s*:/.test(text), false, `${rel} 不得出现 mcpServers 配置`);
    }
    const readme = files.get("README.md");
    assert.match(readme, /law-bench/);
    assert.match(readme, /https:\/\/reg\.example\/law-bench\/mcp/);
    assert.match(readme, /需要组：legal/);
  } finally { await cleanup(); }
});

test("connect/ 连接块：每客户端一份，形状随能力表选道而定，且不含真凭据", async () => {
  const { registry, cleanup } = await boot();
  try {
    const p = registry.publish({
      email: AUTHORS.email,
      manifest: manifest("F", { mcpServers: [{ registryName: "law-bench" }] }),
    });
    registry.setCuration({ id: p.id, actor: ACTOR, category: "legal", featured: false });
    const built = repoMod.buildMarketplaceRepo(registry, { env: { FACET_REGISTRY_BASE: "https://reg.example" } });
    const files = built.plugins.get(p.id);

    for (const client of ["workbuddy", "CC", "cursor", "zcode", "codex", "gemini-cli"]) {
      const raw = files.get(`connect/${client}.json`);
      assert.ok(raw, `缺 connect/${client}.json`);
      const doc = JSON.parse(raw);
      assert.equal(doc.client, client);
      assert.equal(doc.blocks.length, 1);
      const b = doc.blocks[0];
      assert.equal(b.endpoint, "https://reg.example/law-bench/mcp");
      assert.ok(b.laneReason, "选道必须给出可解释的理由");
      // workbuddy 5.9.x 用户文件不消费 clientId → 必须走 L2，写的是占位符
      if (client === "workbuddy") {
        assert.equal(b.lane, "L2");
        assert.equal(b.config.headers.Authorization, "Bearer " + "$" + "{FACET_ACCESS_TOKEN}");
        assert.equal(b.credentialShape, "short-lived access token in a static header");
      }
    }

    const readme = files.get("connect/README.md");
    assert.match(readme, /按客户端/);
    assert.match(readme, /workbuddy/);
    assert.match(readme, /不消费静态 client_id/);

    // 连接块不得含真凭据：占位符是"去取"的指令，不是密钥
    for (const [rel, text] of files) {
      assert.equal(/Bearer (?!\$\{)[A-Za-z0-9._-]{20,}/.test(text), false, `${rel} 含疑似真令牌`);
      assert.equal(/wgk-[A-Za-z0-9_-]{8,}/.test(text), false, `${rel} 含调用键`);
    }
  } finally { await cleanup(); }
});

test("connect/：无 MCP 引用的包不长出空的 connect 目录", async () => {
  const { registry, cleanup } = await boot();
  try {
    const p = registry.publish({ email: AUTHORS.email, manifest: manifest("G") });
    registry.setCuration({ id: p.id, actor: ACTOR, category: "data", featured: false });
    const built = repoMod.buildMarketplaceRepo(registry, { env: {} });
    const files = built.plugins.get(p.id);
    assert.equal([...files.keys()].some((r) => r.startsWith("connect/")), false);
  } finally { await cleanup(); }
});

test("路径安全：绝对路径 / .. / 盘符 / NUL 一律拒绝，不是清洗", async () => {
  const { registry, cleanup } = await boot();
  try {
    for (const bad of ["/etc/passwd", "../escape.md", "C:\\win.ini", "a\0b.md"]) {
      const p = registry.publish({
        email: AUTHORS.email,
        manifest: manifest("E", { files: { [bad]: "x" } }),
      });
      registry.setCuration({ id: p.id, actor: ACTOR, category: "data", featured: false });
      assert.throws(
        () => repoMod.buildMarketplaceRepo(registry, { env: {} }),
        (e) => e.code === "UNSAFE_PATH" || e.code === "BAD_SEGMENT",
        `应拒绝 ${JSON.stringify(bad)}`,
      );
      registry.setUnlisted({ email: AUTHORS.email, id: p.id });
    }
  } finally { await cleanup(); }
});

test("凭据扫描：内容里出现键形态即拒绝导出", async () => {
  const { registry, cleanup } = await boot();
  try {
    const p = registry.publish({
      email: AUTHORS.email,
      manifest: {
        name: "Pack K",
        description: "k",
        skills: [{ name: "skill-k", description: "k", content: "\n用这把键：wgk-abcdefgh12345678\n" }],
      },
    });
    registry.setCuration({ id: p.id, actor: ACTOR, category: "data", featured: false });
    assert.throws(() => repoMod.buildMarketplaceRepo(registry, { env: {} }), (e) => e.code === "CREDENTIAL_IN_CONTENT");
  } finally { await cleanup(); }
});

test("自检：坏清单 / 缺目录 / 孤儿目录 三种都被拦", async () => {
  const ok = { name: "facet", owner: { name: "x" }, plugins: [{ name: "p1", source: "./plugins/p1", description: "d", version: "1" }] };
  const goodFiles = new Map([["p1", new Map([[".codebuddy-plugin/plugin.json", "{}"]])]]);
  assert.equal(repoMod.validateMarketplaceRepo({ manifest: ok, plugins: goodFiles }), true);

  // 缺目录
  assert.throws(
    () => repoMod.validateMarketplaceRepo({ manifest: ok, plugins: new Map() }),
    (e) => e.code === "SNAPSHOT_INVALID" && /plugin directory missing/.test(e.message),
  );
  // 孤儿目录（在盘不在册 → 下架后仍分发）
  const orphan = new Map([...goodFiles, ["p2", new Map([[".codebuddy-plugin/plugin.json", "{}"]])]]);
  assert.throws(
    () => repoMod.validateMarketplaceRepo({ manifest: ok, plugins: orphan }),
    (e) => e.code === "SNAPSHOT_INVALID" && /orphan/.test(e.message),
  );
  // 坏清单
  assert.throws(
    () => repoMod.validateMarketplaceRepo({ manifest: { name: "x" }, plugins: goodFiles }),
    (e) => e.code === "SNAPSHOT_INVALID",
  );
  // 重复条目
  const dup = { ...ok, plugins: [...ok.plugins, ...ok.plugins] };
  assert.throws(
    () => repoMod.validateMarketplaceRepo({ manifest: dup, plugins: goodFiles }),
    (e) => /duplicate entry/.test(e.message),
  );
});

test("落盘：writeMarketplaceRepo 生成真实文件树且可再自检", async () => {
  const { registry, cleanup } = await boot();
  const out = await mkdtemp(path.join(tmpdir(), "facet-repo-out-"));
  try {
    const a = seedListed(registry);
    const built = repoMod.buildMarketplaceRepo(registry, { env: {} });
    const stats = repoMod.writeMarketplaceRepo(built, out);
    assert.equal(stats.entries, 1);
    const man = JSON.parse(await readFile(path.join(out, ".codebuddy-plugin", "marketplace.json"), "utf8"));
    assert.equal(man.plugins[0].name, a.id);
    const md = await readFile(path.join(out, "plugins", a.id, "skills", "skill-a", "SKILL.md"), "utf8");
    assert.match(md, /# A 正文/);
    // 再走一遍读取→校验：产物本身必须能通过同一条闸
    const rebuilt = {
      manifest: man,
      plugins: new Map([[a.id, new Map([[".codebuddy-plugin/plugin.json", "{}"]])]]),
    };
    assert.equal(repoMod.validateMarketplaceRepo(rebuilt), true);
  } finally {
    await cleanup();
    await rm(out, { recursive: true, force: true });
  }
});

test("跨面一致性通过 HTTP 实证：仓库清单集合 == 端点清单集合", async () => {
  const { registry, cleanup } = await boot();
  try {
    const a = registry.publish({ email: AUTHORS.email, manifest: manifest("A") });
    registry.setCuration({ id: a.id, actor: ACTOR, category: "data", featured: false });
    const b = registry.publish({ email: AUTHORS.email, manifest: manifest("B") });
    registry.setCuration({ id: b.id, actor: ACTOR, category: "docs", featured: true });

    const app = express();
    app.use(express.json({ limit: "1mb" }));
    jsonMod.registerMarketplaceJson(app, { registry, resolveUser: () => null });
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.on("listening", r));
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/marketplace/marketplace.json`);
      const doc = await res.json();
      const endpointIds = doc.plugins.map((p) => p.name).sort();
      const repoIds = repoMod.buildMarketplaceRepo(registry, { env: {} })
        .manifest.plugins.map((p) => p.name).sort();
      assert.deepEqual(repoIds, endpointIds);
    } finally {
      server.close();
    }
  } finally { await cleanup(); }
});

// ── 端到端：导出脚本的 git 行为（三个真缺陷都是这里抓出来的）────────────
// ① 空仓无 HEAD 时必须提交（不能按"字节没变"判无变化）；② 内容无变化时不产
// 空提交；③ --push 在"无新提交但远端落后"时仍要推送。
const { execFileSync } = await import("node:child_process");
const SCRIPT = path.join(root, "..", "scripts", "export-marketplace-repo.mjs");

function gitIn(cwd, argv, allowFail = false) {
  try {
    return execFileSync("git", argv, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e) {
    if (allowFail) return null;
    throw e;
  }
}

async function runExport(args) {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });
}

test("端到端：空仓首跑提交、二跑不产空提交、--push 推上去", async () => {
  const { registry, dir, cleanup } = await boot();
  const work = await mkdtemp(path.join(tmpdir(), "facet-repo-e2e-"));
  try {
    const a = registry.publish({ email: AUTHORS.email, manifest: manifest("A") });
    registry.setCuration({ id: a.id, actor: ACTOR, category: "data", featured: false });
    const dbFile = path.join(dir, "packs.db");
    const out = path.join(work, "repo");
    const bare = path.join(work, "bare.git");

    gitIn(work, ["init", "-q", "--bare", bare]);
    await mkdir(out, { recursive: true });
    gitIn(out, ["init", "-q"]);
    gitIn(out, ["config", "user.email", "t@t.t"]);
    gitIn(out, ["config", "user.name", "t"]);
    gitIn(out, ["remote", "add", "origin", bare]);

    // ① 空仓首跑：必须提交（此前按字节比对会判"无变化"而永不提交）
    const first = await runExport(["--db", dbFile, "--out", out]);
    assert.equal(first.code, 0, first.out);
    assert.match(first.out, /已提交/);
    assert.ok(gitIn(out, ["log", "--oneline"]).length > 0, "首跑应产生提交");

    // ② 二跑：内容无变化 → 不产空提交
    const second = await runExport(["--db", dbFile, "--out", out]);
    assert.equal(second.code, 0, second.out);
    assert.match(second.out, /内容无变化/);
    assert.equal(gitIn(out, ["log", "--oneline"]).split("\n").length, 1);

    // ③ --push：远端落后时即使无新提交也要推上去
    const third = await runExport(["--db", dbFile, "--out", out, "--push"]);
    assert.equal(third.code, 0, third.out);
    assert.ok(gitIn(bare, ["log", "--oneline"]).length > 0, "远端应收到提交");
    // 幂等：再推一次仍成功
    const fourth = await runExport(["--db", dbFile, "--out", out, "--push"]);
    assert.equal(fourth.code, 0, fourth.out);
  } finally {
    await cleanup();
    await rm(work, { recursive: true, force: true });
  }
});

test("端到端：坏包导出失败且工作树保持上一份（last-good）", async () => {
  const { registry, dir, cleanup } = await boot();
  const work = await mkdtemp(path.join(tmpdir(), "facet-repo-e2e-bad-"));
  try {
    const good = registry.publish({ email: AUTHORS.email, manifest: manifest("A") });
    registry.setCuration({ id: good.id, actor: ACTOR, category: "data", featured: false });
    const dbFile = path.join(dir, "packs.db");
    const out = path.join(work, "repo");
    await runExport(["--db", dbFile, "--out", out]);
    const before = await readFile(path.join(out, ".codebuddy-plugin", "marketplace.json"), "utf8");

    // 注入一个带凭据形态的包 → 导出必须失败
    const bad = registry.publish({
      email: AUTHORS.email,
      manifest: { name: "坏包", description: "x", skills: [{ name: "leaky", description: "x", content: "\nwgk-abcdefgh12345678\n" }] },
    });
    registry.setCuration({ id: bad.id, actor: ACTOR, category: "data", featured: false });
    const fail = await runExport(["--db", dbFile, "--out", out]);
    assert.equal(fail.code, 1, fail.out);
    assert.match(fail.out, /CREDENTIAL_IN_CONTENT|导出被拒/);
    const after = await readFile(path.join(out, ".codebuddy-plugin", "marketplace.json"), "utf8");
    assert.equal(after, before, "last-good：上一份快照必须逐字节不变");
  } finally {
    await cleanup();
    await rm(work, { recursive: true, force: true });
  }
});

test("plugin.json 显式声明 skills（与客户端自带市场同形）", async () => {
  const { registry, cleanup } = await boot();
  try {
    const listed = registry.publish({ email: AUTHORS.email, manifest: manifest("A") });
    registry.setCuration({ id: listed.id, actor: ACTOR, category: "data", featured: false });
    const built = repoMod.buildMarketplaceRepo(registry, { env: {} });
    const pj = JSON.parse(built.plugins.get(listed.id).get(".codebuddy-plugin/plugin.json"));
    assert.deepEqual(pj.skills, ["./skills"]);
    // name/version must agree with the marketplace entry — the client's own
    // loader rejects a disagreement outright.
    const entry = built.manifest.plugins.find((p) => p.name === listed.id);
    assert.equal(pj.name, entry.name);
    assert.equal(pj.version, entry.version);
  } finally { await cleanup(); }
});

// ── 4.10 显示 v2 的外部投影 (overhaul-market-catalog-presentation) ──────────
test("facet.json sidecar：声明的 v2 字段逐字节随包；未声明不产文件", async () => {
  const { registry, cleanup } = await boot();
  try {
    const v2 = {
      ...manifest("V"),
      identity: { mark: { kind: "glyph", value: "柏" }, accent: "wire" },
      promise: "一句话承诺进 sidecar。",
      audience: ["data-eng"],
      outcomes: [{ title: "得到甲", detail: "说明甲" }, { title: "得到乙" }],
      examples: [{ title: "问甲", prompt: "示例甲？" }, { title: "问乙", prompt: "示例乙？" }],
      domain: ["data-eng"],
    };
    const p = registry.publish({ email: AUTHORS.email, manifest: v2 });
    registry.setCuration({ id: p.id, actor: ACTOR, category: "data" });
    const legacy = seedListed(registry);
    const built = repoMod.buildMarketplaceRepo(registry, { env: {} });

    const side = JSON.parse(built.plugins.get(p.id).get("facet.json"));
    // 逐字节：值 deep-equal manifest，市场投影不再三改写。
    assert.deepEqual(side.identity, v2.identity);
    assert.equal(side.promise, v2.promise);
    assert.deepEqual(side.audience, v2.audience);
    assert.deepEqual(side.outcomes, v2.outcomes);
    assert.deepEqual(side.examples, v2.examples);
    assert.deepEqual(side.domain, v2.domain);
    assert.equal(side.packId, p.id);
    // 未声明 v2 的存量包：不产 sidecar（缺席=逐字节不变的默认）。
    assert.equal(built.plugins.get(legacy.id).get("facet.json"), undefined);
  } finally {
    registry.close();
    await cleanup();
  }
});

test("清单结构不变：v2 包与存量包的 marketplace.json 条目/plugin.json 字段集恒等", async () => {
  const { registry, cleanup } = await boot();
  try {
    const legacy = seedListed(registry);
    const v2 = { ...manifest("V"), promise: "承诺不改机器契约。" };
    const p = registry.publish({ email: AUTHORS.email, manifest: v2 });
    registry.setCuration({ id: p.id, actor: ACTOR, category: "data" });
    const built = repoMod.buildMarketplaceRepo(registry, { env: {} });

    // 客户端加载器钉死的字段集——sidecar 之外的两份清单一个键不多。
    assert.deepEqual(built.manifest.plugins.map((e) => Object.keys(e).sort()),
      built.manifest.plugins.map(() => Object.keys(built.manifest.plugins[0]).sort()));
    const pjLegacy = JSON.parse(built.plugins.get(legacy.id).get(".codebuddy-plugin/plugin.json"));
    const pjV2 = JSON.parse(built.plugins.get(p.id).get(".codebuddy-plugin/plugin.json"));
    assert.deepEqual(Object.keys(pjLegacy).sort(), Object.keys(pjV2).sort());
    // plugin.json 的 description 仍是市场描述原值——promise 只归 README/sidecar。
    assert.equal(pjV2.description, `V 描述`);
  } finally {
    registry.close();
    await cleanup();
  }
});

test("README 首行优先承诺；无承诺回落描述（存量逐字节不变）", async () => {
  const { registry, cleanup } = await boot();
  try {
    const legacy = seedListed(registry);
    const v2 = { ...manifest("V"), promise: "README 的第一句话是承诺。" };
    const p = registry.publish({ email: AUTHORS.email, manifest: v2 });
    registry.setCuration({ id: p.id, actor: ACTOR, category: "data" });
    const built = repoMod.buildMarketplaceRepo(registry, { env: {} });

    const firstProse = (md) => md.split("\n").slice(1).find((l) => l.trim() !== "");
    assert.equal(firstProse(built.plugins.get(p.id).get("README.md")), "README 的第一句话是承诺。");
    assert.equal(firstProse(built.plugins.get(legacy.id).get("README.md")), "A 描述");
  } finally {
    registry.close();
    await cleanup();
  }
});
