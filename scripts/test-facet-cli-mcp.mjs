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

test("install 持键 + --write-mcp：六 target 各写原生形状", async () => {
  const server = await stubFacet();
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    await withFakeHome((home) => seedKey(home, base), async (home, _proj) => {
      for (const target of ["claude-code", "cursor", "zcode", "gemini-cli", "codex", "workbuddy"]) {
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
      // workbuddy：独立 dotdir，http 形状
      const wb = JSON.parse(await readFile(path.join(home, ".workbuddy", "mcp.json"), "utf8"));
      assert.equal(wb.mcpServers["law-bench"].type, "http");
      assert.equal(wb.mcpServers["law-bench"].url, `${base}/law-bench/mcp`);
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

// ── WorkBuddy (add-workbuddy-mcp-lane) ──────────────────────────────────────
// One root, verified on a real install 2026-10-30 (which disproved the
// earlier ".codebuddy" reading): skills at ~/.workbuddy/skills, MCP at
// ~/.workbuddy/mcp.json — see docs/ecosystem/workbuddy.md.
// Two connection forms: header-keyed (wgk-) and keyless OAuth — the entry
// carries oauth.clientId (static client, DCR short-circuited), live-verified
// end-to-end 2026-10-30 (Logto native app + gateway audience patch).
test("install 持键 + --write-mcp：workbuddy 写 .workbuddy/mcp.json 的 http 形状", async () => {
  const server = await stubFacet();
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    await withFakeHome((home) => seedKey(home, base), async (home, _proj) => {
      const { stdout } = await install(home, ["--target", "workbuddy", "--registry", base, "--base", base, "--write-mcp"]);
      assert.match(stdout, /MCP 连接配置已写入/);
      const doc = JSON.parse(await readFile(path.join(home, ".workbuddy", "mcp.json"), "utf8"));
      const entry = doc.mcpServers["law-bench"];
      assert.equal(entry.type, "http");
      assert.equal(entry.url, `${base}/law-bench/mcp`);
      assert.equal(entry.headers.Authorization, "Bearer wgk-good");
      // The sibling client's file must not be touched by this target.
      await assert.rejects(() => stat(path.join(home, ".claude.json")));
      await assert.rejects(() => stat(path.join(home, ".codebuddy", "mcp.json")));
    });
  } finally { server.close(); }
});

test("install 持键 + --write-mcp + --project：workbuddy 写项目级 .workbuddy/mcp.json", async () => {
  const server = await stubFacet();
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    await withFakeHome((home) => seedKey(home, base), async (home, proj) => {
      await install(home, ["--target", "workbuddy", "--project", proj, "--registry", base, "--base", base, "--write-mcp"]);
      const pj = JSON.parse(await readFile(path.join(proj, ".workbuddy", "mcp.json"), "utf8"));
      assert.equal(pj.mcpServers["law-bench"].url, `${base}/law-bench/mcp`);
      assert.equal(pj.mcpServers["law-bench"].type, "http");
      await assert.rejects(() => stat(path.join(home, ".workbuddy", "mcp.json"))); // 用户级未被误写
    });
  } finally { server.close(); }
});

test("workbuddy 技能落盘在 .workbuddy/skills（用户级与项目级；真机实测）", async () => {
  await withFakeHome(null, async (home, proj) => {
      // No skills in DETAIL, so this asserts the resolved directory itself
      // rather than a file (the target resolution is what can drift).
      const { targetDir } = await import("../facet/cli/facet.js");
      // The module resolves FACET_HOME per call, but this process's env is the
      // harness's — point it at the sandbox home for the duration.
      const prevHome = process.env.FACET_HOME;
      process.env.FACET_HOME = home;
      const user = targetDir({ target: "workbuddy", project: null });
      assert.equal(user.dir, path.join(home, ".workbuddy", "skills"));
      assert.equal(user.scope, "用户级");
      const inProject = targetDir({ target: "workbuddy", project: proj });
      assert.equal(inProject.dir, path.join(path.resolve(proj), ".workbuddy", "skills"));
      assert.equal(inProject.scope, "项目级");
      process.env.FACET_HOME = prevHome;
  });
});

// ── WorkBuddy 免键(OAuth)车道 (--oauth) ─────────────────────────────────────
// 静态 oauth.clientId 使客户端 OAuth provider 的 clientInformation() 立即返回，
// SDK 不再触达动态注册——2026-10-30 生产端到端实证（Native app facet-mcp-keyless
// + 网关 LOGTO_ACCEPTED_AUDIENCES 补丁 sha-c216f47），配方见 docs/ecosystem/workbuddy.md。

test("install --oauth --write-mcp：workbuddy 写免键条目——oauth.clientId 形状、零凭据落盘（本地无键也能走）", async () => {
  const server = await stubFacet();
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    await withFakeHome(null, async (home, _proj) => { // 注意：未 seedKey——免键不依赖 wgk-
      const { stdout } = await install(home, ["--target", "workbuddy", "--registry", base, "--base", base, "--oauth", "--write-mcp"]);
      assert.match(stdout, /MCP 免键连接配置已写入/);
      const doc = JSON.parse(await readFile(path.join(home, ".workbuddy", "mcp.json"), "utf8"));
      const entry = doc.mcpServers["law-bench"];
      assert.equal(entry.type, "http");
      assert.equal(entry.url, `${base}/law-bench/mcp`);
      // 断言语义与具体值无关（具体值随 facet.js DEFAULT_OAUTH_CLIENT_ID 走，生产
      // facet-mcp-keyless 2026-10-30 端到端实证）：只验证默认写入了「那个」id——
      // 非空形状 + 两个目标同 id。字面量不上板（公开快照的 gitleaks 会命中）。
      const keylessClientId = entry.oauth.clientId;
      assert.ok(typeof keylessClientId === "string" && keylessClientId.length >= 8, "the keyless default client id rides");
      assert.equal(doc.mcpServers["fd-open-data-mcp"].oauth.clientId, keylessClientId, "same keyless client across targets");
      assert.match(entry.oauth.scope, /gateway:access/);
      assert.match(entry.oauth.scope, /offline_access/);
      assert.equal(entry.headers, undefined); // 免键：任何 Authorization 不落这个文件
      // requiredGroup 提示改用「授权账号/角色」口径
      assert.match(stdout, /授权账号不持该角色/);
    });
  } finally { server.close(); }
});

test("install --oauth --oauth-client <id>：client_id 可覆盖", async () => {
  const server = await stubFacet();
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    await withFakeHome(null, async (home, _proj) => {
      await install(home, ["--target", "workbuddy", "--registry", base, "--base", base,
        "--oauth", "--oauth-client", "custom-client-x", "--write-mcp"]);
      const doc = JSON.parse(await readFile(path.join(home, ".workbuddy", "mcp.json"), "utf8"));
      assert.equal(doc.mcpServers["law-bench"].oauth.clientId, "custom-client-x");
    });
  } finally { server.close(); }
});

test("install --oauth 未 --write-mcp（非 TTY）：只引用不写入", async () => {
  const server = await stubFacet();
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    await withFakeHome(null, async (home, _proj) => {
      const { stdout } = await install(home, ["--target", "workbuddy", "--registry", base, "--base", base, "--oauth"]);
      assert.match(stdout, /--oauth 但未写入/);
      await assert.rejects(() => stat(path.join(home, ".workbuddy", "mcp.json")));
    });
  } finally { server.close(); }
});

test("install --oauth 目标非 workbuddy：明确拒绝（免键仅实证于 workbuddy）", async () => {
  const server = await stubFacet();
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    await withFakeHome(null, async (home, _proj) => {
      await assert.rejects(
        () => install(home, ["--target", "cursor", "--registry", base, "--base", base, "--oauth", "--write-mcp"]),
        /未证实免键/,
      );
      await assert.rejects(() => stat(path.join(home, ".cursor", "mcp.json")));
    });
  } finally { server.close(); }
});

test("install 无键 workbuddy：提示里给出 --oauth 免键出路", async () => {
  const server = await stubFacet();
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    await withFakeHome(null, async (home, _proj) => {
      const { stdout } = await install(home, ["--target", "workbuddy", "--registry", base, "--base", base]);
      assert.match(stdout, /workbuddy 亦可免键/);
      assert.match(stdout, /--oauth/);
    });
  } finally { server.close(); }
});
