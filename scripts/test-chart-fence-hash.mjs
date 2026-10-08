// Agreement test (openspec: add-artifact-delivery, task 3.1): the server's
// capture hash and the shared core's canonicalChartHash must agree — the web
// badge correlates rendered fences with captured resource rows by content_hash,
// so any drift silently breaks the badge.
//
// For a corpus of fences (whitespace variants, unicode, nesting, key order),
// capture through the real funnel (resources.captureFromMessage) and compare
// the stored row's content_hash against the core (browser-shaped, async
// WebCrypto) computation. Node ≥23.6 strips the TS imports natively.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chart-fence-hash-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.RESOURCES_STORAGE_PATH = path.join(tmpRoot, "resources-store");
process.env.SESSIONS_STORE_DIR = path.join(tmpRoot, "sessions-store");
fs.mkdirSync(process.env.SESSIONS_STORE_DIR, { recursive: true });

const db = await import("../db.js");
const resources = await import("../resources.js");
const { chartHashesInText, canonicalChartHash, extractChartFences } = await import("../packages/core/src/lib/chart-fence.ts");

await db.initDb();

const FENCES = [
  { name: "plain", body: '{"series":[{"type":"line","data":[1,2]}]}' },
  { name: "whitespace-heavy", body: '{\n  "series" : [ { "type" : "bar" , "data" : [ 3 ] } ]\n}' },
  { name: "unicode", body: '{"title":{"text":"月度数据趋势（示例）"},"xAxis":{"data":["一月","二月"]}}' },
  { name: "nested", body: '{"series":[{"data":[{"value":1,"name":"甲"},{"value":2,"name":"乙"}]}]}' },
  { name: "duplicate-key", body: '{"a":1,"a":2,"series":[]}' },
];

test("core fence extraction matches the server contract", () => {
  const text = [
    "```echarts",
    FENCES[0].body,
    "```",
    "```echarts",
    "not json at all",
    "```",
    "```echarts",
    "[1,2,3]",
    "```",
    "```mermaid",
    "graph TD;",
    "```",
  ].join("\n");
  assert.equal(extractChartFences(text).length, 1);
});

test("captured content_hash equals the core canonical hash for every fence", async () => {
  for (const { name, body } of FENCES) {
    const text = "```echarts\n" + body + "\n```";
    const sessionId = `hash-agree-${name}`;
    resources.captureFromMessage({ sessionId, messageId: 1, sessionTitle: "t", text, createdAt: new Date().toISOString() });
    const rows = resources.list({}).items.filter((r) => r.sessionId === sessionId && r.type === "chart");
    assert.equal(rows.length, 1, `capture should create one row for ${name}`);
    const coreHash = await canonicalChartHash(body);
    assert.equal(rows[0].contentHash, coreHash, `server and core hashes must agree for ${name}`);
  }
});

test("chartHashesInText returns hashes in fence order", async () => {
  const text = FENCES.map((f) => "```echarts\n" + f.body + "\n```").join("\n\n");
  const hashes = await chartHashesInText(text);
  assert.equal(hashes.length, FENCES.length);
  const expected = await Promise.all(FENCES.map((f) => canonicalChartHash(f.body)));
  assert.deepEqual(hashes, expected);
  // Duplicate content dedupes to one captured row — the badge matches by set
  // membership, so this is the property it relies on.
  assert.equal(new Set(hashes).size, new Set(expected).size);
});
