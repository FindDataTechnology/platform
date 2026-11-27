#!/usr/bin/env node
// ── 媒体分块 / 就绪自检测试 (add-wecom-archive-ingest 2.3b；archive-sidecar 2.1–3.3)
//
// 判据都对着"看起来成功其实没做完"的形态：
//   • 分块循环把"没翻完"当成"翻完了" → 文件截断但状态 done
//   • 一次超时就把一段视频判死 → 媒体永久缺失
//   • 状态先标 done 再写盘 → done 但文件不存在
//   • doctor 说"就绪"但其实零数据 → 接口通不等于能用
//
//   node --test scripts/test-archive-media-doctor.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";

const store = await import("../server/archive/store.js");
const media = await import("../server/archive/media.js");
const doctor = await import("../server/archive/doctor.js");
const { createStubDriver } = await import("../server/archive/sdk.js");

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

function freshDb() {
  const db = new DatabaseSync(":memory:");
  store.ensureArchiveSchema(db);
  return db;
}

function seedMedia(db, id = "m1:FID", attempts = 0) {
  store.upsertConversation(db, {
    conversationId: "c1",
    kind: "group",
    name: "群",
    agreeState: "agree",
    agreeAt: NOW,
  });
  store.upsertMedia(db, {
    id,
    conversationId: "c1",
    messageId: "c1:m1",
    sdkFileId: "FID",
    mediaType: "image",
    state: "pending",
    attempts,
  });
}

/** 分块驱动：chunks 是依次返回的片段，最后一片 isFinish。 */
function chunkDriver(chunks, { failAt = -1 } = {}) {
  let i = 0;
  return createStubDriver(async (payload) => {
    if (payload.op !== "getMediaData") return { ok: false, errCode: 1, message: "unexpected" };
    if (failAt === i) {
      i += 1;
      return { ok: false, errCode: 50002, message: "media fetch failed" };
    }
    const idx = i;
    i += 1;
    const last = idx >= chunks.length - 1;
    return {
      ok: true,
      chunkBase64: Buffer.from(chunks[Math.min(idx, chunks.length - 1)]).toString("base64"),
      outIndexBuf: last ? "" : `c${idx + 1}`,
      isFinish: last,
    };
  });
}

test("媒体多分块拉完标 done，字节数对账", async () => {
  const db = freshDb();
  seedMedia(db);
  const written = [];
  const report = await media.pullMedia(db, chunkDriver(["aa", "bb", "cc"]), {
    writer: async (job) => written.push(job),
  });
  assert.equal(report.done, 1);
  assert.equal(report.bytes, 6);
  assert.equal(written[0].chunks.length, 3);
  const row = db.prepare("SELECT state, bytes FROM archive_media").get();
  assert.equal(row.state, "done");
  assert.equal(Number(row.bytes), 6);
});

test("写盘失败则不标 done（避免 done 但文件不存在）", async () => {
  const db = freshDb();
  seedMedia(db);
  const report = await media.pullMedia(db, chunkDriver(["aa"]), {
    writer: async () => {
      throw new Error("disk full");
    },
    maxAttempts: 3,
  });
  const row = db.prepare("SELECT state, attempts, last_error FROM archive_media").get();
  assert.notEqual(row.state, "done");
  assert.match(row.last_error, /disk full/);
  assert.equal(report.done, 0);
});

test("一次失败进入重试（pending），不直接判死", async () => {
  const db = freshDb();
  seedMedia(db);
  const report = await media.pullMedia(db, chunkDriver(["aa"], { failAt: 0 }), { maxAttempts: 3 });
  assert.equal(report.retried, 1);
  assert.equal(report.failed, 0);
  const row = db.prepare("SELECT state, attempts FROM archive_media").get();
  assert.equal(row.state, "pending");
  assert.equal(Number(row.attempts), 1);
  assert.equal(media.mediaCompletion(db).pending, 1);
});

test("达到上限后转 failed 并保留原因", async () => {
  const db = freshDb();
  seedMedia(db, "m1:FID", 2); // 已重试两次
  const report = await media.pullMedia(db, chunkDriver(["aa"], { failAt: 0 }), { maxAttempts: 3 });
  assert.equal(report.failed, 1);
  const row = db.prepare("SELECT state, attempts, last_error FROM archive_media").get();
  assert.equal(row.state, "failed");
  assert.equal(Number(row.attempts), 3);
  assert.ok(row.last_error);
});

test("既未完成也不给 outIndexBuf → 判异常，不当作拉完", async () => {
  const db = freshDb();
  seedMedia(db);
  const driver = createStubDriver(async () => ({ ok: true, chunkBase64: "", outIndexBuf: "", isFinish: false }));
  const report = await media.pullMedia(db, driver, { maxAttempts: 1 });
  assert.equal(report.failed, 1);
  assert.match(db.prepare("SELECT last_error FROM archive_media").get().last_error, /outIndexBuf/);
});

