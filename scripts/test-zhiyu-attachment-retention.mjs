// Attachment byte retention (openspec: zhiyu-room-attachments-and-voice, 1.5).
//   node --test scripts/test-zhiyu-attachment-retention.mjs
//
// The design decision this pins (design D11): retention acts on BYTES, never on
// rows. A room has no delete-a-message action, so "row gone ⇒ bytes gone" is
// not implementable — and deleting the row would break the invariant that
// dialogue rows are never auto-deleted.

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, writeFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createZhiyuStore } from "../gateway/zhiyu/store.js";
import { createAttachmentStore } from "../gateway/zhiyu/attachments.js";

async function boot() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zy-ret-"));
  const store = createZhiyuStore({ file: path.join(dir, "zhiyu.db") });
  const root = path.join(dir, "att");
  const lane = createAttachmentStore({ store, root, env: {} });
  const room = store.roomCreate({ title: "r", ownerEmail: "a@b.c" });
  const row = store.messageAppend({ roomId: room.id, kind: "human", content: "发了 f.md" }).row;
  const got = await lane.accept({
    roomId: room.id, rowSeq: row.seq, ownerMemberId: null, name: "f.md", mime: "text/markdown", buffer: Buffer.from("payload"),
  });
  const att = await lane.settleText(got.attachment, got.buffer, { name: "f.md" });
  store.messagePatchMeta(room.id, row.seq, { attachment: { id: att.id, name: att.name, bytes: att.bytes, status: att.status } });
  return { store, lane, root, room, row, att };
}

test("an active room is never touched, even with a zero threshold", async () => {
  const { store, lane, att } = await boot();
  const out = await lane.retentionSweep({ olderThanMs: -60_000 });
  assert.equal(out.purged, 0);
  assert.equal(store.attachmentGet(att.id).purged, false);
});

test("ended room: bytes reclaimed, row kept, content honestly unavailable", async () => {
  const { store, lane, room, row, att } = await boot();
  store.roomSetStatus(room.id, "ended");

  const out = await lane.retentionSweep({ olderThanMs: -60_000 });
  assert.equal(out.purged, 1, "one attachment's bytes reclaimed");

  const after = store.attachmentGet(att.id);
  assert.equal(after.purged, true, "the row survives so the card can say 已过期");
  assert.equal(after.name, "f.md", "metadata survives the purge");

  // The message row is untouched: dialogue is never auto-deleted.
  assert.equal(store.messageAt(room.id, row.seq)?.content, "发了 f.md");
  assert.equal(store.messageAt(room.id, row.seq)?.meta?.attachment?.id, att.id);

  // The text is gone with the bytes, and reads do not pretend otherwise.
  assert.equal(store.attachmentText(att.id), null);
  assert.equal(await lane.readBytes(after), null, "unreadable, not a silent empty file");
});

test("the sweep is idempotent and reports zero the second time", async () => {
  const { store, lane, room } = await boot();
  store.roomSetStatus(room.id, "ended");
  const first = await lane.retentionSweep({ olderThanMs: -60_000 });
  assert.equal(first.purged, 1);
  const second = await lane.retentionSweep({ olderThanMs: -60_000 });
  assert.equal(second.purged, 0, "a second pass purges nothing");
  assert.equal(second.orphans, 0);
});

test("orphan bytes with no row are reclaimed and counted", async () => {
  const { lane, root } = await boot();
  const orphan = path.join(root, "feedface", "att_ghost");
  await mkdir(orphan, { recursive: true });
  await writeFile(path.join(orphan, "original"), "junk");
  const out = await lane.retentionSweep({ olderThanMs: -60_000 });
  assert.equal(out.orphans, 1);
  const left = await readdir(path.join(root, "feedface")).catch(() => []);
  assert.deepEqual(left, [], "the orphan directory is gone");
});

test("a purged attachment stops counting against the room quota", async () => {
  const { store, lane, room, att } = await boot();
  assert.equal(store.attachmentRoomBytes(room.id), att.bytes);
  await lane.purge(att);
  assert.equal(store.attachmentRoomBytes(room.id), 0);
});

test("purging twice is a no-op", async () => {
  const { store, lane, att } = await boot();
  assert.equal(await lane.purge(att), true);
  assert.equal(await lane.purge(store.attachmentGet(att.id)), false, "an already-purged attachment reports false");
});

test("a location escaping the root is never deleted through", async () => {
  const { store, lane, root, room } = await boot();
  store.roomSetStatus(room.id, "ended");
  // Simulate a hand-edited row pointing outside the storage root.
  const victim = path.join(root, "..", "outside-victim");
  await mkdir(victim, { recursive: true });
  await writeFile(path.join(victim, "keep"), "must survive");
  const aid = store.attachmentAdd({
    id: "att_escape", roomId: room.id, rowSeq: 999, name: "x", mime: "text/plain", bytes: 1,
    location: path.join("..", "outside-victim"),
  });
  // Negative threshold = "everything is due", so the case does not depend on
  // the insert and the sweep landing in different milliseconds.
  await lane.retentionSweep({ olderThanMs: -60_000 });
  await access(path.join(victim, "keep")).then(
    () => assert.ok(true, "outside the root survives"),
    () => assert.fail("retention deleted a file outside its root"),
  );
  assert.equal(store.attachmentGet(aid.id).purged, true);
});
