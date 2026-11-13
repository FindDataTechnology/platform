#!/usr/bin/env node
// ── kf 真 HTTP 端到端 ───────────────────────────────────────────────────────
//
// 注入 fetch 的单测证明"逻辑分支对"，但它断言的是我自己写的期望形状：
// 请求体怎么序列化、query 怎么编码、baseUrl 怎么拼，一条都没被真实往返检验过。
// 这一层补上那段：起一个本地 qyapi 桩，让 CLI 子进程整条跑穿。
//
//   CLI 子进程 → createKfClient → undici/fetch → HTTP → 桩 → JSON → sqlite → 检索
//
// 桩同时充当"形状守卫"：客户端若把一次性事件令牌塞进 body、或 limit 没夹到 1000，
// 桩会记 violation 并让断言变红。
//
//   node --test scripts/test-kf-e2e-http.mjs

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const CLI = path.join(ROOT, "server", "archive", "kf", "cli.mjs");
const STUB = path.join(ROOT, "tools", "kf-api-stub", "server.mjs");

function startStub() {
  const child = spawn(process.execPath, [STUB], { stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error(`桩未在 5s 内就绪：${buf}`)), 5000);
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

function baseEnv(port, dbFile) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("KF_")) delete env[k];
  return {
    ...env,
    KF_BASE_URL: `http://127.0.0.1:${port}`,
    KF_DB: dbFile,
    KF_CORPID: "ww-stub-corp",
    KF_SECRET: "S".repeat(40),
    KF_OPEN_KFID: "kf-stub-1",
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
  };
}

function runCli(args, env) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout };
  } catch (err) {
    return { status: err.status ?? 1, stdout: String(err.stdout || ""), stderr: String(err.stderr || "") };
  }
}

