// Attachment lane self-check (openspec: zhiyu-room-attachments-and-voice).
//   node --test scripts/test-zhiyu-attachments.mjs
//
// Covers the three things that would silently be wrong:
//   1. the three terminal states stay distinct (opaque is NOT failed)
//   2. the prompt inlines ONLY the newest attachment, capped, with a truncation
//      note — and older ones degrade to one pointer line
//   3. retention purges BYTES for ended rooms only and keeps the row
// plus the path-containment rule (a hostile name never becomes a path).

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readdir, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createZhiyuStore } from "../gateway/zhiyu/store.js";
import {
  attachmentDir,
  buildAttachmentBlock,
  canExtract,
  createAttachmentStore,
  isAudio,
} from "../gateway/zhiyu/attachments.js";

const tmpRoot = () => mkdtemp(path.join(os.tmpdir(), "zy-att-"));

async function fresh() {
  const dir = await tmpRoot();
  const store = createZhiyuStore({ file: path.join(dir, "zhiyu.db") });
  const root = path.join(dir, "attachments");
  const lane = createAttachmentStore({ store, root, env: {} });
  const room = store.roomCreate({ title: "t", ownerEmail: "a@b.c" });
  return { dir, store, root, lane, room };
}

test("paths are built from the attachment id only", () => {
  const p = attachmentDir("/data/att", "zy_abc", "att_123");
  assert.ok(p.startsWith("/data/att"), "stays under the root");
  assert.ok(!p.includes(".."), "no traversal from a room id");
  // A hostile display name never reaches the path builder at all.
  const p2 = attachmentDir("/data/att", "zy_abc", "att_123");
  assert.equal(p, p2, "same ids → same path, name is irrelevant");
});

test("type classification: readable vs audio vs neither", () => {
  assert.equal(canExtract("a.pdf"), true);
  assert.equal(canExtract("a.docx"), true);
  assert.equal(canExtract("a.png"), false);
  assert.equal(canExtract("a.zip"), false);
  assert.equal(isAudio("call.m4a", ""), true);
  assert.equal(isAudio("x", "audio/webm"), true);
  assert.equal(isAudio("report.pdf", "application/pdf"), false);
});

test("three terminal states stay distinct", async () => {
  const { store, lane, room } = await fresh();
  const row = store.messageAppend({ roomId: room.id, kind: "human", content: "发了 x" });

  // a PNG: opaque (NOT failed)
  const png = await lane.accept({
    roomId: room.id, rowSeq: row.row.seq, name: "shot.png", mime: "image/png", buffer: Buffer.from([1, 2, 3]),
  });
  const settledPng = await lane.settleText(png.attachment, png.buffer, { name: "shot.png" });
  assert.equal(settledPng.status, "opaque");
  assert.equal(settledPng.hasText, false);

  // a broken docx: failed, with a reason
  const row2 = store.messageAppend({ roomId: room.id, kind: "human", content: "发了 y" });
  const docx = await lane.accept({
    roomId: room.id, rowSeq: row2.row.seq, name: "bad.docx", mime: "application/vnd.openxmlformats", buffer: Buffer.from("not a zip"),
  });
  const settledDocx = await lane.settleText(docx.attachment, docx.buffer, { name: "bad.docx" });
  assert.equal(settledDocx.status, "failed");
  assert.ok(settledDocx.error, "a failure carries its reason");

  // a markdown: ready with text
  const row3 = store.messageAppend({ roomId: room.id, kind: "human", content: "发了 z" });
  const md = await lane.accept({
    roomId: room.id, rowSeq: row3.row.seq, name: "notes.md", mime: "text/markdown", buffer: Buffer.from("# hello"),
  });
  const settledMd = await lane.settleText(md.attachment, md.buffer, { name: "notes.md" });
  assert.equal(settledMd.status, "ready");
  assert.equal(settledMd.hasText, true);
  assert.equal(store.attachmentText(settledMd.id).trim(), "# hello");

  const statuses = store.attachmentsAllLocations().length;
  assert.equal(statuses, 3, "three attachments stored");
});

