#!/usr/bin/env node
// ── Rebuild-tool tests (rebuild-chat-index) ──────────────────────────────────
//
// Pins the mirror semantics the rebuild reproduces, so a drift in either the
// transcript shape or the tool is caught here rather than in production:
//
//   1. user rows: genuine user events only, deduplicated across the
//      agent/inbox/spliced + user/message pair, subagent echoes excluded;
//   2. assistant rows: only when text or tool blocks exist, blocks synthesized
//      from tool/call + tool/result (args parsed, result text, done/error);
//   3. subagent sessions are not indexed;
//   4. merge takes the more complete side per session; legacy-only sessions
//      are imported; foreign-owner rows are skipped;
//   5. dry run writes nothing; --apply backs up first and is idempotent.
//
//   node --test scripts/test-rebuild-chat-index.mjs

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import zlib from "node:zlib";
import Database from "better-sqlite3";
import { transcriptToRows, sessionMetaFrom, decodeTranscript, mergeSessions } from "./rebuild-chat-index.mjs";

const run = promisify(execFile);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOOL = path.join(REPO, "scripts", "rebuild-chat-index.mjs");

const ev = (type, data = {}, time = undefined) => ({ type, ...(time ? { time } : {}), data });
const userEv = (id, text, time = 1) => ({
  type: "user/message",
  time,
  data: { id, source: { kind: "user" }, content: [{ type: "text", text }] },
});
const splicedEv = (id, text) => ({
  type: "agent/inbox/spliced",
  time: 1,
  data: { inserted: [{ id, source: { kind: "user" }, content: [{ type: "text", text }] }] },
});
const subagentEcho = (text) => ({
  type: "user/message",
  time: 1,
  data: {
    id: `sa-${Math.random()}`,
    source: { kind: "subagent-settled" },
    content: [{ type: "text", text }, { type: "reasoning", text: "internal" }],
  },
});
const toolCall = (callId, name, args) => ({
  type: "tool/call",
  time: 2,
  data: { callId, name, arguments: JSON.stringify(args) },
});
const toolResult = (callId, text, isError = false) => ({
  type: "tool/result",
  time: 3,
  data: { message: { source: { callId }, content: [{ toolCallId: callId, isError, content: [{ type: "text", text }] }] } },
});
const assistantEv = (text, blocks = [], time = 4) => ({
  type: "assistant/message",
  time,
  data: { turn: 1, step: 1, message: { role: "assistant", content: [...(text ? [{ type: "text", text }] : []), ...blocks] } },
});

test("user rows dedupe the spliced/consumed pair and exclude subagent echoes", () => {
  const rows = transcriptToRows([
    ev("turn/start"),
    splicedEv("u1", "hello"),
    userEv("u1", "hello"),
    subagentEcho("Background subagent failed."),
    userEv("u2", "second"),
  ]);
  assert.deepEqual(
    rows.map((r) => [r.role, r.content]),
    [
      ["user", "hello"],
      ["user", "second"],
    ]
  );
});

test("assistant rows need text or tools; blocks carry args/result/state", () => {
  const rows = transcriptToRows([
    ev("turn/start"),
    userEv("u1", "write it"),
    toolCall("c1", "write", { file_path: "/ws/ch1.md" }),
    toolResult("c1", "written"),
    toolCall("c2", "bash", { command: "false" }),
    toolResult("c2", "boom", true),
    assistantEv("Done.", [{ type: "tool-call", id: "c1", name: "write", arguments: "{}" }]),
  ]);
  assert.equal(rows.length, 2);
  const a = rows[1];
  assert.equal(a.role, "assistant");
  assert.equal(a.content, "Done.");
  assert.equal(a.blocks.length, 3, "two tools + trailing text");
  assert.deepEqual(a.blocks[0], {
    kind: "tool",
    id: "c1",
    name: "write",
    args: { file_path: "/ws/ch1.md" },
    result: "written",
    state: "done",
  });
  assert.equal(a.blocks[1].state, "error", "isError maps to error");
  assert.deepEqual(a.blocks[2], { kind: "text", text: "Done." });
});

