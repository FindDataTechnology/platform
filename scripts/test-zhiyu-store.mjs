// Unit tests — zhiyu room store (add-zhiyu-room, task group 1).
// Run: node --test scripts/test-zhiyu-store.mjs
//
//   1.x  schema: migration is idempotent (double open, second boot must not
//        crash), member UNIQUE(room,kind,ref) enforced, message PK per room.
//   2.x  members: add/get/state flip; facade defaults on_duty, users active.
//   3.x  invites: idem_key replay returns the same row; a second distinct
//        invite for the same (room,kind,ref) returns the existing PENDING
//        row (one pending per target); resolve frees a re-invite.
//   4.x  messages: per-room seq monotonic and independent across rooms;
//        private window filtered by viewer; shared always visible.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createZhiyuStore } from "../gateway/zhiyu/store.js";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "zhiyu-store-"));
const FILE = path.join(TMP, "zhiyu.db");

function freshStore(file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "zhiyu-store-")), "z.db")) {
  return createZhiyuStore({ file });
}

test("1.1 migration idempotent: open twice on the same file", () => {
  const a = createZhiyuStore({ file: FILE });
  a.roomCreate({ title: "一号", ownerEmail: "a@x" });
  a.close();
  const b = createZhiyuStore({ file: FILE });
  const room = b.roomListFor("a@x")[0];
  assert.equal(room.title, "一号");
  b.close();
});

test("1.2 member UNIQUE(room,kind,ref): second add conflicts", () => {
  const s = freshStore();
  const room = s.roomCreate({ title: "", ownerEmail: "a@x" });
  s.memberAdd({ roomId: room.id, kind: "user", ref: "b@x" });
  assert.throws(
    () => s.memberAdd({ roomId: room.id, kind: "user", ref: "b@x" }),
    (err) => String(err.code).startsWith("SQLITE_CONSTRAINT"),
  );
  // same ref under a different kind is a different seat — allowed
  s.memberAdd({ roomId: room.id, kind: "agent", ref: "b@x" });
  s.close();
});

test("2.1 member presence defaults: user active, facade on_duty", () => {
  const s = freshStore();
  const room = s.roomCreate({ title: "", ownerEmail: "a@x" });
  const u = s.memberAdd({ roomId: room.id, kind: "user", ref: "c@x" });
  const f = s.memberAdd({ roomId: room.id, kind: "facade", ref: "pack:agent:c@x", onBehalfOf: "c@x" });
  assert.equal(u.presence, "active");
  assert.equal(f.presence, "on_duty");
  s.close();
});

test("2.2 member state flip stamps left_at; reactivate clears it", () => {
  const s = freshStore();
  const room = s.roomCreate({ title: "", ownerEmail: "a@x" });
  const m = s.memberAdd({ roomId: room.id, kind: "user", ref: "d@x" });
  const left = s.memberSetState(m.id, "left");
  assert.ok(left.joinedAt > 0);
  const rawLeft = s.memberFor(room.id, "user", "d@x");
  assert.equal(rawLeft.state, "left");
  s.close();
});

test("3.1 invite idem replay: same idem_key returns the same row", () => {
  const s = freshStore();
  const room = s.roomCreate({ title: "", ownerEmail: "a@x" });
  const first = s.inviteCreate({ roomId: room.id, kind: "user", ref: "e@x", idemKey: "K1", invitedBy: "a@x" });
  const replay = s.inviteCreate({ roomId: room.id, kind: "user", ref: "e@x", idemKey: "K1", invitedBy: "a@x" });
  assert.equal(replay.replay, true);
  assert.equal(replay.invite.id, first.invite.id);
  s.close();
});

test("3.2 one pending invite per (room,kind,ref) even with distinct idem keys", () => {
  const s = freshStore();
  const room = s.roomCreate({ title: "", ownerEmail: "a@x" });
  const first = s.inviteCreate({ roomId: room.id, kind: "user", ref: "f@x", idemKey: "K1", invitedBy: "a@x" });
  const second = s.inviteCreate({ roomId: room.id, kind: "user", ref: "f@x", idemKey: "K2", invitedBy: "a@x" });
  assert.equal(second.invite.id, first.invite.id);
  assert.equal(s.invitesForRoom(room.id).length, 1);
  s.close();
});

test("3.3 resolving an invite frees a re-invite", () => {
  const s = freshStore();
  const room = s.roomCreate({ title: "", ownerEmail: "a@x" });
  const first = s.inviteCreate({ roomId: room.id, kind: "user", ref: "g@x", idemKey: "K1", invitedBy: "a@x" });
  s.inviteResolve(first.invite.id, "declined");
  const again = s.inviteCreate({ roomId: room.id, kind: "user", ref: "g@x", idemKey: "K3", invitedBy: "a@x" });
  assert.equal(again.replay, false);
  assert.notEqual(again.invite.id, first.invite.id);
  assert.equal(s.invitesForRoom(room.id).length, 2);
  s.close();
});

test("3.4 resolve only moves pending rows (resolving twice is a no-op)", () => {
  const s = freshStore();
  const room = s.roomCreate({ title: "", ownerEmail: "a@x" });
  const inv = s.inviteCreate({ roomId: room.id, kind: "agent", ref: "pack:agent:h@x", idemKey: "K1", invitedBy: "a@x" });
  const accepted = s.inviteResolve(inv.invite.id, "accepted");
  assert.equal(accepted.state, "accepted");
  const settledAgain = s.inviteResolve(inv.invite.id, "declined");
  assert.equal(settledAgain.state, "accepted");
  s.close();
});

test("4.1 message seq is per-room monotonic and independent", () => {
  const s = freshStore();
  const r1 = s.roomCreate({ title: "", ownerEmail: "a@x" });
  const r2 = s.roomCreate({ title: "", ownerEmail: "a@x" });
  assert.equal(s.messageAppend({ roomId: r1.id, kind: "human", content: "一" }).seq, 1);
  assert.equal(s.messageAppend({ roomId: r1.id, kind: "human", content: "二" }).seq, 2);
  assert.equal(s.messageAppend({ roomId: r2.id, kind: "human", content: "甲" }).seq, 1);
  assert.equal(s.messageAppend({ roomId: r1.id, kind: "system", content: "" }).seq, 3);
  s.close();
});

test("4.2 private window visible only to its member; shared visible to all", () => {
  const s = freshStore();
  const room = s.roomCreate({ title: "", ownerEmail: "a@x" });
  const m1 = s.memberAdd({ roomId: room.id, kind: "user", ref: "i@x" });
  s.messageAppend({ roomId: room.id, kind: "human", senderMemberId: m1.id, content: "公域" });
  s.messageAppend({ roomId: room.id, kind: "agent", visibility: `private:${m1.id}`, content: "私窗" });
  const mine = s.messagesAfter(room.id, 0, { viewerMemberId: m1.id });
  assert.equal(mine.length, 2);
  const others = s.messagesAfter(room.id, 0, { viewerMemberId: "mem_nope" });
  assert.equal(others.length, 1);
  assert.equal(others[0].content, "公域");
  s.close();
});