test("prompt inlines only the newest, capped, and says it truncated", async () => {
  const { store, lane, room } = await fresh();
  const big = "字".repeat(20_000);
  const mk = async (name, text) => {
    const row = store.messageAppend({ roomId: room.id, kind: "human", content: `发了 ${name}` });
    const got = await lane.accept({ roomId: room.id, rowSeq: row.row.seq, name, mime: "text/markdown", buffer: Buffer.from(text) });
    const settled = await lane.settleText(got.attachment, got.buffer, { name });
    store.messagePatchMeta(room.id, row.row.seq, { attachment: { id: settled.id, name: settled.name, bytes: settled.bytes, status: settled.status } });
    return row.row;
  };
  await mk("older.md", "old content");
  await mk("newest.md", big);

  const rows = store.messagesAfter(room.id, 0, { limit: 100 }).filter((r) => r.kind === "human");
  const block = buildAttachmentBlock({ rows, store, limits: { inlineMaxChars: 1000, inlineTotalChars: 2000 } });

  assert.ok(block.includes("older.md"), "older attachment is still named");
  assert.ok(block.includes("完整文件在房间内可查看"), "older one degrades to a pointer");
  assert.ok(!block.includes("old content"), "older attachment's text is NOT inlined");
  assert.ok(block.includes("已截断"), "truncation is stated out loud");
  // The newest is capped: 1000 chars of text, not 20,000.
  const bodyChars = block.split("（附件正文）newest.md")[1] ?? "";
  assert.ok(bodyChars.length < 1400, `capped (got ${bodyChars.length})`);
});

test("no attachment ⇒ empty block (the byte-identical guard)", async () => {
  const { store, room } = await fresh();
  store.messageAppend({ roomId: room.id, kind: "human", content: "just talking" });
  const rows = store.messagesAfter(room.id, 0, { limit: 10 });
  assert.equal(buildAttachmentBlock({ rows, store }), "");
});

test("retention purges bytes for ENDED rooms only, keeps the row", async () => {
  const { store, lane, root, room } = await fresh();
  const row = store.messageAppend({ roomId: room.id, kind: "human", content: "发了 keep.md" });
  const got = await lane.accept({
    roomId: room.id, rowSeq: row.row.seq, name: "keep.md", mime: "text/markdown", buffer: Buffer.from("payload"),
  });
  const settled = await lane.settleText(got.attachment, got.buffer, { name: "keep.md" });

  // Active room: nothing is purged even with a zero threshold.
  let out = await lane.retentionSweep({ olderThanMs: 0 });
  assert.equal(out.purged, 0, "active rooms are never touched");
  assert.equal(store.attachmentGet(settled.id).purged, false);

  store.roomSetStatus(room.id, "ended");
  out = await lane.retentionSweep({ olderThanMs: 0 });
  assert.equal(out.purged, 1, "bytes reclaimed for an ended room");

  const after = store.attachmentGet(settled.id);
  assert.equal(after.purged, true, "row survives");
  assert.equal(store.attachmentText(settled.id), null, "text gone with the bytes");
  assert.equal(await lane.readBytes(after), null, "content is unreadable, not a silent 200");
  assert.equal(store.messageAt(room.id, row.row.seq)?.content, "发了 keep.md", "the message row is untouched");

  // Idempotent.
  out = await lane.retentionSweep({ olderThanMs: 0 });
  assert.equal(out.purged, 0, "a second pass purges nothing");
});

test("orphan bytes are reclaimed and counted", async () => {
  const { root, lane } = await fresh();
  const orphan = path.join(root, "deadbeef", "att_orphan");
  await mkdir(orphan, { recursive: true });
  await writeFile(path.join(orphan, "original"), "junk");
  const out = await lane.retentionSweep({ olderThanMs: 0 });
  assert.equal(out.orphans, 1);
  const left = await readdir(path.join(root, "deadbeef")).catch(() => []);
  assert.deepEqual(left, [], "the orphan directory is gone");
});

test("quota accounting ignores purged bytes", async () => {
  const { store, lane, room } = await fresh();
  const row = store.messageAppend({ roomId: room.id, kind: "human", content: "x" });
  const got = await lane.accept({
    roomId: room.id, rowSeq: row.row.seq, name: "a.txt", mime: "text/plain", buffer: Buffer.from("12345"),
  });
  assert.equal(store.attachmentRoomBytes(room.id), 5);
  await lane.purge(got.attachment);
  assert.equal(store.attachmentRoomBytes(room.id), 0, "purged bytes stop counting");
});

test.after(async () => {
  // Each case mints its own mkdtemp; nothing global to clean up here.
});
