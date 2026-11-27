#!/usr/bin/env node
// ── 客服发文件（add-kf-file-reply）──────────────────────────────────────────
//
// 守的是"对外动作"这条链上最容易出错的四件事，每条都对应一个真实的错法：
//
//   1. 窗口/演练没拦住 → 客户 60 小时前说的话，我们还在给他发文件（或演练时
//      悄悄真上传了一次，在腾讯侧留下对象）。
//   2. 上传与发送合成一步 → 发送失败时重试会把文件重新传一遍，撞限频还查不出原因。
//   3. 复用过期 media_id → 报成"发送失败"，调用方一直重试一直失败。
//   4. 本地闸门放在请求之后 → 21MB 的表格打进腾讯，报错指向凭据/网络。
//
// 判据统一为"stub 客户端被调了几次"，因为这几条的正确行为都是**零请求**。
//
//   node --test scripts/test-kf-file-reply.mjs

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";

const store = await import("../server/archive/kf/store.js");
const { sendFileReply, resetMediaCache } = await import("../server/archive/kf/reply.js");
const { inspectUpload, ALLOWED_EXTENSIONS } = await import("../server/archive/kf/upload-guard.js");
const { UPLOAD_MAX_BYTES, UPLOAD_MIN_BYTES } = await import("../server/archive/kf/api.js");

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const CONV = "kf1|u1";

function freshDb() {
  const db = new DatabaseSync(":memory:");
  store.ensureKfSchema(db);
  store.upsertKfConversation(db, { conversationId: CONV, openKfId: "kf1", externalUserId: "u1" });
  return db;
}

/** 客户最后一次发言在 `hoursAgo` 小时前。 */
function seedCustomerSpoke(db, hoursAgo = 1) {
  store.insertKfMessage(db, {
    id: `${CONV}:m1`,
    conversationId: CONV,
    msgId: "m1",
    openKfId: "kf1",
    externalUserId: "u1",
    sentAt: NOW - hoursAgo * HOUR,
    origin: "peer",
    msgType: "text",
    text: "麻烦发一份报价单",
    ingestedAt: NOW - hoursAgo * HOUR,
  });
  store.refreshKfConversationStats(db, CONV);
}

/** 一份"合法"的 xlsx：ZIP 头 + 足够字节数（内容不必真能解压，闸门只看头部）。 */
function xlsxBytes(pad = 200) {
  const head = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  return Buffer.concat([head, Buffer.alloc(pad, 0x41)]);
}