test("真 HTTP 全链：doctor → sync → search，且请求形状不被桩打回", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "kf-e2e-"));
  const dbFile = path.join(dir, "kf.db");
  const { child, port } = await startStub();
  const env = baseEnv(port, dbFile);
  try {
    // 1. 未拉数据时诊断应为 ready_empty —— 不是故障
    const doctor = runCli(["doctor"], env);
    assert.equal(doctor.status, 0, `doctor 应成功：${doctor.stdout}${doctor.stderr || ""}`);
    const d = JSON.parse(doctor.stdout);
    assert.equal(d.verdict, "ready_empty", JSON.stringify(d.blockers));
    assert.equal(d.checks.api, true);
    assert.equal(d.checks.kfidKnown, true);

    // 2. 同步
    const sync = runCli(["sync"], env);
    assert.equal(sync.status, 0, `sync 应成功：${sync.stdout}${sync.stderr || ""}`);
    const out = JSON.parse(sync.stdout);
    assert.equal(out.report.inserted, 3, JSON.stringify(out.report.errors));
    assert.equal(out.report.pulled, 3);
    assert.equal(out.report.cursorAfter, "c2");
    assert.equal(out.report.errors.length, 0);
    assert.equal(out.report.peerMessages, 1);
    assert.equal(out.report.selfMessages, 1);
    assert.equal(out.report.systemEvents, 1);
    assert.equal(out.report.customers.updated, 1);
    assert.equal(out.coverage.claimsFullCoverage, false);

    // 3. 检索：两字中文词必须搜得到（走 LIKE，不走 trigram）
    const search = runCli(["search", "报价"], env);
    assert.equal(search.status, 0);
    const hits = JSON.parse(search.stdout);
    assert.equal(hits.length, 2, `「报价」应命中客户提问与我方回复两条：${JSON.stringify(hits)}`);
    const peerHit = hits.find((h) => h.origin === "peer");
    assert.ok(peerHit, "客户那条必须在结果里");
    assert.ok(peerHit.text.includes("开专票"));

    // 4. 再同步一次：已到末尾，pulled=0 且不报错
    const again = runCli(["sync"], env);
    assert.equal(again.status, 0);
    const out2 = JSON.parse(again.stdout);
    assert.equal(out2.report.pulled, 0, "游标已到底，不应重复拉");
    assert.equal(out2.report.inserted, 0);
    assert.equal(out2.report.errors.length, 0);

    // 5. 桩侧的形状守卫必须零违规
    const seen = await (await fetch(`http://127.0.0.1:${port}/__seen`)).json();
    assert.deepEqual(seen.violations, [], `客户端请求形状违规：${JSON.stringify(seen.violations)}`);
    assert.equal(seen.sync_msg, 3, "首轮两批 + 第二轮一次空拉");
    assert.equal(seen.customer_batchget, 1);
    assert.ok(seen.gettoken >= 2, "doctor 与 sync 各自取票");
  } finally {
    child.kill("SIGTERM");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reply 默认只演练：不发请求，只打印窗口与将要发送的内容", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "kf-e2e-dry-"));
  const dbFile = path.join(dir, "kf.db");
  const { child, port } = await startStub();
  const env = baseEnv(port, dbFile);
  try {
    const res = runCli(["reply", "wmCUST0001", "演练一句"], env);
    assert.equal(res.status, 0, res.stdout + (res.stderr || ""));
    const out = JSON.parse(res.stdout);
    assert.equal(out.dryRun, true);
    assert.equal(out.to, "wmCUST0001");
    assert.equal(out.content, "演练一句");

    const seen = await (await fetch(`http://127.0.0.1:${port}/__seen`)).json();
    assert.equal(seen.send_msg, 0, "演练绝不能产生对外请求");
  } finally {
    child.kill("SIGTERM");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reply --confirm 走真 HTTP：桩收到正确目标与正文", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const store = await import("../server/archive/kf/store.js");
  const dir = mkdtempSync(path.join(tmpdir(), "kf-e2e-send-"));
  const dbFile = path.join(dir, "kf.db");
  const { child, port } = await startStub();
  const env = baseEnv(port, dbFile);
  try {
    // 先落一条"客户刚问过"的消息，让 48 小时窗口确定性地开着
    // （不依赖夹具里的固定时间，避免测试隔天自己变红）
    const db = new DatabaseSync(dbFile);
    store.ensureKfSchema(db);
    store.upsertKfConversation(db, {
      conversationId: "kf-stub-1|wmCUST0001",
      openKfId: "kf-stub-1",
      externalUserId: "wmCUST0001",
    });
    store.insertKfMessage(db, {
      id: "kf-stub-1|wmCUST0001:seed-peer",
      conversationId: "kf-stub-1|wmCUST0001",
      msgId: "seed-peer",
      openKfId: "kf-stub-1",
      externalUserId: "wmCUST0001",
      sentAt: Date.now() - 60 * 60 * 1000,
      origin: "peer",
      msgType: "text",
      text: "在吗",
      ingestedAt: Date.now(),
    });
    db.close();

    const res = runCli(["reply", "wmCUST0001", "在的，请问需要什么", "--confirm"], env);
    assert.equal(res.status, 0, res.stdout + (res.stderr || ""));
    const out = JSON.parse(res.stdout);
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.msgId, "STUB-OUT-1");

    const seen = await (await fetch(`http://127.0.0.1:${port}/__seen`)).json();
    assert.equal(seen.send_msg, 1);
    assert.deepEqual(seen.sent[0], {
      touser: "wmCUST0001",
      openKfId: "kf-stub-1",
      content: "在的，请问需要什么",
    });
    assert.deepEqual(seen.violations, []);

    // 本地留下一条 self 记录，带服务端 msgid —— 下一轮拉取同一条会被幂等吃掉
    const after = new DatabaseSync(dbFile);
    const row = after.prepare("SELECT origin, msg_id FROM kf_message WHERE id=?").get(
      "kf-stub-1|wmCUST0001:STUB-OUT-1",
    );
    assert.equal(row?.origin, "self");
    after.close();
  } finally {
    child.kill("SIGTERM");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("媒体端到端：含 0x00 的二进制完整落盘，未知 id 走 JSON 报错不落盘", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { readFileSync, existsSync } = await import("node:fs");
  const store = await import("../server/archive/kf/store.js");
  const dir = mkdtempSync(path.join(tmpdir(), "kf-e2e-media-"));
  const dbFile = path.join(dir, "kf.db");
  const mediaDir = path.join(dir, "media");
  const { child, port } = await startStub();
  const env = baseEnv(port, dbFile);
  try {
    const db = new DatabaseSync(dbFile);
    store.ensureKfSchema(db);
    for (const [id, mediaId] of [
      ["good", "MID-OK"],
      ["bad", "MID-MISSING"],
    ]) {
      store.upsertKfConversation(db, {
        conversationId: "kf-stub-1|wmCUST0001",
        openKfId: "kf-stub-1",
        externalUserId: "wmCUST0001",
      });
      store.queueKfMedia(db, {
        id: `kf-stub-1|wmCUST0001:${id}`,
        messageId: `kf-stub-1|wmCUST0001:${id}`,
        conversationId: "kf-stub-1|wmCUST0001",
        mediaId,
        mediaType: "image",
      });
    }
    db.close();

    const res = runCli(["media", "--dir", mediaDir], env);
    // 未知 id 第一次只算退避重试（不判死），所以退出码仍为 0；但成功那条必须落盘
    assert.equal(res.status, 0, res.stdout + (res.stderr || ""));
    const out = JSON.parse(res.stdout);
    assert.equal(out.report.done, 1);
    assert.equal(out.report.retried, 1, "未知 id 第一次不判死，留给下一轮");
    assert.equal(out.report.failed, 0);
    assert.equal(out.completion.total, 2);
    assert.equal(out.completion.done, 1);
    assert.equal(out.completion.pending, 1);

    const files = (await import("node:fs")).readdirSync(mediaDir);
    assert.equal(files.length, 1, `只该有一个文件：${files.join(",")}`);
    const bytes = readFileSync(path.join(mediaDir, files[0]));
    assert.deepEqual([...bytes], [0xff, 0xd8, 0x00, 0x01, 0x02, 0x00, 0xff, 0xd9], "0x00 不能被截断");

    // 未知 id 那条：没落盘、没留路径，错误原样留档（JSON 没有被当图片写下去）
    const after = new DatabaseSync(dbFile);
    const bad = after
      .prepare("SELECT state, path, last_error FROM kf_media WHERE media_id='MID-MISSING'")
      .get();
    assert.equal(bad.state, "pending");
    assert.equal(bad.path, null, "失败不得留路径");
    assert.ok(String(bad.last_error).includes("40007"), bad.last_error);
    after.close();
    assert.equal(existsSync(path.join(mediaDir, "MID-MISSING.jpg")), false);
  } finally {
    child.kill("SIGTERM");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("错误凭据：桩返 40001，doctor 判 api_unavailable 并点名凭据配对", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "kf-e2e-bad-"));
  const { child, port } = await startStub();
  const env = { ...baseEnv(port, path.join(dir, "kf.db")), KF_SECRET: "W".repeat(40) };
  try {
    const doctor = runCli(["doctor"], env);
    const d = JSON.parse(doctor.stdout);
    assert.equal(d.verdict, "api_unavailable");
    assert.equal(d.checks.token, false);
    assert.ok(d.blockers[0].includes("corpid/secret"), d.blockers[0]);
    assert.ok(!d.blockers[0].includes("W".repeat(40)), "阻塞文案不得回显 secret");
  } finally {
    child.kill("SIGTERM");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("令牌错误（40014）：客户端刷新重试后仍失败则原样上报 errcode", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "kf-e2e-token-"));
  const { child, port } = await startStub();
  try {
    // 直连客户端，故意用一个陈旧的 baseUrl 令牌场景：桩会因 access_token 不匹配返 40014，
    // 客户端刷新后拿到正确令牌就能成功——这正是"刷新一次"该有的效果。
    const { createKfClient } = await import("../server/archive/kf/api.js");
    const client = createKfClient({
      corpId: "ww-stub-corp",
      secret: "S".repeat(40),
      baseUrl: `http://127.0.0.1:${port}`,
      timeoutMs: 5000,
    });
    const res = await client.syncMsg({ cursor: "", openKfId: "kf-stub-1" });
    assert.equal(res.messages.length, 1);
    assert.equal(res.hasMore, true);
  } finally {
    child.kill("SIGTERM");
    rmSync(dir, { recursive: true, force: true });
  }
});
