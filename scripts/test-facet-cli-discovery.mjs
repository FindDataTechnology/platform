// ── facet CLI: 不知道 id 也能用；更新不串市场 ────────────────────────────────
//
//   node --test scripts/test-facet-cli-discovery.mjs
//
// 钉住的契约（fix-supply-machine-faces / facet-editor-cli + facet-platform）：
//   · list 打印的 id 就是 install 接受的那个字符串；
//   · search 复用市场查询语义，空结果显式说「无匹配」而不是空表；
//   · --json 出原始行；--line 透传成目录的 category 过滤；
//   · 目录不可达时报出尝试的 base，且不打印半截目录，退出码非零；
//   · install 把 --base 落进 installed.json；update 沿用它（自部署不被带回
//     官方市场）；老记录没有 base 时回落官方并在报告里明说。
//
// 全程跑真 CLI（child process）+ 本地 stub 目录，不打网络、不碰真 HOME。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";

const CLI = path.resolve(import.meta.dirname, "..", "facet", "cli", "facet.js");

const PACKS = [
  { id: "lex-contract-review", name: "合同审查", version: "3", category: "lex", description: "商事合同条款风险审查" },
  { id: "wire-agri-chain", name: "农产链", version: "2", category: "wire", description: "农业成本链数据" },
];

/** A stub marketplace that honours the same query params the real API does. */
function startMarket(handler) {
  const hits = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    hits.push(url.pathname + url.search);
    const send = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/api/packs") {
      const search = url.searchParams.get("search") ?? "";
      const category = url.searchParams.get("category") ?? "";
      const size = Number(url.searchParams.get("pageSize") ?? 50);
      let rows = PACKS;
      if (search) rows = rows.filter((p) => p.name.includes(search) || p.description.includes(search));
      if (category) rows = rows.filter((p) => p.category === category);
      return send(200, { total: rows.length, page: 1, pageSize: size, packs: rows.slice(0, size) });
    }
    const m = url.pathname.match(/^\/api\/packs\/(.+)$/);
    if (m) {
      const pack = PACKS.find((p) => p.id === decodeURIComponent(m[1]));
      if (!pack) return send(404, { error: "not found" });
      return send(200, { ...pack, manifest: { skills: [] } });
    }
    if (handler) return handler(req, res);
    send(404, { error: "no route" });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      resolve({ base, hits, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "facet-cli-"));
  const installed = path.join(home, "installed.json");
  const env = {
    ...process.env,
    HOME: home,
    FACET_INSTALLED_PATH: installed,
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
  };
  return { home, installed, env };
}

function run(args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env, timeout: 20000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr });
    });
  });
}

test("list prints ids that install accepts, and honours --line / --json", async () => {
  const market = await startMarket();
  const { env } = sandbox();
  try {
    const all = await run(["list", "--base", market.base], env);
    assert.equal(all.code, 0, all.stderr);
    assert.match(all.stdout, /lex-contract-review\s+v3/);
    assert.match(all.stdout, /wire-agri-chain\s+v2/);
    assert.match(all.stdout, /install <id>/, "shows the install command");
    assert.match(all.stdout, new RegExp(`--base ${market.base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), "self-host base echoed in the install hint");

    const lex = await run(["list", "--base", market.base, "--line", "lex"], env);
    assert.equal(lex.code, 0);
    assert.match(lex.stdout, /lex-contract-review/);
    assert.equal(lex.stdout.includes("wire-agri-chain"), false, "--line filters");

    const json = await run(["list", "--base", market.base, "--json"], env);
    const rows = JSON.parse(json.stdout);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].id, "lex-contract-review", "raw server rows, untouched");
  } finally {
    await market.close();
  }
});

test("search narrows and says so when nothing matches", async () => {
  const market = await startMarket();
  const { env } = sandbox();
  try {
    const hit = await run(["search", "合同", "--base", market.base], env);
    assert.equal(hit.code, 0, hit.stderr);
    assert.match(hit.stdout, /lex-contract-review/);
    assert.equal(hit.stdout.includes("wire-agri-chain"), false);

    const miss = await run(["search", "不存在的词", "--base", market.base], env);
    assert.equal(miss.code, 0);
    assert.match(miss.stdout, /无匹配/);
    assert.equal(miss.stdout.includes("install <id>"), false, "no install hint on an empty result");
  } finally {
    await market.close();
  }
});

test("an unreachable market names the base and prints no partial catalog", async () => {
  const { env } = sandbox();
  const dead = await new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => resolve(`http://127.0.0.1:${port}`));
    });
  });
  const r = await run(["list", "--base", dead], env);
  assert.notEqual(r.code, 0, "must exit non-zero");
  const out = r.stdout + r.stderr;
  assert.ok(out.includes(dead), "names the base it tried");
  assert.equal(out.includes("lex-contract-review"), false, "no rows printed");
});

test("install records its base and update keeps using that market", async () => {
  const market = await startMarket();
  const { env, installed } = sandbox();
  try {
    const inst = await run(["install", "lex-contract-review", "--base", market.base], env);
    assert.equal(inst.code, 0, inst.stderr);
    const recs = JSON.parse(fs.readFileSync(installed, "utf8"));
    const rec = (recs.installs ?? [])[0];
    assert.equal(rec.base, market.base, "base persisted with the install");

    // Point the "official" default at a dead host: if update falls back to it,
    // the run fails loudly — so a green update proves it used the record.
    const before = market.hits.length;
    const up = await run(["update"], { ...env, FACET_BASE: "http://127.0.0.1:1" });
    assert.equal(up.code, 0, up.stderr);
    assert.match(up.stdout, /随记录/);
    assert.ok(market.hits.length > before, "the recorded market was called");
  } finally {
    await market.close();
  }
});

test("a legacy record without base falls back to official and says so", async () => {
  const market = await startMarket();
  const { env, installed } = sandbox();
  try {
    fs.writeFileSync(
      installed,
      JSON.stringify({
        installs: [{ packId: "lex-contract-review", name: "合同审查", target: "claude-code", scope: "用户级", version: "3" }],
      }),
    );
    // The official base is stubbed to the live local market for this run.
    const up = await run(["update"], { ...env, FACET_BASE: market.base });
    assert.equal(up.code, 0, up.stderr);
    assert.match(up.stdout, /记录无 base/);
    assert.match(up.stdout, /默认官方市场/);
  } finally {
    await market.close();
  }
});
