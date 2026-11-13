#!/usr/bin/env node
// ── 客户发来的附件要能读（add-kf-attachment-text）────────────────────────────
//
// 守的是"附件读不到"这一类静默故障，每条都对应一个真实的错法：
//
//   1. 靠文件名判类型 → kf 根本不给文件名，全落成 .bin，一条都抽不出来。
//   2. 抽取失败连累下载状态 → state 被打回 pending，下一轮重下一个已经在盘上的文件。
//   3. 抽取没有上限/超时 → 一张几万行的表把上下文和库都吃掉；或解析器挂住拉取轮次。
//   4. 缺解析器就崩 → 纯 sidecar 只有 Node 标准库，一个 import 就把进程带走。
//   5. 附件没抽出来却给空正文 → agent 以为客户什么都没说，而不是"有一份读不了的附件"。
//
//   node --test scripts/test-kf-attachment-text.mjs

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";

const store = await import("../server/archive/kf/store.js");
const { sniffAttachmentKind, extractAttachment, EXTRACT_MAX_CHARS } = await import(
  "../server/archive/kf/extract.js"
);
const { pullKfMedia, fileWriter, extractAndRecord, runKfExtractionBackfill } = await import(
  "../server/archive/kf/media.js"
);
const { kfAgentInput } = await import("../server/archive/kf/ingest.js");

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const CONV = "kf1|u1";

// 真的 xlsx 用来验证"抽取真的能拿到单元格"，而不是只验证我自己的桩。
// 解析器没装（干净 worktree）时整段降级为 skip——红应当意味着"代码坏了"。
const XLSX_PATH = path.resolve("docs/vertical-packs/skills/doc-studio/samples/S2-数据工作簿.xlsx");
let XLSX = null;
try {
  XLSX = readFileSync(XLSX_PATH);
} catch {
  XLSX = null;
}
let OFFICE_OK = false;
if (XLSX) {
  const mod = await import("officeparser").catch(() => null);
  OFFICE_OK = Boolean(mod);
}

const XLSX_TEXT_MARK = "毛利率";

function freshDb() {
  const db = new DatabaseSync(":memory:");
  store.ensureKfSchema(db);
  store.upsertKfConversation(db, { conversationId: CONV, openKfId: "kf1", externalUserId: "u1" });
  return db;
}

function tempDir(prefix = "kf-attach-") {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

/** 一条带附件的客户消息。 */
function seedMediaMessage(db, { msgId = "m1", mediaType = "file", at = NOW } = {}) {
  const id = `${CONV}:${msgId}`;
  store.insertKfMessage(db, {
    id,
    conversationId: CONV,
    msgId,
    openKfId: "kf1",
    externalUserId: "u1",
    sentAt: at,
    origin: "peer",
    msgType: mediaType,
    text: "",
    mediaId: `MID-${msgId}`,
    mediaType,
    ingestedAt: at,
  });
  store.queueKfMedia(db, {
    id,
    messageId: id,
    conversationId: CONV,
    mediaId: `MID-${msgId}`,
    mediaType,
  });
  return id;
}

/** 构造一个"像 xlsx/docx/pptx 的 ZIP 头 + 条目名"的假容器（只给类型判定用）。 */
function fakeZip(entry) {
  return Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.alloc(64, 0x41),
    Buffer.from(entry, "latin1"),
  ]);
}

// ── ① 按内容判类型（不依赖文件名）─────────────────────────────────────────

test("无文件名的 xlsx/docx/pptx：靠 ZIP 内条目名判对", () => {
  assert.equal(sniffAttachmentKind({ buffer: fakeZip("xl/workbook.xml") }).kind, "xlsx");
  assert.equal(sniffAttachmentKind({ buffer: fakeZip("word/document.xml") }).kind, "docx");
  assert.equal(sniffAttachmentKind({ buffer: fakeZip("ppt/presentation.xml") }).kind, "pptx");
  // 关键点：不给任何文件名提示，仍然判得出来。
});