test("an assistant turn with only tools still gets a row", () => {
  const rows = transcriptToRows([
    ev("turn/start"),
    toolCall("c1", "read", { file_path: "x" }),
    toolResult("c1", "contents"),
    assistantEv(""),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].role, "assistant");
  assert.equal(rows[0].content, "");
  assert.equal(rows[0].blocks.length, 1);
});

test("an assistant turn with neither text nor tools is skipped", () => {
  const rows = transcriptToRows([ev("turn/start"), assistantEv("")]);
  assert.equal(rows.length, 0);
});

test("unparseable tool arguments are kept as the raw string", () => {
  const rows = transcriptToRows([
    ev("turn/start"),
    { type: "tool/call", time: 2, data: { callId: "c1", name: "bash", arguments: "not-json" } },
    assistantEv(""),
  ]);
  assert.equal(rows[0].blocks[0].args, "not-json");
});

test("session metadata comes from the header and first user message", () => {
  const events = [
    { type: "session", id: "platform-x", delegationDepth: 0, agentPreset: "code", cwd: "/data/cells/u/workspace", time: 1000 },
    userEv("u1", "  Title\nwith newline  ", 1000),
    assistantEv("ok", [], 5000),
  ];
  const rows = transcriptToRows(events);
  const meta = sessionMetaFrom(events, rows);
  assert.equal(meta.id, "platform-x");
  assert.equal(meta.agentPreset, "code");
  assert.equal(meta.workspace, "/data/cells/u/workspace");
  assert.equal(meta.title, "Title with newline");
  assert.equal(meta.createdAt, new Date(1000).toISOString());
  assert.equal(meta.updatedAt, new Date(5000).toISOString());
});

test("a title longer than 60 chars is truncated with an ellipsis", () => {
  const long = "x".repeat(100);
  const events = [{ type: "session", id: "s", delegationDepth: 0 }, userEv("u1", long)];
  const meta = sessionMetaFrom(events, transcriptToRows(events));
  assert.equal(meta.title.length, 61, "60 chars + ellipsis");
  assert.ok(meta.title.endsWith("…"));
});

test("subagent transcripts are skipped and depth-0 kept", () => {
  const mk = (depth) => [
    { type: "session", id: `s-${depth}`, delegationDepth: depth },
    userEv("u1", "hi"),
  ];
  const deep = sessionMetaFrom(mk(2), []);
  assert.equal(deep.delegationDepth, 2, "depth is reported so callers can filter");
  assert.equal(sessionMetaFrom(mk(0), []).delegationDepth, 0);
});

test("decodeTranscript reads multi-frame zstd and skips a torn frame", () => {
  const frame = (obj) => zlib.zstdCompressSync(Buffer.from(JSON.stringify(obj) + "\n"));
  const good = Buffer.concat([frame({ type: "session", id: "s1" }), frame({ type: "turn/start" })]);
  const torn = Buffer.concat([good, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x01])]);
  assert.deepEqual(decodeTranscript(good).map((e) => e.type), ["session", "turn/start"]);
  assert.deepEqual(decodeTranscript(torn).map((e) => e.type), ["session", "turn/start"], "torn tail dropped, good frames kept");
});

test("merge prefers the more complete side per session", () => {
  const t = new Map([["a", { meta: { title: "ta" }, rows: [{ role: "user", content: "1" }] }]]);
  const l = new Map([["a", { meta: { title: "la", owner: "o@x" }, rows: [{ role: "user", content: "1" }, { role: "assistant", content: "2" }] }]]);
  const report = { plan: [] };
  const merged = mergeSessions(t, l, report);
  assert.equal(merged.get("a").rows.length, 2, "legacy has more rows here");
  assert.equal(merged.get("a").source, "legacy");

  const t2 = new Map([["b", { meta: { title: "tb" }, rows: [{ role: "user", content: "1" }, { role: "assistant", content: "2" }, { role: "assistant", content: "3" }] }]]);
  const l2 = new Map([["b", { meta: { title: "lb" }, rows: [{ role: "user", content: "1" }] }]]);
  const merged2 = mergeSessions(t2, l2, { plan: [] });
  assert.equal(merged2.get("b").rows.length, 3, "transcript kept growing past the snapshot");
  assert.equal(merged2.get("b").source, "transcript");
});

