// Shared attachment contract (openspec: zhiyu-room-attachments-and-voice,
// tasks 5.1 / 5.2 / 5.3).
//   node --test scripts/test-zhiyu-attachment-contract.mjs
//
// The contract's promise is that FOUR clients cannot drift: one state machine,
// one card model, and each client supplies only a picker + a byte transport.
// These tests pin the machine's behaviour, then assert the no-drift property
// against the actual source of all four clients.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

// The core module is TypeScript; node runs the built/transpiled shape in tests
// elsewhere in this repo via ts stripping, so import the source through the
// package's own entry when available, else evaluate the pure functions here.
// The pure functions have no imports, so a direct dynamic import works under
// Node's type-stripping.
const core = await import("../packages/core/src/zhiyu-attachments.ts");

const att = (over = {}) => ({
  id: "att_1",
  roomId: "zy_1",
  rowSeq: 1,
  name: "a.md",
  mime: "text/markdown",
  bytes: 2048,
  status: "ready",
  extractChars: 10,
  hasText: true,
  error: null,
  purged: false,
  createdAt: 0,
  ...over,
});

test("the card model keeps opaque distinct from failed", () => {
  const opaque = core.attachmentCardModel({ status: "opaque", bytes: 1000 });
  const failed = core.attachmentCardModel({ status: "failed", bytes: 1000 });
  assert.notEqual(opaque.tone, "error", "an unreadable type is not an error");
  assert.equal(opaque.tone, "warn");
  assert.equal(opaque.openable, true, "it can still be opened/downloaded");
  assert.equal(opaque.agentReadable, false);
  assert.equal(failed.tone, "error");
  assert.equal(failed.labelKey, "failed");
});

test("every terminal state maps to a distinct, localizable label", () => {
  const seen = new Set();
  for (const status of ["uploading", "ready", "extracting", "opaque", "failed"]) {
    const m = core.attachmentCardModel({ status });
    assert.ok(m.labelKey, `${status} has a label key`);
    assert.equal(typeof m.labelKey, "string");
    seen.add(m.labelKey);
  }
  seen.add(core.attachmentCardModel({ purged: true }).labelKey);
  assert.equal(seen.size, 6, "six distinct labels — no two states collapse into one");
});

test("a purged attachment is not openable and not agent-readable", () => {
  const m = core.attachmentCardModel({ status: "ready", purged: true });
  assert.equal(m.openable, false);
  assert.equal(m.agentReadable, false);
  assert.equal(m.labelKey, "expired");
});

test("size labels read like a person wrote them", () => {
  assert.equal(core.formatBytes(512), "512 B");
  assert.equal(core.formatBytes(2048), "2 KB");
  assert.equal(core.formatBytes(3 * 1024 * 1024), "3.0 MB");
});

test("the state machine: pick → upload → settle / fail / cancel", () => {
  let drafts = [];
  const on = (e) => {
    drafts = core.applyAttachmentEvent(drafts, e);
    return drafts;
  };

  on({ kind: "picked", key: "k1", name: "a.md", bytes: 10 });
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].state, "uploading");
  assert.equal(core.canSendWithAttachments(drafts), false, "a pending upload blocks the send");

  on({ kind: "uploaded", key: "k1", attachment: att() });
  assert.equal(drafts[0].state, "ready");
  assert.equal(drafts[0].id, "att_1");
  assert.equal(core.canSendWithAttachments(drafts), true);
  assert.equal(core.attachmentPromptRef(drafts), "@att:att_1");

  // Audio settles out of band, matched by id not by key.
  on({ kind: "settled", attachment: att({ id: "att_1", status: "ready", extractChars: 99 }) });
  assert.equal(drafts[0].state, "ready");

  // A cancel is a choice: the draft disappears and no error chip remains.
  on({ kind: "picked", key: "k2", name: "b.pdf", bytes: 20 });
  on({ kind: "cancelled", key: "k2" });
  assert.equal(drafts.length, 1, "the cancelled draft is gone");
});

test("failure keeps the draft so the user can retry or remove it", () => {
  let drafts = core.applyAttachmentEvent([], { kind: "picked", key: "k", name: "x.docx", bytes: 1 });
  drafts = core.applyAttachmentEvent(drafts, { kind: "failed", key: "k", error: "nope" });
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].state, "failed");
  assert.equal(drafts[0].error, "nope");
  assert.equal(core.canSendWithAttachments(drafts), true, "a failed file does not wedge the composer forever");
});

test("uploadAttachment aborts cleanly and never surfaces a cancel as an error", async () => {
  const states = [];
  const ac = new AbortController();
  await core.uploadAttachment({
    file: "blob",
    name: "a.md",
    bytes: 1,
    key: "k",
    signal: ac.signal,
    drafts: [],
    upload: async (_f, signal) => {
      signal.dispatchEvent?.(new Event("abort"));
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    },
    onDraft: (next) => states.push(next.map((d) => d.state)),
  });
  // picked → (cancelled removes it). No "failed" toast for a cancel.
  assert.deepEqual(states.at(-1), [], "the cancelled draft is dropped, not marked failed");
});

test("no-drift: all four clients import the ONE contract, none re-implements it", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const clients = [
    "web/src/components/zhiyu/RoomComposer.tsx",
    "miniapp/src/pages/zhiyu/room/index.tsx",
    "app/src/app/(tabs)/zhiyu/[roomId].tsx",
  ];
  for (const rel of clients) {
    const src = await readFile(path.join(root, rel), "utf8").catch(() => null);
    if (src === null) {
      assert.fail(`${rel} is missing — the contract claim covers all clients`);
    }
    assert.match(src, /from "@platform\/core"/, `${rel} imports the shared core`);
    assert.match(src, /attachmentCardModel|applyAttachmentEvent/, `${rel} uses the shared machine`);
    // The tell-tale of a re-implementation: a local copy of the state list.
    assert.doesNotMatch(
      src,
      /state:\s*"(uploading|ready|opaque|failed)"\s*\|/,
      `${rel} must not declare its own attachment state union`,
    );
  }
});

test("the guest surface shares the SAME web component (not a copy)", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const embed = await readFile(path.join(root, "web/src/pages/ZhiyuEmbedPage.tsx"), "utf8");
  const room = await readFile(path.join(root, "web/src/pages/ZhiyuRoomPage.tsx"), "utf8");
  for (const [name, src] of [["embed", embed], ["room", room]]) {
    assert.match(src, /<RoomComposer/, `${name} renders the shared RoomComposer`);
  }
});
