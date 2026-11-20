#!/usr/bin/env node
// ── kf 媒体拉取：真假二进制、重试、先写后标完成 ─────────────────────────────
//
// 最贵的一条是「JSON 当失败」：官方媒体接口出错时返回 HTTP 200 + JSON，
// 把那段 JSON 当文件写下去会得到一个几百字节的"假图片"，状态还是 done，
// 而 done 不再重试——这个洞永远不会被自动补上。
//
//   node --test scripts/test-kf-media.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";

const store = await import("../server/archive/kf/store.js");
const { pullKfMedia, safeMediaName } = await import("../server/archive/kf/media.js");
const { createKfClient, MAX_MEDIA_BYTES } = await import("../server/archive/kf/api.js");
const { runKfPullCycle } = await import("../server/archive/kf/ingest.js");

const NOW = 1_700_000_000_000;

function freshDb() {
  const db = new DatabaseSync(":memory:");
  store.ensureKfSchema(db);
  return db;
}

function queue(db, { id = "kf1|u1:m1", mediaId = "MID", mediaType = "image" } = {}) {
  store.queueKfMedia(db, {
    id,
    messageId: id,
    conversationId: "kf1|u1",
    mediaId,
    mediaType,
  });
}

const okClient = (buf = Buffer.from([1, 2, 3])) => ({
  async getMedia() {
    return { buffer: buf, contentType: "image/jpeg", filename: "a.jpg" };
  },
});

test("拉取成功：落盘器拿到原始字节，状态 done 且有 path", async () => {
  const db = freshDb();
  queue(db);
  const written = [];
  const report = await pullKfMedia(db, okClient(Buffer.from([0xff, 0x00, 0x01])), {
    writer: async (job) => {
      written.push(job);
      return "/tmp/x.jpg";
    },
  });
  assert.equal(report.done, 1);
  assert.equal(report.bytes, 3);
  assert.deepEqual([...written[0].buffer], [0xff, 0x00, 0x01], "0x00 不能被截断");
  const row = db.prepare("SELECT * FROM kf_media").get();
  assert.equal(row.state, "done");
  assert.equal(row.path, "/tmp/x.jpg");
  assert.equal(Number(row.bytes), 3);
});

test("接口报错：重试到上限后判 failed，错误留档", async () => {
  const db = freshDb();
  queue(db, { mediaId: "BAD" });
  const client = {
    async getMedia() {
      const err = new Error("media_get 失败：errcode=40007 invalid media_id");
      err.errcode = 40007;
      throw err;
    },
  };
  const first = await pullKfMedia(db, client, { maxAttempts: 2 });
  assert.equal(first.retried, 1, "第一次不判死");
  let row = db.prepare("SELECT * FROM kf_media").get();
  assert.equal(row.state, "pending");
  assert.equal(Number(row.attempts), 1);

  const second = await pullKfMedia(db, client, { maxAttempts: 2 });
  assert.equal(second.failed, 1);
  row = db.prepare("SELECT * FROM kf_media").get();
  assert.equal(row.state, "failed");
  assert.ok(String(row.last_error).includes("40007"));
});

test("落盘失败时不标 done（否则出现「状态 done、文件不存在」）", async () => {
  const db = freshDb();
  queue(db);
  const report = await pullKfMedia(db, okClient(), {
    writer: async () => {
      throw new Error("ENOSPC");
    },
    maxAttempts: 1,
  });
  assert.equal(report.done, 0);
  assert.equal(report.failed, 1);
  const row = db.prepare("SELECT * FROM kf_media").get();
  assert.equal(row.state, "failed");
  assert.ok(String(row.last_error).includes("ENOSPC"));
});

test("客户端返回非 Buffer：当失败，不写盘", async () => {
  const db = freshDb();
  queue(db);
  const report = await pullKfMedia(
    db,
    {
      async getMedia() {
        return { buffer: "not-a-buffer" };
      },
    },
    { maxAttempts: 1 },
  );
  assert.equal(report.failed, 1);
  assert.equal(db.prepare("SELECT state FROM kf_media").get().state, "failed");
});