test("后缀提示与内容不符时以内容为准", () => {
  const plain = Buffer.from("这是一段普通文本，根本不是表\n");
  const r = sniffAttachmentKind({ buffer: plain, fileNameHint: "报价单.xlsx" });
  assert.equal(r.kind, "txt", "内容是文本，就不能按 xlsx 解析");
  assert.equal(r.basis, "no-nul");
});

test("PDF 与老式 OLE 文档按魔数判定", () => {
  assert.equal(sniffAttachmentKind({ buffer: Buffer.from("%PDF-1.7 ...") }).kind, "pdf");
  const cfb = (needle) =>
    Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.alloc(32, 0),
      Buffer.from(needle, "utf16le"),
    ]);
  assert.equal(sniffAttachmentKind({ buffer: cfb("WordDocument") }).kind, "doc");
  assert.equal(sniffAttachmentKind({ buffer: cfb("Workbook") }).kind, "xls");
});

test("判不出的类型不猜", () => {
  const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x01]);
  const r = sniffAttachmentKind({ buffer: binary });
  assert.equal(r.kind, "unknown");
  assert.ok(r.reason, "必须说明为什么判不出");
});

// ── ② 抽取：上限 / 超时 / 降级 ────────────────────────────────────────────

test("真 xlsx：抽出单元格文本（类型判对 + 解析成功）", { skip: !OFFICE_OK && "未装 officeparser" }, async () => {
  const r = await extractAttachment({ buffer: XLSX });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.kind, "xlsx");
  assert.ok(r.text.includes(XLSX_TEXT_MARK), `应抽到表头「${XLSX_TEXT_MARK}」`);
});

test("文本超上限：截断但记真实字符数", async () => {
  const long = "含税单价".repeat(2000); // 8000 字符
  const r = await extractAttachment({ buffer: Buffer.from(long), maxChars: 100 });
  assert.equal(r.ok, true);
  assert.equal(r.chars, long.length, "chars 必须是截断前的真实值");
  assert.equal(r.text.length, 100);
  assert.equal(r.truncated, true);
});

