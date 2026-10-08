// facet CLI install × MCP 配置写入（ecosystem-bridge 2.3）
// 五 target 真进程实测：持键 + 同意 → 写原生配置；无键/拒写 → v1 行为。
// 运行：node --test scripts/test-facet-cli-mcp.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const CLI = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "facet", "cli", "facet.js");
const PACK_ID = "stub-pack";
const DETAIL = {
  id: PACK_ID, name: "Stub Pack", version: 3,
  manifest: {
    skills: [],
    mcpServers: [
      { registryName: "law-bench", requiredGroup: "legal" },
      { registryName: "fd-open-data-mcp" },
    ],
  },
};

async function stubFacet() {
  const server = http.createServer((req, res) => {
    if (req.url === `/api/packs/${PACK_ID}`) {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(DETAIL));
    } else {
      res.writeHead(404).end("{}");
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return server;
}

async function withFakeHome(prepare, fn) {
  const home = await mkdtemp(path.join(tmpdir(), "facet-mcp-home-"));
  const proj = await mkdtemp(path.join(tmpdir(), "facet-mcp-proj-"));
  try {
    if (prepare) await prepare(home);
    await fn(home, proj);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(proj, { recursive: true, force: true });
  }
}

async function seedKey(home, registryBase) {
  const dir = path.join(home, ".facet");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "credentials.json"),
    JSON.stringify({ key: "wgk-good", registry: registryBase, verifiedAt: new Date().toISOString() }),
    "utf8",
  );
}

const install = (home, args) => run(process.execPath, [CLI, "install", PACK_ID, ...args], {
  env: { ...process.env, FACET_HOME: home },
});

test("install 无键：MCP 提示照旧，不产生任何 MCP 配置文件", async () => {
  const server = await stubFacet();
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    await withFakeHome(null, async (home, proj) => {
      const { stdout } = await install(home, ["--target", "zcode", "--project", proj, "--registry", base, "--base", base]);
      assert.match(stdout, /未写入任何编辑器配置/);
      assert.match(stdout, /facet connect/);
      await assert.rejects(() => stat(path.join(home, ".zcode", "cli", "config.json")));
    });
  } finally { server.close(); }
});

test("install 持键 + --no-write-mcp：提示持键但零写入", async () => {
  const server = await stubFacet();
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    await withFakeHome((home) => seedKey(home, base), async (home, proj) => {
      const { stdout } = await install(home, ["--target", "cursor", "--project", proj, "--registry", base, "--base", base, "--no-write-mcp"]);
      assert.match(stdout, /持键但未写入/);
      await assert.rejects(() => stat(path.join(home, ".cursor", "mcp.json")));
    });
  } finally { server.close(); }
});

test("install 持键 + --write-mcp：五 target 各写原生形状", async () => {
  const server = await stubFacet();
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    await withFakeHome((home) => seedKey(home, base), async (home, proj) => {
      for (const target of ["claude-code", "cursor", "zcode", "gemini-cli", "codex"]) {
        const { stdout } = await install(home, ["--target", target, "--registry", base, "--base", base, "--write-mcp"]);
        assert.match(stdout, /MCP 连接配置已写入/, `${target} 应报告写入`);
      }
      // claude-code：用户级 ~/.claude.json
      const claude = JSON.parse(await readFile(path.join(home, ".claude.json"), "utf8"));
      assert.equal(claude.mcpServers["law-bench"].type, "http");
      assert.equal(claude.mcpServers["law-bench"].url, `${base}/law-bench/mcp`);
      assert.equal(claude.mcpServers["law-bench"].headers.Authorization, "Bearer wgk-good");
      // cursor：{url,headers}
      const cursor = JSON.parse(await readFile(path.join(home, ".cursor", "mcp.json"), "utf8"));
      assert.equal(cursor.mcpServers["fd-open-data-mcp"].url, `${base}/fd-open-data-mcp/mcp`);
      // zcode：mcp.servers 容器
      const zcode = JSON.parse(await readFile(path.join(home, ".zcode", "cli", "config.json"), "utf8"));
      assert.equal(zcode.mcp.servers["law-bench"].type, "http");
      // gemini-cli：httpUrl
      const gemini = JSON.parse(await readFile(path.join(home, ".gemini", "settings.json"), "utf8"));
      assert.equal(gemini.mcpServers["law-bench"].httpUrl, `${base}/law-bench/mcp`);
      // codex：TOML 块
      const toml = await readFile(path.join(home, ".codex", "config.toml"), "utf8");
      assert.match(toml, /\[mcp_servers\.law-bench\]/);
      assert.match(toml, /http_headers = \{ "Authorization" = "Bearer wgk-good" \}/);
      assert.equal(toml.match(/\[mcp_servers\.law-bench\]/g).length, 1); // 幂等，无重复块
    });
  } finally { server.close(); }
});

test("install 持键 + --write-mcp + --project：claude-code 写项目级 .mcp.json", async () => {
  const server = await stubFacet();
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    await withFakeHome((home) => seedKey(home, base), async (home, proj) => {
      await install(home, ["--target", "claude-code", "--project", proj, "--registry", base, "--base", base, "--write-mcp"]);
      const pj = JSON.parse(await readFile(path.join(proj, ".mcp.json"), "utf8"));
      assert.equal(pj.mcpServers["law-bench"].url, `${base}/law-bench/mcp`);
      await assert.rejects(() => stat(path.join(home, ".claude.json"))); // 用户级未被误写
    });
  } finally { server.close(); }
});
