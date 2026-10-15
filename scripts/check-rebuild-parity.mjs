#!/usr/bin/env node
// ── Live-specimen parity check for the rebuild tool ─────────────────────────
//
// The rebuild tool reproduces the LIVE mirror's row semantics. This script
// proves it against a cell whose index still exists: it rebuilds each session
// from the transcripts alone and diffs the result against what the running
// platform actually wrote, row by row (role, content, blocks).
//
// Run it on the host that holds the cell (the cell's own files, read-only):
//
//   node scripts/check-rebuild-parity.mjs --cell-root /opt/platform/cells/<userId>
//
// It opens the index read-only and writes nothing. A clean run prints
// `PARITY OK <n>/<n> sessions` and exits 0; any divergence prints the first
// differing row and exits 1. Run it before a production rebuild (design:
// "活标本 dry-run 前置") and after any dsh version bump, since the transcript
// event shapes are what the tool parses.

import { copyFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { decodeTranscript, transcriptToRows } from "./rebuild-chat-index.mjs";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--cell-root") args.cellRoot = argv[++i];
    else if (argv[i] === "--help" || argv[i] === "-h") args.help = true;
    else if (argv[i].startsWith("--")) throw new Error(`unknown option: ${argv[i]}`);
  }
  return args;
}

const HELP = `Compare rebuild output against a live cell's existing index.

Usage:
  node scripts/check-rebuild-parity.mjs --cell-root <dir>
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (!args.cellRoot) {
    process.stderr.write("--cell-root is required\n\n" + HELP);
    return 2;
  }
  const cellRoot = path.resolve(args.cellRoot);
  const dbPath = path.join(cellRoot, "data", "data", "app.db");
  if (!existsSync(dbPath)) {
    process.stderr.write(`no index at ${dbPath} — nothing to compare against\n`);
    return 2;
  }

  // Copy the index before opening: the cell may be live, and a WAL replay must
  // not touch the original.
  const tmpDir = await mkdtemp(path.join(tmpdir(), "parity-"));
  const tmpDb = path.join(tmpDir, "app.db");
  await copyFile(dbPath, tmpDb);
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(`${dbPath}${suffix}`)) await copyFile(`${dbPath}${suffix}`, `${tmpDb}${suffix}`);
  }

  const db = new Database(tmpDb, { readonly: true });
  const liveMessages = new Map();
  for (const row of db.prepare(`SELECT session_id, role, content, blocks FROM chat_messages ORDER BY session_id, seq`).all()) {
    if (!liveMessages.has(row.session_id)) liveMessages.set(row.session_id, []);
    liveMessages.get(row.session_id).push(row);
  }

  const sessionsRoot = path.join(cellRoot, "dsh", "sessions");
  let scopes = [];
  try {
    scopes = (await readdir(sessionsRoot, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    process.stderr.write(`no transcript root at ${sessionsRoot}\n`);
    return 2;
  }

  let compared = 0;
  let mismatched = 0;
  const missing = [];
  for (const scope of scopes) {
    let dirs = [];
    try {
      dirs = (await readdir(path.join(sessionsRoot, scope), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      continue;
    }
    for (const sid of dirs) {
      const file = path.join(sessionsRoot, scope, sid, "session.jsonl.zstd");
      if (!existsSync(file)) continue;
      const events = decodeTranscript(await readFile(file));
      const header = events.find((e) => e?.type === "session") ?? {};
      if ((header.delegationDepth ?? 0) !== 0) continue; // not indexed live either
      const id = header.id ?? sid;
      const live = liveMessages.get(id);
      if (!live) {
        // A session the live index never recorded (e.g. created after the last
        // mirror write, or an abandoned empty chat) is not a mismatch.
        missing.push(id);
        continue;
      }
      const rebuilt = transcriptToRows(events, { workspaceRoot: header.cwd ?? null });
      compared += 1;
      const diff = firstDiff(live, rebuilt);
      if (diff) {
        mismatched += 1;
        console.error(`[parity] MISMATCH ${id}`);
        console.error(`  live[${diff.index}]: ${JSON.stringify(diff.live)?.slice(0, 300)}`);
        console.error(`  rebuilt[${diff.index}]: ${JSON.stringify(diff.rebuilt)?.slice(0, 300)}`);
      }
    }
  }
  db.close();
  await rm(tmpDir, { recursive: true, force: true });

  if (mismatched) {
    console.error(`[parity] FAIL ${compared - mismatched}/${compared} sessions match (${mismatched} mismatched)`);
    return 1;
  }
  console.log(`[parity] PARITY OK ${compared}/${compared} sessions`);
  if (missing.length) console.log(`[parity] ${missing.length} transcript session(s) have no live rows (not compared)`);
  return 0;
}

// Row-by-row comparison of the fields the mirror owns. Live rows are ordered by
// seq; rebuilt rows keep transcript order.
function firstDiff(live, rebuilt) {
  const n = Math.max(live.length, rebuilt.length);
  for (let i = 0; i < n; i++) {
    const l = live[i];
    const r = rebuilt[i];
    if (!l || !r) return { index: i, live: l ?? null, rebuilt: r ?? null };
    const lBlocks = l.blocks ? JSON.parse(l.blocks) : null;
    const sameContent = (l.content ?? "") === (r.content ?? "");
    const sameBlocks = JSON.stringify(lBlocks) === JSON.stringify(r.blocks);
    if (l.role !== r.role || !sameContent || !sameBlocks) {
      return { index: i, live: { role: l.role, content: l.content, blocks: lBlocks }, rebuilt: r };
    }
  }
  return null;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname;
if (invokedDirectly) {
  const code = await main();
  process.exit(code);
}