test("超过输入上限：不读进解析器，直接判失败", async () => {
  let called = 0;
  const r = await extractAttachment({
    buffer: Buffer.alloc(20, 0x41),
    kind: "xlsx",
    maxBytes: 10,
    deps: {
      extractOffice: async () => {
        called += 1;
        return "不该被调用";
      },
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "too_large");
  assert.equal(called, 0, "解析器不得被调用");
});

test("判不出类型：不尝试解析", async () => {
  const r = await extractAttachment({ buffer: Buffer.from([1, 0, 2, 0, 3, 0, 4]) });
  assert.equal(r.ok, false);
  assert.equal(r.code, "unknown_kind");
});

test("缺解析器：报 no_extractor，不抛异常", async () => {
  const err = new Error("Cannot find module 'officeparser'");
  err.code = "MODULE_NOT_FOUND";
  const r = await extractAttachment({
    buffer: fakeZip("xl/workbook.xml"),
    deps: { extractOffice: async () => { throw err; } },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "no_extractor", "缺依赖是部署形态，不是故障");
});

test("解析器挂住：超时判失败，不把调用方拖死", async () => {
  const started = Date.now();
  const r = await extractAttachment({
    buffer: fakeZip("xl/workbook.xml"),
    timeoutMs: 30,
    deps: { extractOffice: () => new Promise(() => {}) }, // 永不 settle
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "timeout");
  assert.ok(Date.now() - started < 3000, "必须按时返回");
});

test("解析器报错：折成 error，不抛", async () => {
  const r = await extractAttachment({
    buffer: fakeZip("xl/workbook.xml"),
    deps: { extractOffice: async () => { throw new Error("bad zip"); } },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "error");
  assert.match(r.reason, /bad zip/);
});

test("真的落到没有 node_modules 的目录：报 no_extractor，不崩", async () => {
  // 这一条守的是 sidecar 形态的承诺（"只拷 Node 标准库文件"）。不是打桩，
  // 是把 extract.js 单独拷到 /tmp 下再用真 import 跑——那里向上没有任何
  // node_modules，解析器必然解析不到。打桩证明不了这件事。
  const dir = mkdtempSync(path.join(tmpdir(), "kf-no-deps-"));
  try {
    const src = path.resolve("server/archive/kf/extract.js");
    const dst = path.join(dir, "extract.js");
    writeFileSync(dst, readFileSync(src));
    const mod = await import(`file://${dst}`);
    const r = await mod.extractAttachment({ buffer: fakeZip("xl/workbook.xml") });
    assert.equal(r.ok, false);
    assert.equal(r.code, "no_extractor", "缺依赖必须是 no_extractor，而不是抛异常");
    // 同时验证纯文本档仍然可用——sidecar 里这一档不该被拖下水。
    const txt = await mod.extractAttachment({ buffer: Buffer.from("纯文本仍可读") });
    assert.equal(txt.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── ③ 落库：正文与状态分开 ────────────────────────────────────────────────

test("附件正文读写幂等；重复写不新增行", () => {
  const db = freshDb();
  store.putKfAttachmentText(db, { messageId: "m1", kind: "xlsx", text: "甲", chars: 1 });
  store.putKfAttachmentText(db, { messageId: "m1", kind: "xlsx", text: "乙", chars: 1 });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM kf_attachment_text").get().n, 1);
  assert.equal(store.getKfAttachmentText(db, "m1").text, "乙");
});

test("完成率分母为 0 时返回 null，不返回 1", () => {
  const db = freshDb();
  assert.equal(store.kfExtractionCompletion(db).ratio, null);
});

test("待抽队列排除已失败的行", () => {
  const db = freshDb();
  const ok = seedMediaMessage(db, { msgId: "m1" });
  const bad = seedMediaMessage(db, { msgId: "m2" });
  for (const id of [ok, bad]) {
    store.markKfMedia(db, { id, state: "done", bytes: 10, path: `/tmp/${id}` });
  }
  store.markKfExtract(db, { id: bad, state: "failed", error: "坏文件" });

  const pending = store.pendingKfExtractions(db).map((r) => r.messageId);
  assert.deepEqual(pending, [ok], "失败行不得反复重抽");
});

// ── ④ 接进拉取轮次：抽取失败不动下载状态 ──────────────────────────────────

test("落盘后同轮抽取：文本落库，下载状态仍是 done", async () => {
  const dir = tempDir();
  try {
    const db = freshDb();
    const id = seedMediaMessage(db);
    const client = { getMedia: async () => ({ buffer: Buffer.from("含税单价 12.5\n总数 40\n") }) };

    const report = await pullKfMedia(db, client, { writer: fileWriter(dir) });
    assert.equal(report.done, 1);
    assert.equal(report.extracted, 1, JSON.stringify(report.extractErrors));

    const stored = store.getKfAttachmentText(db, id);
    assert.ok(stored, "正文应落库");
    assert.match(stored.text, /含税单价/);
    assert.equal(stored.kind, "txt");

    const row = db.prepare("SELECT state, extract_state FROM kf_media WHERE id=?").get(id);
    assert.equal(row.state, "done");
    assert.equal(row.extract_state, "done");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("抽取失败（判不出类型）：下载状态不动，且下一轮不重下", async () => {
  const dir = tempDir();
  try {
    const db = freshDb();
    const id = seedMediaMessage(db);
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
    let downloads = 0;
    const client = {
      getMedia: async () => {
        downloads += 1;
        return { buffer: binary };
      },
    };

    const first = await pullKfMedia(db, client, { writer: fileWriter(dir) });
    assert.equal(first.done, 1);
    assert.equal(first.extractFailed, 1);

    const row = db.prepare("SELECT state, extract_state, extract_error FROM kf_media WHERE id=?").get(id);
    assert.equal(row.state, "done", "抽取失败绝不能把下载状态打回去");
    assert.equal(row.extract_state, "unknown_kind");
    assert.ok(row.extract_error);

    const second = await pullKfMedia(db, client, { writer: fileWriter(dir) });
    assert.equal(second.attempted, 0, "不得重下已落盘的附件");
    assert.equal(downloads, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("缺解析器时整轮不崩，其余附件照常入库", async () => {
  const dir = tempDir();
  try {
    const db = freshDb();
    const idA = seedMediaMessage(db, { msgId: "a" });
    const idB = seedMediaMessage(db, { msgId: "b" });
    const client = {
      getMedia: async ({ mediaId }) => ({
        buffer: mediaId === "MID-a" ? Buffer.from("第一份附件正文") : Buffer.from([0, 1, 2, 3, 4, 5, 6]),
      }),
    };
    const report = await pullKfMedia(db, client, { writer: fileWriter(dir) });
    assert.equal(report.done, 2, "两份都要下载成功");
    assert.equal(report.extracted, 1, "文本那份抽成功");
    assert.ok(store.getKfAttachmentText(db, idA));
    assert.equal(db.prepare("SELECT extract_state FROM kf_media WHERE id=?").get(idB).extract_state, "unknown_kind");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── ⑤ 回填（升级后用）────────────────────────────────────────────────────

test("回填：补抽存量，不下载；重复回填不重复抽", async () => {
  const dir = tempDir();
  try {
    const db = freshDb();
    const id = seedMediaMessage(db);
    const file = path.join(dir, "att.bin");
    writeFileSync(file, "存量附件：合同编号 A-1024\n");
    store.markKfMedia(db, { id, state: "done", bytes: 20, path: file });

    const first = await runKfExtractionBackfill(db);
    assert.equal(first.attempted, 1);
    assert.equal(first.extracted, 1, JSON.stringify(first.errors));
    assert.match(store.getKfAttachmentText(db, id).text, /A-1024/);

    const second = await runKfExtractionBackfill(db);
    assert.equal(second.attempted, 0, "已抽成功的不再重抽");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("回填遇到文件已丢失：记 skipped，不判抽取失败", async () => {
  const db = freshDb();
  const id = seedMediaMessage(db);
  store.markKfMedia(db, { id, state: "done", bytes: 10, path: "/nonexistent/附件.bin" });
  const report = await runKfExtractionBackfill(db);
  assert.equal(report.skipped, 1);
  assert.equal(report.failed, 0, "文件丢了是下载侧的事，不是抽取失败");
});

// ── ⑥ agent 输入：不再是空消息 ───────────────────────────────────────────

test("客户发来的表格进入 agent 输入时带正文", () => {
  const db = freshDb();
  const id = seedMediaMessage(db);
  store.putKfAttachmentText(db, { messageId: id, kind: "xlsx", text: "含税单价 12.5", chars: 9 });

  const { messages } = kfAgentInput(db, { conversationId: CONV });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].attachment.status, "extracted");
  assert.equal(messages[0].attachment.kind, "xlsx");
  assert.equal(messages[0].attachment.text, "含税单价 12.5");
});

test("附件正文按单条上限进 agent，超出标已截断", () => {
  const db = freshDb();
  const id = seedMediaMessage(db);
  const long = "行".repeat(100);
  store.putKfAttachmentText(db, { messageId: id, kind: "xlsx", text: long, chars: long.length });

  const { messages } = kfAgentInput(db, { conversationId: CONV, attachmentMaxChars: 10 });
  assert.equal(messages[0].attachment.text.length, 10);
  assert.equal(messages[0].attachment.truncated, true);
  assert.equal(messages[0].attachment.chars, 100, "仍然告诉调用方原文有多长");
});

test("附件没抽出来：带状态而不是伪装成空正文", () => {
  const db = freshDb();
  const id = seedMediaMessage(db);
  store.markKfMedia(db, { id, state: "done", bytes: 10, path: "/tmp/x" });
  store.markKfExtract(db, { id, state: "no_extractor", error: "没有可用的解析器" });

  const { messages } = kfAgentInput(db, { conversationId: CONV });
  assert.equal(messages[0].attachment.status, "no_extractor");
  assert.equal(messages[0].attachment.text, undefined);
  assert.match(messages[0].attachment.reason, /解析器/);
});

// ── ⑦ 检索：附件正文也能搜到 ─────────────────────────────────────────────

test("检索命中附件正文，并标出命中在附件", () => {
  const db = freshDb();
  const id = seedMediaMessage(db);
  store.putKfAttachmentText(db, {
    messageId: id,
    kind: "xlsx",
    text: "产品|含税单价\nA|12.5",
    chars: 20,
  });

  const hits = store.searchKfMessages(db, { query: "含税单价", origins: ["peer"] });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].matchedIn, "attachment", "正文是空的，命中一定在附件里");
});

test("正文命中不误标成附件命中", () => {
  const db = freshDb();
  store.insertKfMessage(db, {
    id: `${CONV}:t1`,
    conversationId: CONV,
    msgId: "t1",
    openKfId: "kf1",
    externalUserId: "u1",
    sentAt: NOW,
    origin: "peer",
    msgType: "text",
    text: "请问含税单价多少",
    ingestedAt: NOW,
  });
  const hits = store.searchKfMessages(db, { query: "含税单价", origins: ["peer"] });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].matchedIn, undefined);
});

// ── ⑧ 只读面：/attachment 纯查库 ─────────────────────────────────────────

let express = null;
try {
  express = (await import("express")).default;
} catch {
  express = null;
}

if (!express) {
  test("跳过：express 不可解析（/attachment 读面）", { skip: true }, () => {});
} else {
  const http = await import("node:http");
  const { createKfRoutes } = await import("../server/archive/kf/routes.js");

  const db = new DatabaseSync(":memory:");
  store.ensureKfSchema(db);
  store.upsertKfConversation(db, { conversationId: CONV, openKfId: "kf1", externalUserId: "u1" });
  const withText = seedMediaMessage(db, { msgId: "r1" });
  store.putKfAttachmentText(db, { messageId: withText, kind: "xlsx", text: "季度营收 860", chars: 8 });
  const notExtracted = seedMediaMessage(db, { msgId: "r2" });
  store.markKfMedia(db, { id: notExtracted, state: "done", bytes: 5, path: "/tmp/r2" });
  store.markKfExtract(db, { id: notExtracted, state: "no_extractor", error: "没有可用的解析器" });

  const app = express();
  createKfRoutes(app, { getKfDb: () => db });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (p) => {
    const res = await fetch(base + p);
    return { status: res.status, body: await res.json() };
  };
  test.after?.(() => server.close());

  test("/attachment 返回已抽取的正文", async () => {
    const r = await get(`/api/archive/kf/attachment?messageId=${encodeURIComponent(withText)}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.kind, "xlsx");
    assert.match(r.body.text, /季度营收/);
  });

  test("/attachment 对未抽取的附件说明原因，而不是回空串", async () => {
    const r = await get(`/api/archive/kf/attachment?messageId=${encodeURIComponent(notExtracted)}`);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.state, "no_extractor");
    assert.match(r.body.reason, /解析器/);
    assert.equal(r.body.text, undefined, "不能给空串让调用方误读");
  });

  test("/attachment 对没有附件的消息返回 404", async () => {
    const r = await get("/api/archive/kf/attachment?messageId=kf1%7Cu1%3Anope");
    assert.equal(r.status, 404);
    assert.match(r.body.error, /没有附件/);
  });

  test("/attachment 缺 messageId 返回 400", async () => {
    const r = await get("/api/archive/kf/attachment");
    assert.equal(r.status, 400);
  });

  test("extractAndRecord 遇到库错误也不抛（拉取轮次不能被带崩）", async () => {
    const broken = {
      prepare() {
        throw new Error("database is locked");
      },
    };
    const res = await extractAndRecord(broken, { messageId: "x", buffer: Buffer.from("hi") });
    assert.equal(res.ok, false);
    assert.equal(res.code, "error");
  });
}

// 上限常量本身也要钉住：它决定"一次 agent 输入最多被一份附件吃掉多少"。
test("单条附带正文上限是 4000 字符", async () => {
  const { AGENT_ATTACHMENT_MAX_CHARS } = await import("../server/archive/kf/ingest.js");
  assert.equal(AGENT_ATTACHMENT_MAX_CHARS, 4000);
  assert.ok(EXTRACT_MAX_CHARS > AGENT_ATTACHMENT_MAX_CHARS, "库里的上限应高于单条进 agent 的上限");
  assert.equal(typeof HOUR, "number");
});