test("分块上限防止无限翻页", async () => {
  const db = freshDb();
  seedMedia(db);
  // 永远不 finish 的驱动
  const driver = createStubDriver(async () => ({ ok: true, chunkBase64: "", outIndexBuf: "again", isFinish: false }));
  const report = await media.pullMedia(db, driver, { maxChunks: 5, maxAttempts: 1 });
  assert.equal(report.failed, 1);
  assert.match(db.prepare("SELECT last_error FROM archive_media").get().last_error, /上限/);
});

test("媒体完成率：空库返回 null，不返回 1（避免空库显示 100%）", () => {
  const db = freshDb();
  assert.equal(media.mediaCompletion(db).ratio, null);
});

// ── doctor ────────────────────────────────────────────────────────────────

test("doctor：五项齐备且有数据 → ok", async () => {
  const db = freshDb();
  store.writeCursor(db, { id: "default", seq: 9, lastCheckedAt: NOW - 60_000, lastMessageAt: NOW - 60_000, lastSuccessAt: NOW - 60_000 });
  store.upsertConversation(db, { conversationId: "c1", kind: "group", name: "g", agreeState: "agree", agreeAt: NOW });
  store.insertMessage(db, {
    id: "c1:m1",
    conversationId: "c1",
    msgId: "m1",
    seq: 9,
    sentAt: NOW - 60_000,
    sender: "wm",
    origin: "peer",
    msgType: "text",
    text: "hi",
    ingestedAt: NOW,
  });
  const result = await doctor.runDoctor({
    db,
    driver: createStubDriver(async () => ({ ok: true, egressIp: "1.2.3.4" })),
    config: {
      archiveEnabled: true,
      privateKeyPath: "/k.pem",
      secret: "s".repeat(40),
      expectedEgressIp: "1.2.3.4",
      seatScope: ["zhangsan"],
    },
    now: NOW,
  });
  assert.equal(result.ok, true, result.verdict);
  assert.deepEqual(result.blockers, []);
});

test("doctor：缺私钥逐项指认", async () => {
  const db = freshDb();
  const result = await doctor.runDoctor({
    db,
    driver: createStubDriver(async () => ({ ok: true })),
    config: { archiveEnabled: true, secret: "s".repeat(40), seatScope: ["a"] },
    now: NOW,
  });
  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes("private_key_missing"));
  assert.match(result.verdict, /private_key_missing/);
});

test("doctor：接口通但零数据不算通过", async () => {
  const db = freshDb();
  store.writeCursor(db, { id: "default", seq: 1, lastCheckedAt: NOW - 60_000, lastMessageAt: NOW - 60_000, lastSuccessAt: NOW - 60_000 });
  const result = await doctor.runDoctor({
    db,
    driver: createStubDriver(async () => ({ ok: true, egressIp: "1.2.3.4" })),
    config: {
      archiveEnabled: true,
      privateKeyPath: "/k.pem",
      secret: "s".repeat(40),
      expectedEgressIp: "1.2.3.4",
      seatScope: ["a"],
    },
    now: NOW,
  });
  assert.equal(result.ok, false);
  assert.match(result.verdict, /零数据/);
});

test("doctor：滞后超 5 天时结论写明不可补偿", async () => {
  const db = freshDb();
  store.writeCursor(db, {
    id: "default",
    seq: 3,
    lastCheckedAt: NOW,
    lastMessageAt: NOW - 6 * DAY,
    lastSuccessAt: NOW - 6 * DAY,
  });
  const result = await doctor.runDoctor({
    db,
    config: { archiveEnabled: true, privateKeyPath: "/k.pem", secret: "s".repeat(40), seatScope: ["a"] },
    now: NOW,
  });
  assert.ok(result.blockers.includes("history_unrecoverable"));
  assert.equal(result.lag.level, "lost");
});

test("doctor：出口 IP 不一致被单列", async () => {
  const db = freshDb();
  const result = await doctor.runDoctor({
    db,
    driver: createStubDriver(async () => ({ ok: true, egressIp: "9.9.9.9" })),
    config: {
      archiveEnabled: true,
      privateKeyPath: "/k.pem",
      secret: "s".repeat(40),
      expectedEgressIp: "1.2.3.4",
      seatScope: ["a"],
    },
    now: NOW,
  });
  assert.ok(result.blockers.includes("egress_ip_mismatch"));
  assert.equal(result.checks.actualEgressIp, "9.9.9.9");
});

test("doctor：一行摘要可读（日志用）", async () => {
  const db = freshDb();
  store.upsertConversation(db, { conversationId: "c1", kind: "g", name: "g", agreeState: "agree", agreeAt: NOW });
  const result = await doctor.runDoctor({ db, config: {}, now: NOW });
  const line = doctor.doctorLine(result);
  assert.match(line, /未就绪/);
  assert.match(line, /会话 1/);
});