test("完成率：空库返回 null，不返回 1", async () => {
  const db = freshDb();
  assert.equal(store.kfMediaCompletion(db).ratio, null, "空库不该显示 100%");
  queue(db, { id: "a" });
  queue(db, { id: "b" });
  await pullKfMedia(db, okClient());
  const c = store.kfMediaCompletion(db);
  assert.equal(c.total, 2);
  assert.equal(c.done, 2);
  assert.equal(c.ratio, 1);
});

test("媒体类型决定扩展名，文件名不含路径分隔符", () => {
  assert.ok(safeMediaName({ conversationId: "kf1|u1", messageId: "m1", mediaType: "image" }).endsWith(".jpg"));
  assert.ok(safeMediaName({ conversationId: "kf1|u1", messageId: "m1", mediaType: "file" }).endsWith(".bin"));
  const name = safeMediaName({
    conversationId: "../../etc",
    messageId: "a/b",
    mediaType: "image",
  });
  assert.ok(!name.includes("/"), name);
  assert.ok(!name.includes(".."), name);
});

// ── 真机 bug 回归（2026-11-12）──────────────────────────────────────────────
//
// 现场：客户连发两个文件，两条记录都 state='done'，磁盘上只有一个——后下的
// 覆盖了先下的。原因：文件名先拼接再截断到 120 字符，而 messageId 本身以
// conversationId 开头（`openKfId|externalUserid:uniquePart`，前缀 65 字符），
// 120 字符刚好砍在重复前缀里，**唯一的尾巴被截掉**，于是两个附件同名。
//
// 这组用例用真实长度的 id 形状守住它：唯一性必须来自不会被截断的位置。
test("同会话下的不同附件必须得到不同文件名（真机 120 字符截断 bug）", () => {
  const openKfId = "wkqmGucgAAlOx0IPWASY_zpufMyzYDyg";
  const extUser = "wmqmGucgAATt44bysrXes8Z205XuLdLA";
  const conversationId = `${openKfId}|${extUser}`;
  const mk = (uniq, mediaId = `media_${uniq}`) =>
    safeMediaName({
      conversationId,
      messageId: `${conversationId}:${uniq}`,
      mediaId,
      mediaType: "file",
    });

  const a = mk("3FPTvS58Ch1ojMMuUbsGKVT1k");
  const b = mk("Ak1ULNcpmLvSFPejHLSXxirGea");
  assert.notEqual(a, b, `两个附件撞名了：${a}`);

  // 同一消息里的两个附件也不能撞
  assert.notEqual(mk("sameMessage", "media_one"), mk("sameMessage", "media_two"));

  // 换一个客户也要变
  const other = safeMediaName({
    conversationId: `${openKfId}|anotherUserXXXXXXXXXXXXXXXXXXXXXXXX`,
    messageId: `${openKfId}|anotherUserXXXXXXXXXXXXXXXXXXXXXXXX:3FPTvS58Ch1ojMMuUbsGKVT1k`,
    mediaId: "media_3FPTvS58Ch1ojMMuUbsGKVT1k",
    mediaType: "file",
  });
  assert.notEqual(a, other);
});

test("长 id 下文件名仍唯一且长度可控（唯一性不是靠截断换来的）", () => {
  const conversationId = `${"a".repeat(80)}|${"b".repeat(80)}`;
  const mk = (uniq) =>
    safeMediaName({
      conversationId,
      messageId: `${conversationId}:${uniq}`,
      mediaId: "d".repeat(80),
      mediaType: "image",
    });
  const name = mk("c".repeat(80));
  assert.ok(name.length <= 130, `文件名过长：${name.length}`);
  assert.ok(name.endsWith(".jpg"));
  assert.ok(!name.includes("/") && !name.includes(".."));
  assert.notEqual(name, mk("e".repeat(80)));
});

