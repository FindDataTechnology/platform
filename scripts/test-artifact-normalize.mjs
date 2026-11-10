// Unit tests for functional-reference normalization (openspec:
// add-artifact-delivery, tasks 2.1–2.3; ADR-0009).
//
// Covers:
//   - data:text/* links: payload matching a workspace file → relative link;
//     no match → reduced to the label text; oversized payload → stripped
//   - absolute-path links: under the workspace (existing) → relative; outside
//     or nonexistent → untouched
//   - narrative untouched: inline code, fenced code blocks, prose
//   - idempotency, the walk bounds (file cap, skipped dirs, size prefilter)
//   - the recordMessage funnel: mirrored assistant text is normalized, user
//     text is not
//
// Runs against an isolated DB_PATH + RESOURCES_STORAGE_PATH under os.tmpdir().

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-normalize-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.RESOURCES_STORAGE_PATH = path.join(tmpRoot, "resources-store");
process.env.SESSIONS_STORE_DIR = path.join(tmpRoot, "sessions-store");
fs.mkdirSync(process.env.SESSIONS_STORE_DIR, { recursive: true });

const { normalizeFunctionalRefs } = await import("../artifact-normalize.js");
const db = await import("../db.js");
const chatHistory = await import("../chat-history.js");

await db.initDb();

const ws = path.join(tmpRoot, "workspace");
fs.mkdirSync(ws, { recursive: true });
const DOC = "# 报告\n内容";
fs.writeFileSync(path.join(ws, "报告.md"), DOC, "utf8");
fs.mkdirSync(path.join(ws, "sub"), { recursive: true });
fs.writeFileSync(path.join(ws, "sub", "data.csv"), "a,b\n1,2", "utf8");

const dataUri = (text) => `data:text/markdown;charset=utf-8;base64,${Buffer.from(text, "utf8").toString("base64")}`;
const wsPath = (rel) => path.join(ws, rel);

test("data: link matching a workspace file becomes a relative link", () => {
  const text = `报告在这：[下载 document](${dataUri(DOC)})`;
  assert.equal(normalizeFunctionalRefs(text, ws), "报告在这：[下载 document](报告.md)");
});

test("data: link without a workspace match is reduced to its label", () => {
  assert.equal(normalizeFunctionalRefs(`看这个 [孤本](${dataUri("不在工作区的字节流")})`, ws), "看这个 孤本");
});

test("data: image URI (non-text) is untouched", () => {
  const text = "[图](data:image/png;base64,iVBORw0KGgo=)";
  assert.equal(normalizeFunctionalRefs(text, ws), text);
});

test("absolute in-workspace link to an existing file is rewritten relative", () => {
  assert.equal(
    normalizeFunctionalRefs(`文件在 [这里](${wsPath("sub/data.csv")})`, ws),
    "文件在 [这里](sub/data.csv)",
  );
});

test("absolute path outside the workspace is untouched", () => {
  const text = "系统日志在 [这里](/etc/hosts)";
  assert.equal(normalizeFunctionalRefs(text, ws), text);
});

test("absolute in-workspace path to a nonexistent file is untouched", () => {
  assert.equal(normalizeFunctionalRefs(`幽灵 [文件](${wsPath("ghost.md")})`, ws), `幽灵 [文件](${wsPath("ghost.md")})`);
});

test("inline code and fenced blocks pass through verbatim", () => {
  const text = [
    "路径 `/tmp/x.md` 见上",
    "",
    "```markdown",
    `[示例](${dataUri("伪")}) 与 [绝对](/abs/a.md)`,
    "```",
    "",
    `正文里的反引号 \`${wsPath("报告.md")}\` 保留`,
  ].join("\n");
  assert.equal(normalizeFunctionalRefs(text, ws), text);
});

test("normalization is idempotent", () => {
  const text = `A [下载](${dataUri(DOC)}) B [绝对](${wsPath("报告.md")})`;
  const once = normalizeFunctionalRefs(text, ws);
  assert.equal(normalizeFunctionalRefs(once, ws), once);
});

test("walk skips dependency directories", () => {
  const depDir = path.join(ws, "node_modules", "pkg");
  fs.mkdirSync(depDir, { recursive: true });
  fs.writeFileSync(path.join(depDir, "hidden.md"), DOC, "utf8");
  fs.rmSync(path.join(ws, "报告.md"));
  // The only on-disk match now lives under node_modules → not a match → strip.
  assert.equal(normalizeFunctionalRefs(`[拿走](${dataUri(DOC)})`, ws), "拿走");
  fs.writeFileSync(path.join(ws, "报告.md"), DOC, "utf8");
});

test("oversized payload is stripped without needing a workspace match", () => {
  const big = "x".repeat(21 * 1024 * 1024);
  assert.equal(normalizeFunctionalRefs(`[巨物](${dataUri(big)})`, ws), "巨物");
});

test("two data: links with different payload sizes both resolve", () => {
  const csv = "a,b\n1,2";
  assert.equal(
    normalizeFunctionalRefs(`[文档](${dataUri(DOC)}) 和 [表格](${dataUri(csv)})`, ws),
    "[文档](报告.md) 和 [表格](sub/data.csv)",
  );
});

test("text without functional references is returned unchanged (prefilter)", () => {
  const text = "普通正文，无链接。Inline `code` stays.";
  assert.equal(normalizeFunctionalRefs(text, ws), text);
  assert.equal(normalizeFunctionalRefs(text, null), text);
});

test("recordMessage normalizes mirrored assistant text but not user text", () => {
  chatHistory.setDshBridge({ getCwd: () => ws });
  const sessionId = "norm-funnel-test";
  chatHistory.recordMessage(sessionId, "user", `给我 [坏链接](${dataUri(DOC)})`);
  chatHistory.recordMessage(sessionId, "assistant", `产物 [下载](${dataUri(DOC)})`);
  const messages = db.getChatMessages(sessionId);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].content.includes("data:"), true); // user text untouched
  assert.equal(messages[1].content, "产物 [下载](报告.md)"); // assistant normalized
});

test("walk cap degrades to label without hanging or mislinking", () => {
  const capWs = path.join(tmpRoot, "cap-workspace");
  fs.mkdirSync(capWs, { recursive: true });
  const payload = "payload-内容";
  for (let i = 0; i < 520; i++) {
    // Same size as the payload, different bytes: every visited file passes the
    // size prefilter and gets hashed, exercising the cap, and none can match.
    fs.writeFileSync(path.join(capWs, `f${String(i).padStart(3, "0")}.txt`), `${i}-${payload}`);
  }
  assert.equal(normalizeFunctionalRefs(`[目标](${dataUri(payload)})`, capWs), "目标");
});
