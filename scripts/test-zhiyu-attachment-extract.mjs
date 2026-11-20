// Attachment lane — extraction queue & terminal states
// (openspec: zhiyu-room-attachments-and-voice, tasks 2.2 / 2.3).
//   node --test scripts/test-zhiyu-attachment-extract.mjs
//
// The claim under test: three terminal states, never confused, and extraction
// runs through a BOUNDED queue so one big file cannot stall every room.

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createZhiyuStore } from "../gateway/zhiyu/store.js";
import { createAttachmentStore, attachmentLimits } from "../gateway/zhiyu/attachments.js";

async function boot(env = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zy-x-"));
  const store = createZhiyuStore({ file: path.join(dir, "zhiyu.db") });
  const lane = createAttachmentStore({ store, root: path.join(dir, "att"), env: { ...env } });
  const room = store.roomCreate({ title: "x", ownerEmail: "a@b.c" });
  const row = () => store.messageAppend({ roomId: room.id, kind: "human", content: "f" }).row;
  return { store, lane, room, row };
}

test("readable type → ready with text", async () => {
  const { store, lane, room, row } = await boot();
  const r = row();
  const got = await lane.accept({ roomId: room.id, rowSeq: r.seq, name: "a.md", mime: "text/markdown", buffer: Buffer.from("# t\n\nbody") });
  const s = await lane.settleText(got.attachment, got.buffer, { name: "a.md" });
  assert.equal(s.status, "ready");
  assert.equal(s.hasText, true);
  assert.ok(store.attachmentText(s.id).includes("body"));
});

test("type with no reader → opaque, and it is NOT reported as a failure", async () => {
  const { lane, room, row } = await boot();
  const r = row();
  const got = await lane.accept({ roomId: room.id, rowSeq: r.seq, name: "photo.png", mime: "image/png", buffer: Buffer.from([0x89, 0x50]) });
  const s = await lane.settleText(got.attachment, got.buffer, { name: "photo.png" });
  assert.equal(s.status, "opaque");
  assert.equal(s.error, null, "opaque carries no error — it is the type boundary, not a fault");
  assert.equal(s.hasText, false);
});

test("broken file of a readable type → failed, with a reason, bytes kept", async () => {
  const { lane, room, row } = await boot();
  const r = row();
  const got = await lane.accept({ roomId: room.id, rowSeq: r.seq, name: "broken.docx", mime: "application/vnd.openxmlformats", buffer: Buffer.from("not a zip at all") });
  const s = await lane.settleText(got.attachment, got.buffer, { name: "broken.docx" });
  assert.equal(s.status, "failed");
  assert.ok(s.error, "a failure names its reason");
  assert.equal(s.purged, false, "the bytes stay downloadable");
  assert.ok(await lane.readBytes(s), "readable even though extraction failed");
});

test("over-size text file takes the opaque exit instead of parsing", async () => {
  const { lane, room, row } = await boot({ ZHIYU_ATTACHMENT_DOC_MAX_BYTES: "8" });
  const r = row();
  const big = Buffer.from("x".repeat(64));
  const got = await lane.accept({ roomId: room.id, rowSeq: r.seq, name: "big.md", mime: "text/markdown", buffer: big });
  const s = await lane.settleText(got.attachment, got.buffer, { name: "big.md" });
  assert.equal(s.status, "opaque");
  assert.equal(s.error, "too_large_to_extract");
});

test("extraction concurrency never exceeds the configured ceiling", async () => {
  // A controllable source lets us observe how many jobs are in flight at once.
  const { lane } = await boot({ ZHIYU_ATTACHMENT_EXTRACT_CONCURRENCY: "2" });
  assert.equal(lane.limits.extractConcurrency, 2);

  let live = 0;
  let peak = 0;
  const job = () =>
    lane.enqueue(async () => {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live -= 1;
    });
  for (let i = 0; i < 12; i += 1) job();
  // Let the queue drain.
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(peak <= 2, `peak concurrency was ${peak}, ceiling is 2`);
  assert.ok(peak >= 1, "jobs actually ran");
});

test("defaults are shipped and env overrides them; junk falls back", () => {
  const d = attachmentLimits({});
  assert.equal(d.docMaxBytes, 20 * 1024 * 1024);
  assert.equal(d.audioMaxBytes, 25 * 1024 * 1024);
  assert.equal(d.inlineMaxChars, 6000);
  assert.equal(d.extractConcurrency, 2);

  const o = attachmentLimits({ ZHIYU_ATTACHMENT_INLINE_MAX_CHARS: "1234", ZHIYU_ATTACHMENT_EXTRACT_CONCURRENCY: "5" });
  assert.equal(o.inlineMaxChars, 1234);
  assert.equal(o.extractConcurrency, 5);

  // A bad value degrades to the default rather than becoming NaN/0 (which
  // would block every upload or every extraction).
  const bad = attachmentLimits({ ZHIYU_ATTACHMENT_DOC_MAX_BYTES: "not-a-number", ZHIYU_ATTACHMENT_EXTRACT_CONCURRENCY: "-3" });
  assert.equal(bad.docMaxBytes, 20 * 1024 * 1024);
  assert.equal(bad.extractConcurrency, 2);
});
