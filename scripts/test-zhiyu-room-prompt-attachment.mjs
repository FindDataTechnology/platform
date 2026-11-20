// Prompt-side bounded inline (openspec: zhiyu-room-attachments-and-voice,
// tasks 3.1 / 3.2 / 3.3).
//   node --test scripts/test-zhiyu-room-prompt-attachment.mjs
//
// The room prompt is a PRODUCT: 40 rows × every seated agent. The properties
// that keep that product from blowing up:
//   * only the NEWEST attachment's text is inlined
//   * it is capped, and truncation is stated out loud
//   * older attachments degrade to a one-line pointer, never their text
//   * a total ceiling degrades further attachments to pointers

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createZhiyuStore } from "../gateway/zhiyu/store.js";
import { buildAttachmentBlock, createAttachmentStore } from "../gateway/zhiyu/attachments.js";

async function boot() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zy-pp-"));
  const store = createZhiyuStore({ file: path.join(dir, "zhiyu.db") });
  const lane = createAttachmentStore({ store, root: path.join(dir, "att"), env: {} });
  const room = store.roomCreate({ title: "p", ownerEmail: "a@b.c" });
  const attach = async (name, text, status) => {
    const row = store.messageAppend({ roomId: room.id, kind: "human", content: `发了 ${name}` }).row;
    const got = await lane.accept({ roomId: room.id, rowSeq: row.seq, name, mime: "text/markdown", buffer: Buffer.from(text) });
    const settled = status === "extracting" ? got.attachment : await lane.settleText(got.attachment, got.buffer, { name });
    store.messagePatchMeta(room.id, row.seq, { attachment: { id: settled.id, name: settled.name, bytes: settled.bytes, status: settled.status } });
    return row;
  };
  const rows = () => store.messagesAfter(room.id, 0, { limit: 200 });
  return { store, lane, room, attach, rows };
}

test("only the newest attachment's text is inlined", async () => {
  const { store, attach, rows } = await boot();
  await attach("older.md", "OLDER-TEXT-MARKER");
  await attach("newest.md", "NEWEST-TEXT-MARKER");
  const block = buildAttachmentBlock({ rows: rows(), store, limits: { inlineMaxChars: 6000, inlineTotalChars: 12000 } });

  assert.match(block, /NEWEST-TEXT-MARKER/, "the newest body is present");
  assert.doesNotMatch(block, /OLDER-TEXT-MARKER/, "an older body is NOT inlined");
  assert.match(block, /older\.md/, "but the older file is still named");
  assert.match(block, /完整文件在房间内可查看/, "with a pointer to where to read it");
});

test("the newest body is capped and truncation is stated", async () => {
  const { store, attach, rows } = await boot();
  await attach("big.md", "字".repeat(20_000));
  const block = buildAttachmentBlock({ rows: rows(), store, limits: { inlineMaxChars: 500, inlineTotalChars: 12000 } });

  const body = block.split("（附件正文）big.md")[1] ?? "";
  assert.ok(body.length < 900, `capped to ~500 chars, got ${body.length}`);
  assert.match(block, /已截断/, "truncation is said out loud, not silent");
  assert.match(block, /共 20000 字/, "the true length is disclosed");
});

test("the total ceiling degrades further attachments to pointers", async () => {
  const { store, attach, rows } = await boot();
  // Three ready attachments; the newest is consumed against a small total
  // budget, so there is nothing left for the others.
  await attach("a.md", "A".repeat(100));
  await attach("b.md", "B".repeat(100));
  await attach("c.md", "C".repeat(100));
  const block = buildAttachmentBlock({ rows: rows(), store, limits: { inlineMaxChars: 1000, inlineTotalChars: 120 } });

  // Exactly one body should be inlined; the rest are pointers.
  const bodies = (block.match(/（附件正文）/g) ?? []).length;
  assert.equal(bodies, 1, `only one body fit the total ceiling (got ${bodies})`);
  const chars = block.length;
  assert.ok(chars < 120 + 400, `the block stays near the ceiling (got ${chars})`);
});

test("non-ready states appear as pointers with an honest reason", async () => {
  const { store, attach, rows } = await boot();
  await attach("shot.png", "binary", "opaque");
  const block = buildAttachmentBlock({ rows: rows(), store, limits: { inlineMaxChars: 6000, inlineTotalChars: 12000 } });
  assert.match(block, /shot\.png/);
  assert.match(block, /不能读取该类型/);
  assert.doesNotMatch(block, /（附件正文）/);
});

test("a purged attachment reads as expired, never as live", async () => {
  const { store, lane, room, attach, rows } = await boot();
  await attach("gone.md", "text");
  store.roomSetStatus(room.id, "ended");
  await lane.retentionSweep({ olderThanMs: -60_000 });
  const block = buildAttachmentBlock({ rows: rows(), store, limits: { inlineMaxChars: 6000, inlineTotalChars: 12000 } });
  assert.match(block, /gone\.md/);
  assert.match(block, /已过期/);
  assert.doesNotMatch(block, /（附件正文）/);
});

test("system/event rows never inject", async () => {
  const { store, room, rows } = await boot();
  // The ready trace row is an event, and it must contribute nothing.
  store.messageAppend({ roomId: room.id, kind: "event", content: "", meta: { event: "attachment_ready", attachmentId: "att_x", name: "x.md", chars: 10 } });
  const block = buildAttachmentBlock({ rows: rows(), store, limits: { inlineMaxChars: 6000, inlineTotalChars: 12000 } });
  assert.equal(block, "");
});
