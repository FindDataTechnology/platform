#!/usr/bin/env node
// ── 形状核对器：必须能变红 ──────────────────────────────────────────────────
//
// 这个核对器的用途是「第一次接真接口时，一眼看出哪个字段变了」。因此它的验收标准
// 不是"通过时返回 ok"，而是**遇到漂移时会红**。三类漂移各造一个样本：
//   1. send_time 变成毫秒（13 位）
//   2. origin 变成字符串
//   3. msg_list / next_cursor 改名
//
// 另外跑一遍真 HTTP：用本地 qyapi 桩喂它，证明"按文档抄的形状"能过；
// 再让桩故意返回漂移形状，证明它确实会拦住。
//
//   node --test scripts/test-kf-verify-shape.mjs

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const { verifyShape, shapeLine, looksLikeSeconds } = await import(
  "../server/archive/kf/verify-shape.js"
);

const ROOT = path.resolve(import.meta.dirname, "..");
const STUB = path.join(ROOT, "tools", "kf-api-stub", "server.mjs");
const VERIFY = path.join(ROOT, "scripts", "kf-verify-real.mjs");

const SEND_SECONDS = Math.floor(Date.parse("2026-11-11T10:00:00Z") / 1000);

const TOKEN_OK = { errcode: 0, access_token: "T".repeat(20), expires_in: 7200 };
const ACCOUNTS_OK = { errcode: 0, account_list: [{ open_kfid: "kf1", name: "寻数科技客服" }] };
const MSG_OK = {
  msgid: "m1",
  open_kfid: "kf1",
  external_userid: "wmCUST",
  send_time: SEND_SECONDS,
  origin: 3,
  msgtype: "text",
  text: { content: "在吗" },
};
const SYNC_OK = { errcode: 0, next_cursor: "c1", has_more: 0, msg_list: [MSG_OK] };

test("文档形态全部相符时通过", () => {
  const r = verifyShape({ token: TOKEN_OK, accounts: ACCOUNTS_OK, sync: SYNC_OK });
  assert.equal(r.ok, true, r.drift.join("\n"));
  assert.ok(r.total >= 12, `只有 ${r.total} 项，覆盖不足`);
  assert.ok(shapeLine(r).includes("通过"));
});

test("漂移一：send_time 变成毫秒 → 变红", () => {
  const r = verifyShape({ sync: { ...SYNC_OK, msg_list: [{ ...MSG_OK, send_time: SEND_SECONDS * 1000 }] } });
  assert.equal(r.ok, false);
  const bad = r.checks.find((c) => c.name === "msg[0].send_time 是秒级");
  assert.ok(bad && !bad.ok, JSON.stringify(r.checks.map((c) => c.name)));
  assert.ok(bad.note.includes("毫秒"));
});

test("漂移二：origin 变成字符串 → 变红（否则客户发言会被当 unknown 丢掉）", () => {
  const r = verifyShape({ sync: { ...SYNC_OK, msg_list: [{ ...MSG_OK, origin: "3" }] } });
  assert.equal(r.ok, false);
  const bad = r.checks.find((c) => c.name === "msg[0].origin 是数字 3/4/5");
  assert.ok(bad && !bad.ok);
  assert.ok(bad.note.includes("unknown"));
});

test("漂移三：msg_list 改名 → 变红", () => {
  const { msg_list, ...renamed } = SYNC_OK;
  const r = verifyShape({ sync: { ...renamed, messages: msg_list } });
  assert.equal(r.ok, false);
  assert.ok(r.checks.some((c) => c.name === "sync_msg.msg_list 是数组" && !c.ok));
});

test("漂移四：next_cursor 变成数字 → 变红", () => {
  const r = verifyShape({ sync: { ...SYNC_OK, next_cursor: 12345 } });
  assert.equal(r.ok, false);
  assert.ok(r.checks.some((c) => c.name.includes("next_cursor") && !c.ok));
});

test("窗口内无消息：明确 skip 说明，不冒充通过", () => {
  const r = verifyShape({ token: TOKEN_OK, accounts: ACCOUNTS_OK, sync: { ...SYNC_OK, msg_list: [] } });
  assert.equal(r.ok, false);
  const c = r.checks.find((x) => x.name === "窗口内有消息可核对");
  assert.ok(c && !c.ok);
  assert.ok(c.note.includes("从微信侧给客服号发一条"));
});

test("客服账号为空：点名可能是应用未被选为可调用", () => {
  const r = verifyShape({ accounts: { errcode: 0, account_list: [] } });
  assert.equal(r.ok, false);
  const c = r.checks.find((x) => x.name === "account_list 非空");
  assert.ok(c.note.includes("可调用接口的应用"));
});

test("未知 msgtype：变红并提示需要补解析器", () => {
  const r = verifyShape({ sync: { ...SYNC_OK, msg_list: [{ ...MSG_OK, msgtype: "brand_new" }] } });
  assert.equal(r.ok, false);
  const c = r.checks.find((x) => x.name.includes("msgtype"));
  assert.ok(c && !c.ok && c.note.includes("补解析器"));
});

test("图片类型必须带 media_id", () => {
  const ok = verifyShape({
    sync: { ...SYNC_OK, msg_list: [{ ...MSG_OK, msgtype: "image", image: { media_id: "MID" } }] },
  });
  assert.equal(ok.ok, true, ok.drift.join("\n"));
  const bad = verifyShape({
    sync: { ...SYNC_OK, msg_list: [{ ...MSG_OK, msgtype: "image", image: {} }] },
  });
  assert.equal(bad.ok, false);
});

