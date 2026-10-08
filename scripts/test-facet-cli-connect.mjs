// facet CLI connect（ecosystem-bridge）——存取纪律 + 验活三态 + 端到端
// 运行：node --test scripts/test-facet-cli-connect.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";

const CLI = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "facet", "cli", "facet.js");
const { parseArgs, loadCredentials, clearCredentials, maskKey, verifyCallerKey, connectRun, discoverDeviceAuth, deviceFlow, credentialsPath } =
  await import(pathToFileURL(CLI).href);

test("parseArgs: connect 的 --clear 是布尔，prefs 的 --clear 取值", () => {
  assert.equal(parseArgs(["connect", "--clear"]).clear, true);
  assert.equal(parseArgs(["prefs", "x", "--clear", "callback"]).clear, "callback");
});

test("maskKey 只露头尾", () => {
  assert.equal(maskKey("wgk-abcdefghijk"), "wgk-…hijk");
  assert.equal(maskKey(null), "（未存）");
});

async function withTempCreds(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "facet-connect-test-"));
  const prev = process.env.FACET_CREDENTIALS_PATH;
  process.env.FACET_CREDENTIALS_PATH = path.join(dir, "credentials.json");
  try {
    await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.FACET_CREDENTIALS_PATH;
    else process.env.FACET_CREDENTIALS_PATH = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

function stubRegistry({ keysStatus = 200 } = {}) {
  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization || "";
    if (req.url === "/api/patch-keys") {
      if (auth !== "Bearer wgk-good") {
        res.writeHead(401).end('{"error":"invalid key"}');
      } else {
        res.writeHead(keysStatus).end('{"keys":[]}');
      }
    } else if (req.url === "/api/servers") {
      if (auth !== "Bearer wgk-good") res.writeHead(401).end("{}");
      else res.writeHead(200).end('[{"name":"fd-open-data-mcp"},{"name":"fd-cn-report"}]');
    } else {
      res.writeHead(404).end("{}");
    }
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}
const baseOf = (server) => `http://127.0.0.1:${server.address().port}`;

test("verifyCallerKey: 活键 200 → ok 且带可见 server；死键 401 → 指名拒绝", async () => {
  const server = await stubRegistry();
  try {
    const ok = await verifyCallerKey(baseOf(server), "wgk-good");
    assert.deepEqual(ok.servers, ["fd-open-data-mcp", "fd-cn-report"]);
    await assert.rejects(() => verifyCallerKey(baseOf(server), "wgk-dead"), /401.*无效|吊销/);
  } finally {
    server.close();
  }
});

test("verifyCallerKey: 注册处不可达 → 指名拒绝", async () => {
  await assert.rejects(() => verifyCallerKey("http://127.0.0.1:9", "wgk-good"), /不可达/);
});

test("connectRun: 死键拒绝且不落盘", async () => {
  await withTempCreds(async () => {
    const server = await stubRegistry();
    try {
      await assert.rejects(() => connectRun({ registry: baseOf(server), key: "wgk-dead" }), /未存任何内容/);
      assert.equal(await loadCredentials(), null);
    } finally {
      server.close();
    }
  });
});

test("connectRun: 非 wgk- 前缀直接拒绝且不落盘", async () => {
  await withTempCreds(async () => {
    await assert.rejects(() => connectRun({ registry: "http://127.0.0.1:9", key: "sk-else" }), /wgk-/);
    assert.equal(await loadCredentials(), null);
  });
});

test("connectRun: 活键落盘 0600，--show 可读，--clear 清除", async () => {
  await withTempCreds(async (dir) => {
    const server = await stubRegistry();
    try {
      await connectRun({ registry: baseOf(server), key: " wgk-good " });
      const file = credentialsPath();
      assert.equal(((await stat(file)).mode & 0o777), 0o600);
      const doc = JSON.parse(await readFile(file, "utf8"));
      assert.equal(doc.key, "wgk-good"); // 粘贴输入两侧空白被裁
      assert.deepEqual(doc.servers, ["fd-open-data-mcp", "fd-cn-report"]);
      await clearCredentials();
      assert.equal(await loadCredentials(), null);
    } finally {
      server.close();
    }
  });
});

test("CLI 冒烟：--version 与 connect --show（无键）", async () => {
  await withTempCreds(async () => {
    const version = await new Promise((res, rej) =>
      execFile(process.execPath, [CLI, "--version"], (e, out) => (e ? rej(e) : res(out.trim()))));
    assert.match(version, /^\d+\.\d+\.\d+/);
    const show = await new Promise((res, rej) =>
      execFile(process.execPath, [CLI, "connect", "--show"], (e, out) => (e ? rej(e) : res(out))));
    assert.match(show, /未存调用键/);
  });
});

// npm/npx install the bin as a symlink in node_modules/.bin, so the entry
// runs with argv[1] = the link and import.meta.url = the real file. The
// original main-guard compared those raw and the CLI exited silently with no
// output at all (0.2.0 regression) — this test pins the symlinked path.
test("CLI 冒烟：经符号链接调用（npx 形态）仍输出", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "facet-symlink-"));
  const link = path.join(dir, "facet");
  await symlink(CLI, link);
  try {
    const version = await new Promise((res, rej) =>
      execFile(process.execPath, [link, "--version"], (e, out) => (e ? rej(e) : res(out.trim()))));
    assert.match(version, /^\d+\.\d+\.\d+/);
    const help = await new Promise((res, rej) =>
      execFile(process.execPath, [link, "--help"], (e, out) => (e ? rej(e) : res(out))));
    assert.match(help, /用法：/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── device flow（2.4）：谱系侧未暴露 → null 回落；暴露 → RFC 8628 走通 ──

test("discoverDeviceAuth: 未暴露 well-known → null（回落粘贴流）", async () => {
  const server = await stubRegistry();
  try {
    // stubRegistry 只有 /api/*，.well-known 落 404 → catch 走 null
    assert.equal(await discoverDeviceAuth(baseOf(server)), null);
  } finally {
    server.close();
  }
});

test("deviceFlow: 授权挂起一次后发键；connectRun 走设备分支落盘", async () => {
  await withTempCreds(async () => {
    let tokenPolls = 0;
    const server = http.createServer((req, res) => {
      const auth = req.headers.authorization || "";
      if (req.url === "/.well-known/oauth-authorization-server") {
        res.writeHead(200).end(JSON.stringify({
          device_authorization_endpoint: `${baseOf(server)}/device`,
          token_endpoint: `${baseOf(server)}/token`,
        }));
      } else if (req.url === "/device") {
        res.writeHead(200).end(JSON.stringify({
          device_code: "dev-1", user_code: "WGK-CODE",
          verification_uri: `${baseOf(server)}/activate`, interval: 1,
        }));
      } else if (req.url === "/token") {
        tokenPolls += 1;
        if (tokenPolls === 1) res.writeHead(400).end(JSON.stringify({ error: "authorization_pending" }));
        else res.writeHead(200).end(JSON.stringify({ access_token: "wgk-good" }));
      } else if (req.url === "/api/patch-keys") {
        if (auth !== "Bearer wgk-good") res.writeHead(401).end("{}");
        else res.writeHead(200).end('{"keys":[]}');
      } else if (req.url === "/api/servers") {
        res.writeHead(200).end('[{"name":"fd-open-data-mcp"}]');
      } else {
        res.writeHead(404).end("{}");
      }
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const base = baseOf(server);
    try {
      const codes = [];
      const token = await deviceFlow(base, {
        device_authorization_endpoint: `${base}/device`,
        token_endpoint: `${base}/token`,
      }, { noOpen: true, onCode: (d) => codes.push(d.user_code) });
      assert.equal(token, "wgk-good");
      assert.deepEqual(codes, ["WGK-CODE"]);
      assert.ok(tokenPolls >= 2, "应经历一次挂起轮询");
      await connectRun({ registry: base }); // 无 --key → 发现设备授权 → 免粘贴
      const doc = await loadCredentials();
      assert.equal(doc.key, "wgk-good");
    } finally {
      server.close();
    }
  });
});