test("摄取时自动入队媒体，非媒体消息不入队", async () => {
  const db = freshDb();
  const client = {
    async syncMsg() {
      return {
        nextCursor: "c1",
        hasMore: false,
        messages: [
          {
            msgid: "m1",
            open_kfid: "kf1",
            external_userid: "u1",
            send_time: Math.floor(NOW / 1000),
            origin: 3,
            msgtype: "image",
            image: { media_id: "MID-OK" },
          },
          {
            msgid: "m2",
            open_kfid: "kf1",
            external_userid: "u1",
            send_time: Math.floor(NOW / 1000),
            origin: 3,
            msgtype: "text",
            text: { content: "顺便问个价" },
          },
        ],
      };
    },
    async resolveOpenKfId() {
      return { openKfId: "kf1", source: "auto", accounts: [{ open_kfid: "kf1" }] };
    },
    async getCustomers() {
      return { customers: [], invalid: [] };
    },
  };
  const report = await runKfPullCycle({ db, client, now: NOW });
  assert.equal(report.inserted, 2);
  assert.equal(report.mediaQueued, 1, "只有图片那条入队");
  const rows = store.pendingKfMedia(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].mediaId, "MID-OK");
});

test("重放同一批不会重复入队媒体", async () => {
  const db = freshDb();
  const batch = {
    nextCursor: "c1",
    hasMore: false,
    messages: [
      {
        msgid: "m1",
        open_kfid: "kf1",
        external_userid: "u1",
        send_time: Math.floor(NOW / 1000),
        origin: 3,
        msgtype: "image",
        image: { media_id: "MID-OK" },
      },
    ],
  };
  const client = {
    async syncMsg() {
      return batch;
    },
    async resolveOpenKfId() {
      return { openKfId: "kf1", source: "auto", accounts: [{ open_kfid: "kf1" }] };
    },
    async getCustomers() {
      return { customers: [], invalid: [] };
    },
  };
  await runKfPullCycle({ db, client, now: NOW });
  await runKfPullCycle({ db, client, now: NOW + 1000 });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM kf_media").get().n, 1);
});

test("媒体接口返回 JSON（200 + errcode=0）也算失败，不当文件写", async () => {
  const client = createKfClient({
    corpId: "ww-corp",
    secret: "S".repeat(40),
    now: () => NOW,
    timeoutMs: 0,
    fetchImpl: async (url) => {
      if (url.includes("/gettoken")) {
        return {
          status: 200,
          headers: { get: () => "application/json" },
          async json() {
            return { errcode: 0, access_token: "T".repeat(20), expires_in: 7200 };
          },
        };
      }
      return {
        status: 200,
        headers: { get: () => "application/json" },
        async json() {
          return { errcode: 0, errmsg: "ok" };
        },
      };
    },
  });
  await assert.rejects(() => client.getMedia({ mediaId: "X" }), (err) => {
    assert.equal(err.errcode, -5);
    assert.ok(err.message.includes("JSON"), err.message);
    return true;
  });
});

test("媒体超过运维护栏：拒绝，不写盘", async () => {
  const big = Buffer.alloc(MAX_MEDIA_BYTES + 1);
  const client = createKfClient({
    corpId: "ww-corp",
    secret: "S".repeat(40),
    now: () => NOW,
    timeoutMs: 0,
    fetchImpl: async (url) => {
      if (url.includes("/gettoken")) {
        return {
          status: 200,
          headers: { get: () => "application/json" },
          async json() {
            return { errcode: 0, access_token: "T".repeat(20), expires_in: 7200 };
          },
        };
      }
      return {
        status: 200,
        headers: { get: () => "image/jpeg" },
        async arrayBuffer() {
          return big.buffer.slice(big.byteOffset, big.byteOffset + big.length);
        },
      };
    },
  });
  await assert.rejects(() => client.getMedia({ mediaId: "X" }), (err) => {
    assert.equal(err.errcode, -6);
    return true;
  });
});

