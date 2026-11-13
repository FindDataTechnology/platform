#!/usr/bin/env node
// ── Node → helper 进程 → ctypes → C 库 全链端到端 (1.1b / 2.3b 的真链部分)
//
// 这条测试跨越四个语言/进程边界，验证的是"装得起来"而不是"函数写得对"：
//
//   runPullCycle(node)
//        │ stdio JSON
//        ▼
//   archive_helper.py (python3, ctypes)
//        │ C ABI
//        ▼
//   libWeWorkFinanceSdk_C.dylib  ← 我们自己编的桩，符号与官方同名同签名
//
// 桩库由 `tools/archive-sdk-stub/build.sh` 构建；找不到库时整条测试 skip（不是 fail），
// 因为 CI 机器可能没 clang。
//
//   node --test scripts/test-archive-helper-e2e.mjs

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";

const store = await import("../server/archive/store.js");
const { runPullCycle } = await import("../server/archive/ingest.js");
const { createStdioDriver, probeReadiness } = await import("../server/archive/sdk.js");
const { pullMedia, mediaCompletion } = await import("../server/archive/media.js");

const ROOT = path.resolve(import.meta.dirname, "..");
const STUB_DIR = path.join(ROOT, "tools", "archive-sdk-stub");
const LIB_PATH = path.join(STUB_DIR, "build", "libWeWorkFinanceSdk_C.dylib");
const HELPER = path.join(ROOT, "server", "archive", "helper", "archive_helper.py");

