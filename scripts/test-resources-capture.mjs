// Unit tests for the resource library's capture path (openspec:
// add-resource-library, tasks 1.4 / 2.1 / 2.2 / 5.1).
//
// Covers:
//   - the extraction contract: what counts as a chart fence (and what must NOT)
//   - title derivation (option title wins; session-derived fallback otherwise)
//   - capture through chat-history.recordMessage — the single funnel every
//     client and every scheduled-task run passes through — with provenance
//   - content-hash idempotence: the same spec never creates a second row
//   - the seeding pass: one-time marker, no resurrection, explicit force
//
// Runs against an isolated DB_PATH + RESOURCES_STORAGE_PATH under os.tmpdir(),
// so it never touches the real project DB or store directories.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "resources-capture-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.RESOURCES_STORAGE_PATH = path.join(tmpRoot, "resources-store");
process.env.SESSIONS_STORE_DIR = path.join(tmpRoot, "sessions-store");
fs.mkdirSync(process.env.SESSIONS_STORE_DIR, { recursive: true });

const db = await import("../db.js");
const resources = await import("../resources.js");
const chatHistory = await import("../chat-history.js");

await db.initDb();
assert.ok(db.isDbReady(), "DB should be ready after initDb");

const fence = (body, lang = "echarts") => "```" + lang + "\n" + body + "\n```";

const OPTION_A = { title: { text: "月度营收" }, series: [{ type: "bar", data: [1, 2, 3] }] };
const OPTION_B = { series: [{ type: "line", data: [4, 5] }] };

// ── Extraction contract ─────────────────────────────────────────────────────

test("one valid fence extracts one spec", () => {
  const specs = resources.extractChartSpecs(`before\n${fence(JSON.stringify(OPTION_A))}\nafter`);
  assert.equal(specs.length, 1);
  assert.deepEqual(specs[0], OPTION_A);
});

test("multiple fences extract in order", () => {
  const text = `${fence(JSON.stringify(OPTION_A))}\ntext\n${fence(JSON.stringify(OPTION_B))}`;
  const specs = resources.extractChartSpecs(text);
  assert.equal(specs.length, 2);
  assert.deepEqual(specs[0], OPTION_A);
  assert.deepEqual(specs[1], OPTION_B);
});

test("a malformed body is not a chart", () => {
  assert.equal(resources.extractChartSpecs(fence("not json at all")).length, 0);
  assert.equal(resources.extractChartSpecs(fence("{ series: [}")).length, 0);
});

test("JSON that is not an object is not a chart", () => {
  assert.equal(resources.extractChartSpecs(fence("[1,2,3]")).length, 0);
  assert.equal(resources.extractChartSpecs(fence("42")).length, 0);
  assert.equal(resources.extractChartSpecs(fence('"a string"')).length, 0);
  assert.equal(resources.extractChartSpecs(fence("null")).length, 0);
});

test("an unterminated or empty fence is not a chart", () => {
  assert.equal(resources.extractChartSpecs("```echarts\n{ \"a\": 1 }").length, 0);
  assert.equal(resources.extractChartSpecs("```echarts\n\n```").length, 0);
});

test("non-echarts fences are ignored", () => {
  assert.equal(resources.extractChartSpecs(fence(JSON.stringify(OPTION_A), "json")).length, 0);
  assert.equal(resources.extractChartSpecs(fence(JSON.stringify(OPTION_A), "js")).length, 0);
});

test("CRLF and trailing info-string spaces still parse", () => {
  const crlf = "```echarts\r\n" + JSON.stringify(OPTION_A) + "\r\n```";
  assert.equal(resources.extractChartSpecs(crlf).length, 1);
  const spaced = "```echarts  \n" + JSON.stringify(OPTION_A) + "\n```";
  assert.equal(resources.extractChartSpecs(spaced).length, 1);
});

test("text with no fence extracts nothing", () => {
  assert.deepEqual(resources.extractChartSpecs("plain prose"), []);
  assert.deepEqual(resources.extractChartSpecs(""), []);
  assert.deepEqual(resources.extractChartSpecs(null), []);
});

// ── Capture through the mirror funnel ───────────────────────────────────────

const SESSION = "s-capture-" + Date.now();

