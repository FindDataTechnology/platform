// Unit tests for the windowed transcript reads (openspec: polish-web-surfaces,
// tasks 3.2/3.3). The WS layer just forwards these, so the contract that matters
// — a bounded first frame plus honest backwards paging — is tested here against
// a real SQLite store. Runs under `npm run test:unit`.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-window-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.SESSIONS_STORE_DIR = path.join(tmpRoot, "sessions-store");
fs.mkdirSync(process.env.SESSIONS_STORE_DIR, { recursive: true });

const db = await import("../db.js");
const chatHistory = await import("../chat-history.js");

chatHistory.setDshBridge({ async deleteSession() { return true; } });
chatHistory.setSessionManager({ getSessionId: () => null });

await db.initDb();
assert.ok(db.isDbReady(), "DB should be ready after initDb");

const LONG = "s-long-" + Date.now();
const TOTAL = 120;
const now = new Date().toISOString();
db.upsertSession(LONG, "long", now, now);
for (let i = 1; i <= TOTAL; i += 1) {
  db.appendMessage(LONG, i % 2 === 1 ? "user" : "assistant", `m${i}`, now);
}

test("the tail window is bounded, ascending, and carries the counts", async () => {
  const win = await chatHistory.getSessionWindow(LONG, { limit: 50 });
  assert.equal(win.id, LONG);
  assert.equal(win.messages.length, 50, "first frame carries at most the window");
  assert.equal(win.totalTurns, TOTAL);
  assert.equal(win.hasMore, true);
  // The window is the TAIL: m71..m120, in ascending order.
  assert.equal(win.messages[0].content, "m71");
  assert.equal(win.messages[win.messages.length - 1].content, "m120");
  assert.equal(typeof win.messages[0].seq, "number", "each message carries its paging cursor");
});

test("a session within the window reports no earlier pages", async () => {
  const win = await chatHistory.getSessionWindow(LONG, { limit: 500 });
  assert.equal(win.messages.length, TOTAL);
  assert.equal(win.hasMore, false);
});

test("paging walks backwards to the first turn and then stops", async () => {
  const first = await chatHistory.getSessionWindow(LONG, { limit: 50 });
  const page1 = await chatHistory.getEarlierMessages(LONG, first.messages[0].seq, { limit: 50 });
  assert.equal(page1.messages.length, 50);
  assert.equal(page1.hasMore, true, "two more turns (m1..m20) remain");
  assert.equal(page1.messages[0].content, "m21");
  assert.equal(page1.messages[page1.messages.length - 1].content, "m70");

  const page2 = await chatHistory.getEarlierMessages(LONG, page1.messages[0].seq, { limit: 50 });
  assert.equal(page2.messages.length, 20);
  assert.equal(page2.hasMore, false, "the oldest page ends the paging");
  assert.equal(page2.messages[0].content, "m1");

  // Stitching the pages reproduces the whole transcript, in order.
  const stitched = [...page2.messages, ...page1.messages, ...first.messages].map((m) => m.content);
  assert.deepEqual(
    stitched,
    Array.from({ length: TOTAL }, (_, i) => `m${i + 1}`),
  );
});

test("an empty page is honest, not fabricated", async () => {
  const first = await chatHistory.getSessionWindow(LONG, { limit: 500 });
  const page = await chatHistory.getEarlierMessages(LONG, first.messages[0].seq, { limit: 50 });
  assert.equal(page.messages.length, 0);
  assert.equal(page.hasMore, false);
});

test("unknown input degrades to empty rather than throwing", async () => {
  assert.equal(await chatHistory.getSessionWindow(null), null);
  const miss = await chatHistory.getEarlierMessages("s-nonexistent", 5);
  assert.deepEqual(miss, { messages: [], hasMore: false });
  const badCursor = await chatHistory.getEarlierMessages(LONG, "nope");
  assert.deepEqual(badCursor, { messages: [], hasMore: false });
});

test("a not-yet-mirrored session windows its fallback messages with paging off", async () => {
  const incoming = Array.from({ length: 80 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `f${i + 1}` }));
  const win = await chatHistory.getSessionWindow("s-unmirrored", {
    limit: 50,
    fallbackMessages: incoming,
    fallbackTitle: "live",
  });
  assert.equal(win.title, "live");
  assert.equal(win.messages.length, 50);
  assert.equal(win.messages[0].content, "f31");
  assert.equal(win.totalTurns, 80);
  assert.equal(win.hasMore, false, "nothing older exists on disk to page to");
});
