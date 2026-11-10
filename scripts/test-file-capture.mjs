// Unit tests for the file-capture path (openspec:
// wire-produced-files-to-outputs, task 2.4). captureFilesFromTurn rides the
// mirror funnel next to the chart capture; these pin its gate and dedupe:
//
//   - a produced file is captured with source=auto and turn provenance
//   - same bytes refresh the existing row (no second entry)
//   - changed bytes on the same path insert a new row (history preserved)
//   - candidates outside the workspace root are refused (/tmp redirects)
//   - missing candidates and oversize files are skipped, not errors
//   - a throwing gate never escapes: capture reports what it saved
//   - the mirror funnel calls it and survives its failure
//
// Runs against an isolated DB_PATH + RESOURCES_STORAGE_PATH under os.tmpdir().

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "file-capture-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.RESOURCES_STORAGE_PATH = path.join(tmpRoot, "resources-store");
process.env.SESSIONS_STORE_DIR = path.join(tmpRoot, "sessions-store");
fs.mkdirSync(process.env.SESSIONS_STORE_DIR, { recursive: true });

const db = await import("../db.js");
const resources = await import("../resources.js");
const chatHistory = await import("../chat-history.js");

await db.initDb();
assert.ok(db.isDbReady(), "DB should be ready after initDb");

const SESSION = "s-filecapture-" + Date.now();
const ws = fs.mkdtempSync(path.join(os.tmpdir(), "capture-ws-"));

const writeFile = (rel, bytes) => {
  const full = path.join(ws, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, bytes);
  return full;
};

const fileRows = () => db.listResources({ type: "file", limit: 100 }).items;
const blocksFor = (command) => [{ kind: "tool", id: "t1", name: "bash", args: { command }, result: "", state: "done" }];

test("a turn-produced file is captured with source=auto and provenance", async () => {
  writeFile("report.tar.gz", "archive-bytes-1");
  const results = await resources.captureFilesFromTurn({
    sessionId: SESSION,
    messageId: null,
    blocks: blocksFor("tar -czf report.tar.gz docs/"),
    workspaceRoot: ws,
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].inserted, true);
  const rows = fileRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, "auto");
  assert.equal(rows[0].title, "report.tar.gz");
  assert.equal(rows[0].sessionId, SESSION);
});

test("same bytes refresh; changed bytes insert a new row", async () => {
  // Same content, produced again by a later turn — no second entry.
  const again = await resources.captureFilesFromTurn({
    sessionId: SESSION,
    messageId: null,
    blocks: blocksFor("tar -czf report.tar.gz docs/"),
    workspaceRoot: ws,
  });
  assert.equal(again[0].inserted, false);
  assert.equal(fileRows().length, 1);

  // Changed bytes, same path — a new row; the earlier one survives.
  writeFile("report.tar.gz", "archive-bytes-2-longer");
  const changed = await resources.captureFilesFromTurn({
    sessionId: SESSION,
    messageId: null,
    blocks: blocksFor("tar -czf report.tar.gz docs/"),
    workspaceRoot: ws,
  });
  assert.equal(changed[0].inserted, true);
  assert.equal(fileRows().length, 2);
});

test("candidates outside the workspace root are refused", async () => {
  const before = fileRows().length;
  const results = await resources.captureFilesFromTurn({
    sessionId: SESSION,
    messageId: null,
    blocks: blocksFor("sort > /tmp/doclist.txt"),
    workspaceRoot: ws,
  });
  assert.deepEqual(results, []);
  assert.equal(fileRows().length, before);
});

test("missing candidates are skipped without error", async () => {
  const results = await resources.captureFilesFromTurn({
    sessionId: SESSION,
    messageId: null,
    blocks: blocksFor("tar -czf never-made.tar.gz docs/"),
    workspaceRoot: ws,
  });
  assert.deepEqual(results, []);
});

test("an oversize candidate is skipped", async () => {
  const big = path.join(ws, "big.zip");
  fs.writeFileSync(big, Buffer.alloc(64 * 1024 * 1024).fill(0x61));
  const before = fileRows().length;
  const results = await resources.captureFilesFromTurn({
    sessionId: SESSION,
    messageId: null,
    blocks: blocksFor("zip -q big.zip assets/"),
    workspaceRoot: ws,
  });
  assert.deepEqual(results, []);
  assert.equal(fileRows().length, before);
});

test("a python heredoc zip is captured (the production shape)", async () => {
  writeFile("markdown-docs.zip", "PK\x03\x04-zip-bytes");
  const results = await resources.captureFilesFromTurn({
    sessionId: SESSION,
    messageId: null,
    blocks: [
      {
        kind: "tool",
        id: "t2",
        name: "bash",
        args: {
          command: "python3 - <<'EOF'\nout = 'markdown-docs.zip'\nprint('x -> y', out)\nEOF\nls",
        },
        result: "",
        state: "done",
      },
    ],
    workspaceRoot: ws,
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].resource.title, "markdown-docs.zip");
});

test("capture never throws, even when the store explodes", async () => {
  // Point the store somewhere unwritable for this call: the gate's write step
  // must fail inside, and the capture must return without escaping an error.
  const poisoned = path.join(ws, "poison.zip");
  fs.writeFileSync(poisoned, "bytes");
  const brokenRoot = path.join(ws, "not-a-dir", "deeper");
  // A workspace root that does not exist makes realpath fail for every
  // candidate — refusal, not crash.
  const results = await resources.captureFilesFromTurn({
    sessionId: SESSION,
    messageId: null,
    blocks: blocksFor("zip -q poison.zip x/"),
    workspaceRoot: brokenRoot,
  });
  assert.deepEqual(results, []);
});

test("the mirror funnel launches the file capture and survives it", async () => {
  chatHistory.setDshBridge({ getCwd: () => ws });
  writeFile("funnel.md", "# funnel");
  chatHistory.recordMessage(
    "s-filecapture-funnel",
    "assistant",
    "打包好了",
    blocksFor("echo x > funnel.md")
  );
  // The capture is async (launched, not awaited by recordMessage); poll
  // briefly for the row.
  const deadline = Date.now() + 3000;
  let rows = [];
  while (Date.now() < deadline) {
    rows = db.listResources({ type: "file", limit: 100 }).items.filter((r) => r.title === "funnel.md");
    if (rows.length) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, "auto");
});
