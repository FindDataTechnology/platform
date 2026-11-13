#!/usr/bin/env node
// ── Archive SDK binding tests (add-wecom-archive-ingest 1.1–1.4, 4.3)
//
// 判据全部是"形状"而不是"感觉"，因为这条通道最容易出的问题是**静默少数据**：
//   • limit>1000 官方直接报错——如果被当成"空结果"，游标照样前进，这段就永久丢了；
//   • 301042 是出口 IP 白名单——归成"网络错误"会让排障方向完全错；
//   • helper 退出必须变成可见失败，不能挂住或返回 undefined 让上层当"没消息"；
//   • 解密失败不能退化成"丢弃这条消息"。
//
//   node --test scripts/test-archive-sdk-binding.mjs

import assert from "node:assert/strict";
import { test } from "node:test";

const { getChatData, getMediaData, decryptMessage, classify, probeReadiness, createStubDriver, MAX_LIMIT, SdkProtocolError, WhiteIpMismatchError } =
  await import("../server/archive/sdk.js");

test("limit 超过 1000 在发请求前就被拒，且不推进游标", async () => {
  const driver = createStubDriver(async () => ({ ok: true, messages: [], seq: 999 }));
  await assert.rejects(
    () => getChatData(driver, { seq: 100, limit: 2000 }),
    (err) => err instanceof SdkProtocolError && /官方上限/.test(err.message),
  );
  assert.equal(driver.calls.length, 0, "超限请求不应到达 helper");
});

test("limit=1000 恰好合法", async () => {
  const driver = createStubDriver(async (p) => ({ ok: true, messages: [], seq: p.seq }));
  const out = await getChatData(driver, { seq: 0, limit: MAX_LIMIT });
  assert.equal(out.seq, 0);
  assert.equal(driver.calls[0].limit, 1000);
});

test("seq 非法时不发请求", async () => {
  const driver = createStubDriver(async () => ({ ok: true, messages: [] }));
  await assert.rejects(() => getChatData(driver, { seq: -1 }), SdkProtocolError);
  await assert.rejects(() => getChatData(driver, { seq: 1.5 }), SdkProtocolError);
  assert.equal(driver.calls.length, 0);
});

test("301042 被识别为出口 IP 白名单，不是网络错误", () => {
  const err = classify(301042, "whiteip not match");
  assert.ok(err instanceof WhiteIpMismatchError);
  assert.match(err.message, /可信列表/);
});

test("其它错误码保持为协议错误并带上码与上下文", () => {
  const err = classify(40001, "invalid secret", { seq: 7 });
  assert.ok(err instanceof SdkProtocolError);
  assert.equal(err.detail.errCode, 40001);
  assert.equal(err.detail.seq, 7);
});

test("helper 报 ok:false 时抛出而不是当成空批次", async () => {
  const driver = createStubDriver(async () => ({ ok: false, errCode: 50001, message: "boom" }));
  await assert.rejects(() => getChatData(driver, { seq: 5 }), SdkProtocolError);
});

test("helper 结果缺 messages 数组时报协议错误（防止 undefined 被当空）", async () => {
  const driver = createStubDriver(async () => ({ ok: true, seq: 5 }));
  await assert.rejects(() => getChatData(driver, { seq: 5 }), /缺少 messages/);
});

test("成功的批次带回 seq，供上层推进游标", async () => {
  const driver = createStubDriver(async () => ({
    ok: true,
    seq: 1234,
    messages: [{ msgid: "m1" }, { msgid: "m2" }],
  }));
  const out = await getChatData(driver, { seq: 1000 });
  assert.equal(out.messages.length, 2);
  assert.equal(out.seq, 1234);
});

test("解密缺字段时抛错，不退化成丢弃消息", async () => {
  const driver = createStubDriver(async () => ({ ok: true, plain: "x" }));
  await assert.rejects(
    () => decryptMessage(driver, { encryptChatMsg: "c", seq: 1 }),
    /encrypt_random_key/,
  );
  assert.equal(driver.calls.length, 0);
});

test("解密结果是字符串才接受", async () => {
  const driver = createStubDriver(async () => ({ ok: true, plain: 42 }));
  await assert.rejects(() => decryptMessage(driver, { encryptRandomKey: "k", encryptChatMsg: "c" }), SdkProtocolError);
});

test("媒体分块：未标 isFinish 时不得自行判定完成（截断风险的源头）", async () => {
  // 早先实现把"没有 outIndexBuf"当成"拉完了"，导致文件截断仍标 done 且不报错。
  // 现在只认官方 is_finish 标志；矛盾状态交给调用方显式处理。
  const driver = createStubDriver(async () => ({ ok: true, chunkBase64: Buffer.from("abc").toString("base64") }));
  const out = await getMediaData(driver, { sdkFileId: "fid" });
  assert.equal(out.chunk.toString(), "abc");
  assert.equal(out.isFinish, false, "没有 is_finish 标志就不能算完成");
  assert.equal(out.outIndexBuf, "");
});

test("媒体分块：有 outIndexBuf 时未完成，可继续拉", async () => {
  const driver = createStubDriver(async () => ({ ok: true, chunkBase64: "", outIndexBuf: "next" }));
  const out = await getMediaData(driver, { sdkFileId: "fid", indexBuf: "start" });
  assert.equal(out.isFinish, false);
  assert.equal(out.outIndexBuf, "next");
});

test("就绪探测：缺私钥时指认 private_key，而不是笼统未就绪", async () => {
  const driver = createStubDriver(async () => ({ ok: true, egressIp: "1.2.3.4" }));
  const out = await probeReadiness(driver, { secret: "s".repeat(40), expectedEgressIp: "1.2.3.4" });
  assert.equal(out.ready, false);
  assert.deepEqual(out.missing, ["private_key"]);
});

test("就绪探测：secret 太短被识别（会话存档 secret 与普通应用不同）", async () => {
  const driver = createStubDriver(async () => ({ ok: true }));
  const out = await probeReadiness(driver, { privateKeyPath: "/k.pem", secret: "short" });
  assert.equal(out.checks.secretShape, "too_short");
  assert.ok(out.missing.includes("secret"));
});

test("就绪探测：出口 IP 与配置不一致时标 egress_ip", async () => {
  const driver = createStubDriver(async () => ({ ok: true, egressIp: "9.9.9.9" }));
  const out = await probeReadiness(driver, {
    privateKeyPath: "/k.pem",
    secret: "s".repeat(40),
    expectedEgressIp: "1.2.3.4",
  });
  assert.equal(out.checks.egressIpMatch, false);
  assert.ok(out.missing.includes("egress_ip"));
});

test("就绪探测：helper ping 报 301042 时判出口不匹配", async () => {
  const driver = createStubDriver(async () => ({ ok: false, errCode: 301042 }));
  const out = await probeReadiness(driver, {
    privateKeyPath: "/k.pem",
    secret: "s".repeat(40),
    expectedEgressIp: "1.2.3.4",
  });
  assert.equal(out.checks.egressIpMatch, false);
});

test("就绪探测：全部齐备时 ready=true", async () => {
  const driver = createStubDriver(async () => ({ ok: true, egressIp: "1.2.3.4" }));
  const out = await probeReadiness(driver, {
    privateKeyPath: "/k.pem",
    secret: "s".repeat(40),
    expectedEgressIp: "1.2.3.4",
  });
  assert.equal(out.ready, true);
  assert.deepEqual(out.missing, []);
});