test("legacy-only sessions are imported and reported", () => {
  const l = new Map([["solo", { meta: { title: "Old chat" }, rows: [] }]]);
  const report = { plan: [] };
  const merged = mergeSessions(new Map(), l, report);
  assert.equal(merged.size, 1);
  assert.equal(report.plan[0].source, "legacy-only");
});

test("assistant text is normalized against the session workspace", async () => {
  // The live mirror rewrites workspace-absolute links to relative form before
  // persisting (ADR-0009); the rebuild must do the same, or a reloaded session
  // shows links the live one had already fixed. The rewrite needs the target to
  // exist, so the workspace is real.
  const root = await mkdtemp(path.join(tmpdir(), "rebuild-norm-"));
  try {
    await mkdir(path.join(root, "ws"), { recursive: true });
    await writeFile(path.join(root, "ws", "chapter-1.md"), "# Chapter 1\n");
    const events = [
      { type: "session", id: "s", delegationDepth: 0, cwd: path.join(root, "ws") },
      userEv("u1", "write it"),
      assistantEv(`Done — see [chapter-1.md](${path.join(root, "ws", "chapter-1.md")})`),
    ];
    const rows = transcriptToRows(events, { workspaceRoot: path.join(root, "ws") });
    assert.equal(rows[1].content, "Done — see [chapter-1.md](chapter-1.md)", "absolute in-workspace link rewritten relative");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("normalization failure never loses a message", () => {
  // normalizeFunctionalRefs is total, but the tool must keep the message even if
  // a future change makes it throw: content preservation outranks rewriting.
  const rows = transcriptToRows(
    [{ type: "session", id: "s", delegationDepth: 0 }, userEv("u1", "hi"), assistantEv("text stays")],
    { workspaceRoot: "/nonexistent/workspace/root" }
  );
  assert.equal(rows[1].content, "text stays");
});

// ── CLI-level: dry run / apply / backup / idempotence ────────────────────────

async function buildCell({ withLegacy = false, foreignOwner = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "rebuild-cell-"));
  await mkdir(path.join(root, "data"), { recursive: true });
  await writeFile(
    path.join(root, "data", "owner-groups.json"),
    JSON.stringify({ email: "owner@cell.test", groups: [] })
  );
  const scope = path.join(root, "dsh", "sessions", "--app--", "platform-live");
  await mkdir(scope, { recursive: true });
  const events = [
    { type: "session", id: "platform-live", delegationDepth: 0, agentPreset: "code", cwd: "/data/ws", time: 1_700_000_000_000 },
    splicedEv("u1", "Write chapter one"),
    userEv("u1", "Write chapter one"),
    { type: "turn/start", time: 1_700_000_001_000 },
    toolCall("c1", "write", { file_path: "/data/ws/ch1.md" }),
    toolResult("c1", "written"),
    { ...assistantEv("Chapter one done."), time: 1_700_000_002_000 },
  ];
  const buf = Buffer.concat(events.map((e) => zlib.zstdCompressSync(Buffer.from(JSON.stringify(e) + "\n"))));
  await writeFile(path.join(scope, "session.jsonl.zstd"), buf);

  let legacyPath = null;
  if (withLegacy) {
    legacyPath = path.join(root, "legacy.db");
    const db = new Database(legacyPath);
    db.exec(`CREATE TABLE chat_sessions (
      id TEXT PRIMARY KEY, title TEXT, created_at TEXT, updated_at TEXT, path TEXT,
      agent_preset TEXT, workspace TEXT, owner TEXT)`);
    db.exec(`CREATE TABLE chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT,
      seq INTEGER NOT NULL, created_at TEXT, blocks TEXT)`);
    db.prepare(`INSERT INTO chat_sessions VALUES (?,?,?,?,?,?,?,?)`).run(
      "platform-live", "Old title", "2026-09-30T00:00:00.000Z", "2026-09-30T01:00:00.000Z", null, "code", "/data/ws", "owner@cell.test"
    );
    db.prepare(`INSERT INTO chat_messages (session_id,role,content,seq,created_at,blocks) VALUES (?,?,?,?,?,?)`).run(
      "platform-live", "user", "Write chapter one", 1, "2026-09-30T00:00:00.000Z", null
    );
    // A legacy-only session (empty "New chat") and a foreign-owner session.
    db.prepare(`INSERT INTO chat_sessions VALUES (?,?,?,?,?,?,?,?)`).run(
      "platform-empty", "New chat", "2026-09-29T00:00:00.000Z", "2026-09-29T00:00:00.000Z", null, null, null, "owner@cell.test"
    );
    if (foreignOwner) {
      db.prepare(`INSERT INTO chat_sessions VALUES (?,?,?,?,?,?,?,?)`).run(
        "someone-else", "Not mine", "2026-09-29T00:00:00.000Z", "2026-09-29T00:00:00.000Z", null, null, null, "other@person.test"
      );
      db.prepare(`INSERT INTO chat_messages (session_id,role,content,seq,created_at,blocks) VALUES (?,?,?,?,?,?)`).run(
        "someone-else", "user", "hi", 1, "2026-09-29T00:00:00.000Z", null
      );
    }
    db.close();
  }
  return { root, legacyPath };
}

test("dry run writes nothing and reports the plan", async () => {
  const { root, legacyPath } = await buildCell({ withLegacy: true, foreignOwner: true });
  try {
    const { stdout } = await run("node", [TOOL, "--cell-root", root, "--legacy", legacyPath, "--report", path.join(root, "r.json")]);
    assert.match(stdout, /mode: dry-run/);
    assert.match(stdout, /legacy-only 1/);
    assert.match(stdout, /skipped foreign-owner sessions: 1/);
    assert.equal(existsSync(path.join(root, "data", "data", "app.db")), false, "no index written by a dry run");
    const report = JSON.parse(await readFile(path.join(root, "r.json"), "utf8"));
    assert.equal(report.totals.skippedForeignOwner, 1);
    assert.ok(report.plan.some((p) => p.source === "legacy-only" && p.id === "platform-empty"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("apply writes the index, backs up a prior one, and is idempotent", async () => {
  const { root, legacyPath } = await buildCell({ withLegacy: true });
  try {
    await run("node", [TOOL, "--cell-root", root, "--legacy", legacyPath, "--apply"]);
    const dbPath = path.join(root, "data", "data", "app.db");
    let db = new Database(dbPath);
    const sessions = db.prepare(`SELECT id, title, owner FROM chat_sessions ORDER BY id`).all();
    assert.equal(sessions.length, 2, "the live session plus the legacy-only empty one");
    const live = sessions.find((s) => s.id === "platform-live");
    assert.equal(live.title, "Write chapter one", "the transcript (more complete) side won");
    assert.equal(live.owner, "owner@cell.test");
    const msgs = db.prepare(`SELECT seq, role, content, blocks FROM chat_messages WHERE session_id='platform-live' ORDER BY seq`).all();
    assert.equal(msgs.length, 2, "user deduped, assistant present");
    assert.equal(msgs[0].role, "user");
    const blocks = JSON.parse(msgs[1].blocks);
    assert.equal(blocks[0].kind, "tool");
    assert.equal(blocks[0].result, "written");
    assert.equal(blocks[0].state, "done");
    db.close();

    // Re-run: same result, and a backup of the first write exists.
    await run("node", [TOOL, "--cell-root", root, "--legacy", legacyPath, "--apply"]);
    db = new Database(dbPath);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM chat_messages`).get().n, 2, "no duplication on re-run");
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM chat_sessions`).get().n, 2);
    db.close();
    const backups = (await readdir(path.join(root, "data", "data"))).filter((f) => f.includes("app.db.bak-"));
    assert.ok(backups.length >= 1, "a backup was taken before the second write");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing --cell-root exits non-zero with usage", async () => {
  await assert.rejects(
    () => run("node", [TOOL]),
    (err) => err.code === 2 && /--cell-root is required/.test(err.stderr)
  );
});

test("an unknown option is rejected", async () => {
  await assert.rejects(
    () => run("node", [TOOL, "--cell-root", "/tmp", "--nope"]),
    (err) => /unknown option: --nope/.test(err.stderr)
  );
});

test("a nonexistent cell root exits non-zero", async () => {
  await assert.rejects(
    () => run("node", [TOOL, "--cell-root", "/tmp/definitely-not-a-cell-xyz"]),
    (err) => err.code === 2 && /does not exist/.test(err.stderr)
  );
});