test("looksLikeSeconds 边界", () => {
  assert.equal(looksLikeSeconds(SEND_SECONDS), true);
  assert.equal(looksLikeSeconds(SEND_SECONDS * 1000), false, "毫秒不能算秒");
  assert.equal(looksLikeSeconds("hello"), false);
  assert.equal(looksLikeSeconds(0), false);
});

// ── 真 HTTP：按文档抄的形状能过，漂移形状被拦 ────────────────────────────────

function startStub(env = {}) {
  const child = spawn(process.execPath, [STUB], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error(`桩未就绪：${buf}`)), 5000);
    child.stdout.on("data", (d) => {
      buf += d;
      const line = buf.split("\n")[0];
      if (!line) return;
      try {
        const { port } = JSON.parse(line);
        clearTimeout(timer);
        resolve({ child, port });
      } catch {
        /* 等下一块 */
      }
    });
    child.on("exit", (code) => reject(new Error(`桩提前退出 code=${code}`)));
  });
}

function runVerify(port, extraEnv = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("KF_")) delete env[k];
  Object.assign(env, {
    KF_BASE_URL: `http://127.0.0.1:${port}`,
    KF_CORPID: "ww-stub-corp",
    KF_SECRET: "S".repeat(40),
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
    ...extraEnv,
  });
  try {
    return { status: 0, stdout: execFileSync(process.execPath, [VERIFY, "--json"], { env, encoding: "utf8" }) };
  } catch (err) {
    return { status: err.status ?? 1, stdout: String(err.stdout || ""), stderr: String(err.stderr || "") };
  }
}

test("真 HTTP：文档形态的桩 → 核对通过，退出码 0", async () => {
  const { child, port } = await startStub();
  try {
    const res = runVerify(port);
    assert.equal(res.status, 0, res.stdout + (res.stderr || ""));
    const out = JSON.parse(res.stdout);
    assert.equal(out.shape.ok, true, out.shape.drift?.join("\n"));
    assert.equal(out.sampleCount, 1);
    // 输出里绝不能出现 secret 或令牌
    assert.ok(!res.stdout.includes("S".repeat(40)), "泄漏了 secret");
    assert.ok(!res.stdout.includes("TOKEN-STUB"), "泄漏了 access_token");
  } finally {
    child.kill("SIGTERM");
  }
});

test("真 HTTP：凭据错误 → 退出码 1，且提示核对应用配对", async () => {
  const { child, port } = await startStub();
  try {
    const res = runVerify(port, { KF_SECRET: "W".repeat(40) });
    assert.equal(res.status, 1);
    assert.ok(res.stderr.includes("corpid/secret"), res.stderr);
    assert.ok(!res.stderr.includes("W".repeat(40)), "错误信息里不得回显 secret");
  } finally {
    child.kill("SIGTERM");
  }
});

test("真 HTTP：桩返回毫秒时间 → 核对失败并指出是毫秒", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "shape-drift-"));
  try {
    // 用一个小包装脚本替换桩：拦截响应体，把 send_time 改成毫秒
    const wrapper = path.join(dir, "drift-stub.mjs");
    writeFileSync(
      wrapper,
      `import { createServer } from "node:http";
const PORT_HOLDER = {};
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const send = (o) => { res.writeHead(200, {"content-type":"application/json"}); res.end(JSON.stringify(o)); };
  if (url.pathname === "/cgi-bin/gettoken") return send({ errcode: 0, access_token: "TOKRRRRRRRRRR", expires_in: 7200 });
  if (url.pathname === "/cgi-bin/kf/account/list") return send({ errcode: 0, account_list: [{ open_kfid: "kf1", name: "x" }] });
  if (url.pathname === "/cgi-bin/kf/sync_msg") return send({ errcode: 0, next_cursor: "c1", has_more: 0, msg_list: [{ msgid: "m1", open_kfid: "kf1", external_userid: "u1", send_time: 1700000000000, origin: 3, msgtype: "text", text: { content: "x" } }] });
  send({ errcode: 404, errmsg: "no" });
});
server.listen(0, "127.0.0.1", () => process.stdout.write(JSON.stringify({ port: server.address().port }) + "\\n"));
for (const s of ["SIGTERM","SIGINT"]) process.on(s, () => server.close(() => process.exit(0)));
`,
      "utf8",
    );
    const child = spawn(process.execPath, [wrapper], { stdio: ["ignore", "pipe", "pipe"] });
    const port = await new Promise((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => reject(new Error("包装桩未就绪")), 5000);
      child.stdout.on("data", (d) => {
        buf += d;
        const line = buf.split("\n")[0];
        if (!line) return;
        try {
          clearTimeout(timer);
          resolve(JSON.parse(line).port);
        } catch {
          /* 等待 */
        }
      });
    });
    try {
      const res = runVerify(port);
      assert.equal(res.status, 1, "漂移形状必须判失败");
      const out = JSON.parse(res.stdout);
      const bad = out.shape.checks.find((c) => c.name.includes("send_time"));
      assert.ok(bad && !bad.ok);
      assert.ok(bad.note.includes("毫秒"));
    } finally {
      child.kill("SIGTERM");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