test("媒体接口令牌失效：刷新一次后成功", async () => {
  let tokenCalls = 0;
  let mediaCalls = 0;
  const client = createKfClient({
    corpId: "ww-corp",
    secret: "S".repeat(40),
    now: () => NOW,
    timeoutMs: 0,
    fetchImpl: async (url) => {
      if (url.includes("/gettoken")) {
        tokenCalls += 1;
        return {
          status: 200,
          headers: { get: () => "application/json" },
          async json() {
            return { errcode: 0, access_token: `TOK${tokenCalls}`, expires_in: 7200 };
          },
        };
      }
      mediaCalls += 1;
      if (mediaCalls === 1) {
        return {
          status: 200,
          headers: { get: () => "application/json" },
          async json() {
            return { errcode: 42001, errmsg: "expired" };
          },
        };
      }
      return {
        status: 200,
        headers: { get: () => "image/jpeg" },
        async arrayBuffer() {
          return Uint8Array.from([9, 8, 7]).buffer;
        },
      };
    },
  });
  const out = await client.getMedia({ mediaId: "X" });
  assert.deepEqual([...out.buffer], [9, 8, 7]);
  assert.equal(tokenCalls, 2, "刷新一次");
  assert.equal(mediaCalls, 2, "重试一次");
});

// ── 自愈：done 但文件已不在盘上（2026-11-12 实测发现）────────────────────────
//
// 现场：我删掉媒体目录后重跑，图片那条仍是 state='done'，于是永不重试——
// 库里 ratio 还是 1，附件却已经打不开。这是"状态与文件脱耦"的另一半。
test("自愈：done 但文件不存在 → 退回 pending 并重新落盘", async () => {
  const { mkdtempSync, rmSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");

  const dir = mkdtempSync(path.join(tmpdir(), "kf-heal-"));
  try {
    const db = freshDb();
    queue(db, { id: "kf1|u1:m1", mediaId: "MID1" });
    const { fileWriter } = await import("../server/archive/kf/media.js");
    const writer = fileWriter(dir);

    // 先正常下一份
    await pullKfMedia(db, okClient(), { writer });
    const first = db.prepare("select state, path from kf_media where media_id='MID1'").get();
    assert.equal(first.state, "done");
    assert.ok(existsSync(first.path), first.path);

    // 模拟"目录/文件后来没了"
    rmSync(first.path);
    assert.equal(existsSync(first.path), false);

    // 关键：不直接调 requeueMissingFiles，只跑拉取循环——验证它**确实挂在**循环上，
    // 而不是"函数存在、测试直接调它"（声明≠挂载）。
    const report = await pullKfMedia(db, okClient(), { writer });
    assert.equal(report.requeued, 1, "拉取循环应自己发现并退回这条记录");
    assert.equal(report.done, 1, "同一轮里应重新落盘");
    const again = db.prepare("select state, path from kf_media where media_id='MID1'").get();
    assert.ok(existsSync(again.path), "重新下载后文件应存在");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("自愈不误伤：文件仍在的 done 行不动", async () => {
  const { requeueMissingFiles, fileWriter } = await import("../server/archive/kf/media.js");
  const { mkdtempSync, rmSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");

  const dir = mkdtempSync(path.join(tmpdir(), "kf-heal2-"));
  try {
    const db = freshDb();
    queue(db, { id: "kf1|u1:m1", mediaId: "MID1" });
    await pullKfMedia(db, okClient(), { writer: fileWriter(dir) });
    const row = db.prepare("select state, path from kf_media where media_id='MID1'").get();
    assert.ok(existsSync(row.path));

    assert.equal(requeueMissingFiles(db), 0, "文件还在就不该退回");
    assert.equal(db.prepare("select state from kf_media where media_id='MID1'").get().state, "done");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
