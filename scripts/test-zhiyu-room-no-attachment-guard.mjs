// No-attachment regression guard (openspec: zhiyu-room-attachments-and-voice,
// task 7.4).   node --test scripts/test-zhiyu-room-no-attachment-guard.mjs
//
// The change's whole safety claim in one assertion: a room with no attachments
// behaves EXACTLY as it did before. Two ways that could quietly break:
//   1. the prompt assembler starts emitting an empty "附件：" section, or an
//      extra blank line, for every room (cost: every seat's tokens, forever)
//   2. a client starts requiring an attachment-capable response shape
//
// (2) is covered by the three clients' own suites; this file pins (1) at the
// only place it could be introduced.

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createZhiyuStore } from "../gateway/zhiyu/store.js";
import { createAttachmentStore, buildAttachmentBlock } from "../gateway/zhiyu/attachments.js";

test("a room with no attachments produces no attachment block at all", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zy-guard-"));
  const store = createZhiyuStore({ file: path.join(dir, "zhiyu.db") });
  const lane = createAttachmentStore({ store, root: path.join(dir, "att"), env: {} });
  const room = store.roomCreate({ title: "plain", ownerEmail: "a@b.c" });
  store.messageAppend({ roomId: room.id, kind: "human", content: "just talking" });
  store.messageAppend({ roomId: room.id, kind: "agent", content: "and answering" });

  const rows = store.messagesAfter(room.id, 0, { limit: 50 });
  const block = buildAttachmentBlock({ rows, store, limits: lane.limits });
  // Not merely falsy — the literal empty string, so a caller's `${base}${block}`
  // cannot grow so much as a newline.
  assert.equal(block, "", "byte-identical: no section, no separator");
});

test("system and agent rows never contribute an attachment block", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zy-guard2-"));
  const store = createZhiyuStore({ file: path.join(dir, "zhiyu.db") });
  const lane = createAttachmentStore({ store, root: path.join(dir, "att"), env: {} });
  const room = store.roomCreate({ title: "sys", ownerEmail: "a@b.c" });
  // A meta that merely LOOKS attachment-adjacent must not be picked up: only
  // human rows carrying meta.attachment.id count.
  store.messageAppend({ roomId: room.id, kind: "event", content: "", meta: { event: "attachment_ready", name: "x.md" } });
  store.messageAppend({ roomId: room.id, kind: "agent", content: "text", meta: { attachment: { id: "att_ghost" } } });

  const rows = store.messagesAfter(room.id, 0, { limit: 50 });
  assert.equal(buildAttachmentBlock({ rows, store, limits: lane.limits }), "");
});

test("the router seam being absent keeps today's prompt", async () => {
  // createRoomRouter's `attachmentBlock` default is null; the seam is only
  // consulted when wired. Assert the default is opt-in, since a truthy default
  // would have changed every existing room's prompt.
  const src = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../gateway/zhiyu/room-router.js", import.meta.url), "utf8"));
  assert.match(src, /attachmentBlock = null,/, "the seam defaults to null (opt-in)");
  assert.match(src, /attachmentBlock \? safeAttachmentBlock\(rows\) : ""/, "absent seam ⇒ empty string, not a bare block");
});