function tempDir(prefix = "kf-file-reply-") {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function writeFile(dir, name, bytes) {
  const p = path.join(dir, name);
  writeFileSync(p, bytes);
  return p;
}

/** 记录调用次数的 stub；可注入失败。 */
function stubClient({ uploadError = null, sendErrors = [] } = {}) {
  const calls = { upload: 0, send: 0, payloads: [] };
  return {
    calls,
    async uploadMedia(args) {
      calls.upload += 1;
      calls.payloads.push({ op: "upload", name: args.fileName, bytes: args.buffer?.length });
      if (uploadError) throw uploadError;
      return { mediaId: `MID-${calls.upload}`, createdAt: NOW };
    },
    async sendFile(args) {
      calls.send += 1;
      calls.payloads.push({ op: "send", mediaId: args.mediaId });
      const err = sendErrors[calls.send - 1];
      if (err) throw err;
      return { msgId: `srv-${calls.send}` };
    },
  };
}

function mediaError(msg = "media_id expired") {
  const e = new Error(msg);
  e.errcode = 40007;
  return e;
}

// ── 闸门：全部零请求 ────────────────────────────────────────────────────────

test("窗口外：零请求（不上传也不发送）", async () => {
  const dir = tempDir();
  try {
    const db = freshDb();
    seedCustomerSpoke(db, 60);
    const client = stubClient();
    const res = await sendFileReply({
      db,
      client,
      conversationId: CONV,
      filePath: writeFile(dir, "报价单.xlsx", xlsxBytes()),
      allowedRoot: dir,
      now: NOW,
    });
    assert.equal(res.ok, false);
    assert.equal(res.stage, "window");
    assert.equal(client.calls.upload, 0, "窗口外不得上传");
    assert.equal(client.calls.send, 0, "窗口外不得发送");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("本地闸门四类拒绝：零请求", async () => {
  const dir = tempDir();
  const outside = tempDir("kf-outside-");
  try {
    const db = freshDb();
    seedCustomerSpoke(db, 1);
    const client = stubClient();

    const cases = [
      ["https://example.com/a.xlsx", "远程地址"],
      [path.join(dir, "不存在.xlsx"), "不存在"],
      [writeFile(dir, "表.exe", xlsxBytes()), "扩展名"],
      [writeFile(dir, "假表.xlsx", Buffer.from("这不是ZIP，只是个文本文件而已", "utf8")), "内容与扩展名不符"],
    ];
    for (const [filePath, label] of cases) {
      const res = await sendFileReply({
        db, client, conversationId: CONV, filePath, allowedRoot: dir, now: NOW,
      });
      assert.equal(res.ok, false, `${label} 应被拒`);
      assert.equal(res.stage, "guard", `${label} 应停在 guard`);
    }

    // 允许根之外的合法文件也要拒（否则允许根形同虚设）
    const outsideFile = writeFile(outside, "报价单.xlsx", xlsxBytes());
    const res = await sendFileReply({
      db, client, conversationId: CONV, filePath: outsideFile, allowedRoot: dir, now: NOW,
    });
    assert.equal(res.ok, false);
    assert.equal(res.stage, "guard");
    assert.match(res.reason, /允许目录/);

    assert.equal(client.calls.upload, 0, "闸门拒绝零上传");
    assert.equal(client.calls.send, 0, "闸门拒绝零发送");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("体积上下限：<6 字节与 >20MB 都在本地拒绝", async () => {
  const dir = tempDir();
  try {
    const tiny = inspectUpload({ filePath: writeFile(dir, "小.txt", Buffer.from("abc")), allowedRoot: dir });
    assert.equal(tiny.ok, false);
    assert.match(tiny.reason, new RegExp(String(UPLOAD_MIN_BYTES)));

    // 只 stat 不读内容：用稀疏文件避免真的写 21MB
    const big = path.join(dir, "大.zip");
    writeFileSync(big, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(16)]));
    const { truncateSync } = await import("node:fs");
    truncateSync(big, UPLOAD_MAX_BYTES + 1);
    const res = inspectUpload({ filePath: big, allowedRoot: dir });
    assert.equal(res.ok, false);
    assert.match(res.reason, new RegExp(String(UPLOAD_MAX_BYTES)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 正常路径 ────────────────────────────────────────────────────────────────

test("上传后发送：落一行 self/file，正文位置是文件名", async () => {
  resetMediaCache();
  const dir = tempDir();
  try {
    const db = freshDb();
    seedCustomerSpoke(db, 1);
    const client = stubClient();
    const res = await sendFileReply({
      db, client, conversationId: CONV, filePath: writeFile(dir, "报价单.xlsx", xlsxBytes()),
      allowedRoot: dir, now: NOW,
    });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.uploaded, true);
    assert.equal(res.sent, true);
    assert.equal(client.calls.upload, 1);
    assert.equal(client.calls.send, 1);

    const row = db.prepare("SELECT msg_type, text, origin, media_type FROM kf_message WHERE msg_id='srv-1'").get();
    assert.equal(row.msg_type, "file");
    assert.equal(row.text, "报价单.xlsx", "正文位置放文件名，检索才有意义");
    assert.equal(row.origin, "self");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("同一文件第二次发送：复用 media_id，只发不传", async () => {
  resetMediaCache();
  const dir = tempDir();
  try {
    const db = freshDb();
    seedCustomerSpoke(db, 1);
    const client = stubClient();
    const filePath = writeFile(dir, "报价单.xlsx", xlsxBytes());
    await sendFileReply({ db, client, conversationId: CONV, filePath, allowedRoot: dir, now: NOW });
    const second = await sendFileReply({
      db, client, conversationId: CONV, filePath, allowedRoot: dir, now: NOW + 1000,
    });
    assert.equal(second.ok, true);
    assert.equal(second.uploaded, false, "第二次不该上传");
    assert.equal(client.calls.upload, 1, "上传次数仍为 1");
    assert.equal(client.calls.send, 2, "发送两次");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("首次上传失败：报 upload 阶段，零发送", async () => {
  resetMediaCache();
  const dir = tempDir();
  try {
    const db = freshDb();
    seedCustomerSpoke(db, 1);
    const client = stubClient({ uploadError: mediaError("too large") });
    const res = await sendFileReply({
      db, client, conversationId: CONV, filePath: writeFile(dir, "报价单.xlsx", xlsxBytes()),
      allowedRoot: dir, now: NOW,
    });
    assert.equal(res.ok, false);
    assert.equal(res.stage, "upload");
    assert.equal(res.sent, false);
    assert.equal(client.calls.send, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("首次上传成功但发送失败：报 send 阶段，重试只重发", async () => {
  resetMediaCache();
  const dir = tempDir();
  try {
    const db = freshDb();
    seedCustomerSpoke(db, 1);
    // 第一次发送失败，第二次成功。
    const client = stubClient({ sendErrors: [new Error("boom"), null] });
    const filePath = writeFile(dir, "报价单.xlsx", xlsxBytes());
    const first = await sendFileReply({ db, client, conversationId: CONV, filePath, allowedRoot: dir, now: NOW });
    assert.equal(first.ok, false);
    assert.equal(first.stage, "send");
    assert.equal(first.uploaded, true, "调用方要能看出『传过但没发出去』");

    const retry = await sendFileReply({
      db, client, conversationId: CONV, filePath, allowedRoot: dir, now: NOW + 1000,
    });
    assert.equal(retry.ok, true);
    assert.equal(client.calls.upload, 1, "重试不得重传");
    assert.equal(client.calls.send, 2);
    assert.equal(retry.reuploaded, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("复用的 media_id 过期：重传再发，结果标 reuploaded", async () => {
  resetMediaCache();
  const dir = tempDir();
  try {
    const db = freshDb();
    seedCustomerSpoke(db, 1);
    const filePath = writeFile(dir, "报价单.xlsx", xlsxBytes());

    // 第一次：上传 + 发送都成功，缓存里留下 MID-1。
    const okClient = stubClient();
    await sendFileReply({ db, client: okClient, conversationId: CONV, filePath, allowedRoot: dir, now: NOW });

    // 第二次：发送以"媒体失效"失败 → 必须重传一次再发成功。
    const expireClient = stubClient({ sendErrors: [mediaError("invalid media_id"), null] });
    const res = await sendFileReply({
      db, client: expireClient, conversationId: CONV, filePath, allowedRoot: dir, now: NOW + 2000,
    });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.reuploaded, true, "必须把『重新上传过』说出来");
    assert.equal(expireClient.calls.upload, 1, "过期后重传一次");
    assert.equal(expireClient.calls.send, 2, "先失败一次、重传后再发一次");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("缓存超过 TTL 视为不存在：重新上传", async () => {
  resetMediaCache();
  const dir = tempDir();
  try {
    const db = freshDb();
    seedCustomerSpoke(db, 1);
    const filePath = writeFile(dir, "报价单.xlsx", xlsxBytes());
    const client = stubClient();
    await sendFileReply({ db, client, conversationId: CONV, filePath, allowedRoot: dir, now: NOW });
    const { MEDIA_CACHE_TTL_MS } = await import("../server/archive/kf/reply.js");
    const later = await sendFileReply({
      db, client, conversationId: CONV, filePath, allowedRoot: dir, now: NOW + MEDIA_CACHE_TTL_MS + 1,
    });
    assert.equal(later.ok, true);
    assert.equal(later.uploaded, true, "TTL 之后必须重传");
    assert.equal(client.calls.upload, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 白名单本身 ──────────────────────────────────────────────────────────────

test("白名单覆盖办公文档，且不含可执行/脚本类型", () => {
  for (const ext of [".xlsx", ".xls", ".csv", ".pdf", ".docx", ".doc", ".pptx", ".txt"]) {
    assert.ok(ALLOWED_EXTENSIONS.has(ext), `${ext} 应允许`);
  }
  for (const ext of [".exe", ".sh", ".js", ".bat", ".dll"]) {
    assert.equal(ALLOWED_EXTENSIONS.has(ext), false, `${ext} 不该允许`);
  }
});

// ── 线上形状：钉住官方两条接口的请求形状 ────────────────────────────────────
//
// 这一段拦的是"本地全绿、线上必错"的一类：multipart 字段名写成 file、忘了 type、
// 手写 content-type 把 boundary 覆盖掉、send_msg 的 file 体写成 {media_id} 而不是
// {file:{media_id}}。官方形状见 api.js 文件头注释（path/90389 与 path/94677）。

test("上传请求形状：/cgi-bin/media/upload?type=file，multipart 字段名 media", async () => {
  const { createKfClient } = await import("../server/archive/kf/api.js");
  const seen = [];
  const client = createKfClient({
    corpId: "corp",
    secret: "sec",
    fetchImpl: async (url, init) => {
      seen.push({ url: String(url), init });
      if (String(url).includes("/cgi-bin/gettoken")) {
        return new Response(JSON.stringify({ errcode: 0, access_token: "T", expires_in: 7200 }), { status: 200 });
      }
      return new Response(JSON.stringify({ errcode: 0, media_id: "MID-X", created_at: 1700000000 }), { status: 200 });
    },
  });

  const out = await client.uploadMedia({
    mediaType: "file",
    fileName: "报价单.xlsx",
    buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]),
  });
  assert.equal(out.mediaId, "MID-X");

  const up = seen.find((s) => s.url.includes("/media/upload"));
  assert.ok(up, "应打到 /cgi-bin/media/upload");
  const u = new URL(up.url);
  assert.equal(u.searchParams.get("type"), "file", "type 必须是 file");
  assert.equal(u.searchParams.get("access_token"), "T");
  assert.ok(up.init.body instanceof FormData, "必须是 multipart（FormData）");
  // 手写 content-type 会把 boundary 覆盖掉；这里断言我们没写。
  assert.equal(up.init.headers?.["content-type"], undefined, "不得手写 content-type");
  const field = up.init.body.get("media");
  assert.ok(field && typeof field !== "string", "字段名必须是 media，且是文件而不是字符串");
});

test("发送请求形状：send_msg 的 file 体是 {file:{media_id}}", async () => {
  const { createKfClient } = await import("../server/archive/kf/api.js");
  let sentBody = null;
  const client = createKfClient({
    corpId: "corp",
    secret: "sec",
    fetchImpl: async (url, init) => {
      if (String(url).includes("/cgi-bin/gettoken")) {
        return new Response(JSON.stringify({ errcode: 0, access_token: "T", expires_in: 7200 }), { status: 200 });
      }
      sentBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ errcode: 0, msgid: "SRV-9" }), { status: 200 });
    },
  });

  const out = await client.sendFile({ externalUserId: "u1", openKfId: "kf1", mediaId: "MID-X" });
  assert.equal(out.msgId, "SRV-9");
  assert.deepEqual(sentBody, {
    touser: "u1",
    open_kfid: "kf1",
    msgtype: "file",
    file: { media_id: "MID-X" },
  });
});