const hasStub = existsSync(LIB_PATH);
const hasPython = (() => {
  try {
    execFileSync("python3", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const CAN_RUN = hasStub && hasPython;
const skipReason = !hasStub
  ? "桩库未构建：先跑 tools/archive-sdk-stub/build.sh"
  : "python3 不可用";

const NOW = 1_700_000_000_000;

function freshDb() {
  const db = new DatabaseSync(":memory:");
  store.ensureArchiveSchema(db);
  return db;
}

/**
 * 造一对临时密钥 + 两个 RSA 密文。
 *
 * 为什么要这一步：真实归档里 `encrypt_random_key` 是**用企业公钥加密的**，
 * helper 必须先用自己的私钥解出密钥再交给 DecryptData。原来的桩里它是 "rk1"
 * 这种明文占位符，等于把 RSA 那一步绕过去了——测试全绿但真机会每条都解密失败。
 */
function makeKeys(dir) {
  const priv = path.join(dir, "private.pem");
  const pub = path.join(dir, "public.pem");
  execFileSync("openssl", ["genrsa", "-out", priv, "2048"], { stdio: "ignore" });
  execFileSync("openssl", ["rsa", "-in", priv, "-pubout", "-out", pub], { stdio: "ignore" });
  const encryptKey = (name) => {
    const plainFile = path.join(dir, `${name}.txt`);
    const outFile = path.join(dir, `${name}.bin`);
    writeFileSync(plainFile, `aes-key-for-${name}`);
    execFileSync(
      "openssl",
      ["pkeyutl", "-encrypt", "-pubin", "-inkey", pub, "-pkeyopt", "rsa_padding_mode:pkcs1",
       "-in", plainFile, "-out", outFile],
      { stdio: "ignore" },
    );
    return readFileSync(outFile).toString("base64");
  };
  return { priv, enc1: encryptKey("rk1"), enc2: encryptKey("rk2") };
}

/** 写一份桩配置：两个批次、两条明文、两段媒体。 */
function writeStubConfig(dir, extraLines = [], keys = makeKeys(dir)) {
  const plain1 = JSON.stringify({
    msgid: "m1",
    seq: 1,
    from: "wmCUST",
    roomid: "room1",
    msgtime: NOW - 5000,
    msgtype: "text",
    text: { content: "帮我报个价，明早见客户" },
  });
  const plain2 = JSON.stringify({
    msgid: "m2",
    seq: 2,
    from: "wmCUST",
    roomid: "room1",
    msgtime: NOW - 4000,
    msgtype: "image",
    image: { sdkfileid: "FID1", filesize: 6 },
  });
  // 真实归档每条消息都带 seq，游标靠它推进
  const batch1 = JSON.stringify([
    { msgid: "m1", seq: 1, encrypt_random_key: keys.enc1, encrypt_chat_msg: "ct1" },
  ]);
  const batch2 = JSON.stringify([
    { msgid: "m2", seq: 2, encrypt_random_key: keys.enc2, encrypt_chat_msg: "ct2" },
  ]);
  const cfg = [
    `BATCH\t1\t${batch1}`,
    `BATCH\t2\t${batch2}`,
    `PLAIN\tct1\t${plain1}`,
    `PLAIN\tct2\t${plain2}`,
    `MEDIA\tFID1\t0\t${Buffer.from("abc").toString("hex")}`,
    `MEDIA\tFID1\t1\t${Buffer.from("def").toString("hex")}`,
    ...extraLines,
  ].join("\n");
  const file = path.join(dir, "stub.cfg");
  writeFileSync(file, `${cfg}\n`, "utf8");
  return file;
}

function makeDriver(cfgPath, { secret = "s".repeat(40), privateKey = "" } = {}) {
  return createStdioDriver({
    command: "python3",
    args: [HELPER],
    env: {
      ARCHIVE_SDK_PATH: LIB_PATH,
      ARCHIVE_STUB_CONFIG: cfgPath,
      ARCHIVE_CORPID: "ww-test",
      ARCHIVE_SECRET: secret,
      ARCHIVE_EGRESS_IP: "1.2.3.4",
      ARCHIVE_PRIVATE_KEY: privateKey,
    },
    spawnImpl: spawn,
  });
}

test("跨进程全链：Node → python helper → C 桩库，拉取入库", { skip: CAN_RUN ? false : skipReason }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "archive-e2e-"));
  const db = freshDb();
  const keys = makeKeys(dir);
  const driver = makeDriver(writeStubConfig(dir, [], keys), { privateKey: keys.priv });
  try {
    const ping = await driver.call({ op: "ping" });
    assert.equal(ping.ok, true, JSON.stringify(ping));
    assert.equal(ping.egressIp, "1.2.3.4");

    const report = await runPullCycle({
      db,
      driver,
      queryConsent: async () => "Agree",
      selfUserIds: [],
      now: NOW,
      maxBatches: 4,
    });

    assert.equal(report.admitted, 2, JSON.stringify(report.errors));
    assert.equal(report.errors.length, 0);
    assert.equal(store.coverageReport(db).messages.total, 2);
    assert.equal(report.mediaQueued, 1);

    const texts = db
      .prepare("SELECT text FROM archive_message ORDER BY sent_at")
      .all()
      .map((r) => r.text);
    assert.ok(texts[0].includes("明早见客户"), "正文必须穿过三层边界完整到达");
  } finally {
    driver.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("跨进程媒体分块：两段拼回完整内容", { skip: CAN_RUN ? false : skipReason }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "archive-e2e-media-"));
  const db = freshDb();
  const keys = makeKeys(dir);
  const driver = makeDriver(writeStubConfig(dir, [], keys), { privateKey: keys.priv });
  try {
    await runPullCycle({
      db,
      driver,
      queryConsent: async () => "Agree",
      now: NOW,
      maxBatches: 4,
    });
    const written = [];
    const report = await pullMedia(db, driver, {
      writer: async (job) => written.push(job),
    });
    assert.equal(report.done, 1, JSON.stringify(report.errors));
    const joined = Buffer.concat(written[0].chunks).toString();
    assert.equal(joined, "abcdef", "两段必须按 outIndexBuf 顺序拼对");
    assert.equal(mediaCompletion(db).done, 1);
  } finally {
    driver.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("跨进程失败注入：10009（SDK 的 ip非法）被识别为出口 IP 问题", { skip: CAN_RUN ? false : skipReason }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "archive-e2e-err-"));
  const db = freshDb();
  // 10009 是会话存档 C SDK 的「ip非法」（官方头文件错误码表）；301042 是 HTTP 接口面的同义码。
  // 早先只认 301042，真 SDK 报 10009 时会被归成通用协议错误，现场就会去查 SDK。
  const cfgPath = writeStubConfig(dir, ["ERR\tgetChatData\t10009\tip not allowed"]);
  const driver = makeDriver(cfgPath);
  try {
    const report = await runPullCycle({
      db,
      driver,
      queryConsent: async () => "Agree",
      now: NOW,
      maxBatches: 2,
    });
    assert.equal(report.errors.length, 1);
    assert.equal(report.errors[0].name, "WhiteIpMismatchError", JSON.stringify(report.errors));
    assert.equal(store.readCursor(db).seq, 0, "失败时游标不得前进");
  } finally {
    driver.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("跨进程就绪探测：真 Init 通过时 sdkPresent=true", { skip: CAN_RUN ? false : skipReason }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "archive-e2e-ready-"));
  const keys = makeKeys(dir);
  const driver = makeDriver(writeStubConfig(dir, [], keys), { privateKey: keys.priv });
  try {
    const out = await probeReadiness(driver, {
      privateKeyPath: "/k.pem",
      secret: "s".repeat(40),
      expectedEgressIp: "1.2.3.4",
    });
    assert.equal(out.checks.sdkPresent, true, JSON.stringify(out.ping));
    assert.equal(out.ready, true, JSON.stringify(out.missing));
  } finally {
    driver.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("跨进程就绪探测：secret 太短时 C 侧 Init 拒绝，sdkPresent=false", { skip: CAN_RUN ? false : skipReason }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "archive-e2e-badsecret-"));
  const driver = makeDriver(writeStubConfig(dir), { secret: "short" });
  try {
    const out = await probeReadiness(driver, { privateKeyPath: "/k.pem", secret: "short" });
    assert.equal(out.checks.sdkPresent, false);
    assert.ok(out.missing.includes("sdk") || out.missing.includes("secret"));
  } finally {
    driver.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
