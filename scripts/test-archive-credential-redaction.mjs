#!/usr/bin/env node
// ── 凭据通路：不落日志、不进错误正文（任务 6.3）────────────────────────────
//
// 这条通道同时握着四样敏感东西：`corp_id`、存档专用 `secret`、RSA 私钥路径、
// 出口 IP。它们最容易泄漏的地方不是数据库，而是**报错正文**——因为报错会被
// 打印、被转进告警、被用户截图贴到群里。
//
// 存档的拉取由一个独立 helper 进程完成，它回传的 `message` 会原样变成我们的
// 异常正文。上游只要回显一次请求内容，secret 就出去了。这不是"应该不会"。
//
// 这组测试用一串**只可能来自本次注入**的 canary 值来验证：
//   - helper 回显 secret → 异常正文里是 ***，且不含 canary
//   - 诊断报告（activate 的 stdout）里不出现 canary
//   - CLI 端到端（ARCHIVE_SECRET=canary 跑 activate --check）整段输出不含 canary
//
//   node --test scripts/test-archive-credential-redaction.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const { redactSecrets, createStdioDriver, getChatData } = await import(
  "../server/archive/sdk.js"
);
const { runDoctor } = await import("../server/archive/doctor.js");

/** 只可能来自本次注入的值：四段随机不可猜的组合。 */
const CANARY_SECRET = "CANARY_SECRET_7f3a91d4e2b8c605a1b2c3d4";
const CANARY_KEY_PATH = "/canary/9d4e2f/private_key_PLEASE_ROTATE.pem";
const CANARY_EGRESS = "198.51.100.77";

test("redactSecrets：擦掉长凭据，保留短串（短串擦了只会打碎正常文本）", () => {
  assert.equal(redactSecrets(`x ${CANARY_SECRET} y`, [CANARY_SECRET]), "x *** y");
  assert.equal(redactSecrets("abc", ["ab"]), "abc", "过短的值不擦");
  assert.equal(redactSecrets("", [CANARY_SECRET]), "");
});

test("helper 回显 secret：异常正文里是 ***，拿不到原文", async () => {
  // 这个 driver 的 redact 与真实 driver 同源（都走 redactSecrets），
  // 但 call 直接回一条"把请求内容回显出来"的报错，模拟上游最坏情况。
  const driver = {
    redact: (t) => redactSecrets(t, [CANARY_SECRET]),
    async call() {
      return {
        errCode: -1,
        message: `invalid request: {"corpsecret":"${CANARY_SECRET}","corpid":"ww-x"}`,
      };
    },
  };
  await assert.rejects(
    () => getChatData(driver, { seq: 1, limit: 10 }),
    (err) => {
      assert.ok(!err.message.includes(CANARY_SECRET), `异常正文泄漏了 secret：${err.message}`);
      assert.ok(err.message.includes("***"), `应当擦成 ***：${err.message}`);
      return true;
    },
  );
});

test("真实 stdio driver 会把 secrets 变成 redact（不是只在测试里成立）", () => {
  const stubChild = {
    stdout: { setEncoding() {}, on() {} },
    stderr: { on() {} },
    stdin: { write() {}, end() {} },
    on() {},
    pid: 1234,
  };
  const driver = createStdioDriver({
    command: "python3",
    spawnImpl: () => stubChild,
    secrets: [CANARY_SECRET],
  });
  assert.equal(typeof driver.redact, "function", "driver 必须暴露 redact");
  assert.equal(driver.redact(`boom ${CANARY_SECRET}`), "boom ***");
});

test("诊断报告不包含 secret / 私钥路径 / 出口 IP 的值", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const store = await import("../server/archive/store.js");
  const db = new DatabaseSync(":memory:");
  store.ensureArchiveSchema(db);
  const config = {
    archiveEnabled: true,
    secret: CANARY_SECRET,
    privateKeyPath: CANARY_KEY_PATH,
    expectedEgressIp: CANARY_EGRESS,
    corpId: "ww-canary",
    seatScope: ["member-a"],
    effectiveSeats: 5,
  };
  const report = await runDoctor({ db, driver: null, config, now: 1_700_000_000_000 });
  db.close?.();
  const text = JSON.stringify(report);
  assert.ok(!text.includes(CANARY_SECRET), `报告泄漏 secret：${text.slice(0, 400)}`);
  assert.ok(!text.includes(CANARY_KEY_PATH), "报告泄漏私钥路径");
  assert.ok(!text.includes(CANARY_EGRESS), "报告泄漏出口 IP");
  // 不是靠"什么都没输出"通过：确实判过 secret 状态
  assert.equal(report.checks.secret, "ok");
});

test("CLI 端到端：ARCHIVE_SECRET 为 canary 时，整段输出不含 canary", () => {
  const cli = path.join(ROOT, "server", "archive", "cli.mjs");
  const res = spawnSync(process.execPath, [cli, "activate", "--check"], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ARCHIVE_SECRET: CANARY_SECRET,
      ARCHIVE_PRIVATE_KEY: CANARY_KEY_PATH,
      ARCHIVE_EGRESS_IP: CANARY_EGRESS,
      ARCHIVE_CORPID: "ww-canary",
      ARCHIVE_ENABLED: "1",
      ARCHIVE_DB: path.join(ROOT, "data", "does-not-matter.db"),
    },
    cwd: ROOT,
    timeout: 60_000,
  });
  const out = `${res.stdout || ""}${res.stderr || ""}`;
  assert.ok(out.length > 0, "CLI 应该有输出");
  assert.ok(!out.includes(CANARY_SECRET), `CLI 输出泄漏 secret：\n${out.slice(0, 1200)}`);
  assert.ok(!out.includes(CANARY_KEY_PATH), "CLI 输出泄漏私钥路径");
});
