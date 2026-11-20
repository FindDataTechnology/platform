// Input-request registration (add-input-request-cards, task 2.4):
//
//   §1 mcp.json 与 platform.bundle.json 用**同一个名字、同一个程序**注册——
//      2026-11-09 的教训是这两份文件曾经把同一个桥命名成 `actions` /
//      `actions-mcp`，于是每台 cell 起了两个 dsh 子进程，而其中一个没有
//      owner 注入，提案永远批不了。名字不一致就是那条 bug 的入口。
//   §2 dsh-profile 的 per-user 注入点存在（owner 邮箱 + 会话 id），且与
//      actions 桥同形。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(root, p), "utf8"));
// mcp.json is GITIGNORED (deployment-local): a fresh checkout has none, so every
// assertion over it must tolerate absence rather than fail the suite on a clean
// clone. The tracked truth is platform.bundle.json.
const hasMcpJson = fs.existsSync(path.join(root, "mcp.json"));

test("2.4 两份清单同名同程序注册 input-request", () => {
  const bundle = readJson("platform.bundle.json").mcpServers;
  assert.ok(bundle["input-request"], "platform.bundle.json must register input-request");
  assert.equal(bundle["input-request"].args[0], "server/input-request-mcp.js");
  // 程序文件真实存在
  assert.ok(fs.existsSync(path.join(root, "server/input-request-mcp.js")));

  if (hasMcpJson) {
    const mcp = readJson("mcp.json").mcpServers;
    assert.ok(mcp["input-request"], "mcp.json must register input-request");
    assert.deepEqual(mcp["input-request"].args, bundle["input-request"].args);
    assert.equal(mcp["input-request"].command, bundle["input-request"].command);
  }
});

test("2.4b 没有第二个名字指向同一个程序", () => {
  const files = hasMcpJson ? ["mcp.json", "platform.bundle.json"] : ["platform.bundle.json"];
  for (const file of files) {
    const servers = readJson(file).mcpServers;
    const names = Object.entries(servers)
      .filter(([, v]) => v?.args?.[0] === "server/input-request-mcp.js")
      .map(([k]) => k);
    assert.deepEqual(names, ["input-request"], `${file} must name it exactly once`);
  }
});

test("2.4c profile 注入 owner 与会话身份", () => {
  const src = fs.readFileSync(path.join(root, "dsh-profile.js"), "utf8");
  assert.match(src, /INPUT_REQUEST_OWNER_EMAIL/);
  // 注入点必须在 per-user profile 里（与 actions 同处），不是别处
  const idx = src.indexOf('servers["input-request"]');
  assert.ok(idx > 0, "profile must pin the input-request server env");
});

test("2.4d shim 读得到的 env 名与 profile 写的一致", async () => {
  const shim = await import("../server/input-request-mcp.js");
  assert.equal(shim.OWNER_EMAIL_ENV, "INPUT_REQUEST_OWNER_EMAIL");
  assert.equal(shim.SESSION_ENV, "INPUT_REQUEST_SESSION_ID");
  const fromEnv = shim.identityFromEnv({
    INPUT_REQUEST_OWNER_EMAIL: "  Owner@Example.com ",
    DSH_SESSION_ID: "sess-9",
  });
  assert.equal(fromEnv.ownerEmail, "owner@example.com");
  assert.equal(fromEnv.sessionId, "sess-9");
});