test("an assistant turn with a chart is captured with provenance, unattended", () => {
  const now = new Date().toISOString();
  chatHistory.recordMessage(SESSION, "user", "帮我看下月度营收");
  chatHistory.recordMessage(SESSION, "assistant", `这是图：\n${fence(JSON.stringify(OPTION_A))}`, [
    { kind: "text", text: "这是图：" },
  ]);

  const { items } = resources.list({ type: "chart" });
  assert.equal(items.length, 1, "exactly one chart should be captured");
  const row = items[0];
  assert.equal(row.type, "chart");
  assert.equal(row.source, "auto");
  assert.equal(row.title, "月度营收", "the option's own title wins");
  assert.equal(row.sessionId, SESSION);
  assert.equal(row.sessionTitle, "帮我看下月度营收", "session title is snapshotted");
  assert.equal(row.messageId, 2, "the assistant message row id is recorded");
  assert.deepEqual(JSON.parse(row.payload), OPTION_A);
  assert.ok(row.lastSeenAt, "last_seen_at is stamped at capture");
  assert.ok(now.length > 0);
});

test("the same spec appearing again never creates a second row", () => {
  const before = resources.get(resources.list({ type: "chart" }).items[0].id);
  chatHistory.recordMessage(SESSION, "user", "再来一次");
  chatHistory.recordMessage(SESSION, "assistant", fence(JSON.stringify(OPTION_A)));
  const { items } = resources.list({ type: "chart" });
  assert.equal(items.length, 1, "hash dedupe keeps one row per spec");
  assert.equal(items[0].id, before.id, "the original row survives");
  assert.equal(items[0].sessionTitle, before.sessionTitle, "first provenance is kept");
});

test("a turn without charts creates nothing, and user turns never capture", () => {
  chatHistory.recordMessage(SESSION, "user", `user fence is text, not a chart\n${fence(JSON.stringify(OPTION_B))}`);
  chatHistory.recordMessage(SESSION, "assistant", "no fence here");
  const { items } = resources.list({ type: "chart" });
  assert.equal(items.length, 1, "only the first chart exists");
});

test("a scheduled-task turn shape captures identically (same funnel)", () => {
  // server/cron-runner.js calls chatHistory.recordMessage(sessionId,
  // "assistant", text, persistBlocks) — the identical call shape exercised
  // above. Prove a second, distinct spec from another session lands too.
  const cronSession = "s-cron-" + Date.now();
  chatHistory.recordMessage(cronSession, "assistant", fence(JSON.stringify(OPTION_B)));
  const { items } = resources.list({ type: "chart" });
  assert.equal(items.length, 2);
  const titles = items.map((r) => r.title).sort();
  assert.deepEqual(titles, ["New chat · Chart 1", "月度营收"]);
});

test("list filters by type and searches titles", () => {
  assert.equal(resources.list({ type: "file" }).total, 0);
  assert.equal(resources.list({ q: "月度" }).total, 1);
  assert.equal(resources.list({ q: "no-such-title" }).total, 0);
  // A wildcard in the query must be treated literally.
  assert.equal(resources.list({ q: "%" }).total, 0);
});

// ── Seeding ─────────────────────────────────────────────────────────────────

test("seeding captures pre-library history exactly once", () => {
  // Simulate pre-library rows: messages inserted straight into SQLite (no
  // capture), across two sessions, one of them chart-free.
  const now = new Date().toISOString();
  db.upsertSession("seed-1", "和图表无关的老会话", now, now);
  db.appendMessage("seed-1", "assistant", "just prose", now);
  db.upsertSession("seed-2", "历史图表会话", now, now);
  db.appendMessage("seed-2", "assistant", fence(JSON.stringify({ title: { text: "历史图" } })), now);
  db.appendMessage("seed-2", "assistant", "无围栏的消息", now);
  const existing = resources.list({ type: "chart" }).total;

  const first = resources.seedFromHistory();
  assert.equal(first.skipped, false);
  assert.equal(first.seeded, 1, "only the chart-bearing message seeds");
  assert.equal(resources.list({ type: "chart" }).total, existing + 1);

  const second = resources.seedFromHistory();
  assert.equal(second.skipped, true, "the marker stops the automatic re-run");
  assert.equal(second.reason, "already-seeded");
  assert.equal(resources.list({ type: "chart" }).total, existing + 1);
});

test("automatic seeding does not resurrect a deleted resource; force does", async () => {
  const seeded = resources.list({ q: "历史图" }).items[0];
  assert.ok(seeded, "the seeded chart is present");
  await resources.remove(seeded.id);
  assert.equal(resources.list({ q: "历史图" }).total, 0);

  const auto = resources.seedFromHistory();
  assert.equal(auto.skipped, true);
  assert.equal(resources.list({ q: "历史图" }).total, 0, "restart-style automatic seeding is a no-op");

  const forced = resources.seedFromHistory({ force: true });
  assert.equal(forced.seeded, 1, "the explicit operator re-run re-creates it");
  const again = resources.list({ q: "历史图" }).items[0];
  assert.equal(again.seeded, 1, "the row is flagged as seeded");
});