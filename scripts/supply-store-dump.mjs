#!/usr/bin/env node
// ── Supply spine store dump — Node side (add-supply-store-unification 1.5) ──
//
// supply-store-dump.sh 的 pod 内等价物（facet 容器无 sqlite3 CLI，有 node）。
// better-sqlite3 的 .backup API = 在线一致性快照（WAL-safe，不锁写）。
//
// 用法：
//   node scripts/supply-store-dump.mjs <packs.db> [out-dir]
// 输出：packs-<时间戳>.db + SHA256 + 行数清单 + integrity_check。

import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const dbFile = process.argv[2];
if (!dbFile) {
  console.error("usage: node supply-store-dump.mjs <packs.db> [out-dir]");
  process.exit(2);
}
const stamp = new Date().toISOString().replace(/[:.]/g, "").replace("T", "T").slice(0, 16) + "Z";
const outDir = process.argv[3] || path.join(path.dirname(dbFile), "dumps", stamp);
mkdirSync(outDir, { recursive: true });

const target = path.join(outDir, `packs-${stamp}.db`);
const src = new Database(dbFile, { readonly: true });
await src.backup(target);
src.close();

const check = new Database(target, { readonly: true });
const counts = {};
for (const table of ["packs", "mcp_servers", "skills"]) {
  try {
    counts[table] = check.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
  } catch {
    counts[table] = "n/a";
  }
}
const integrity = check.pragma("integrity_check", { simple: true });
check.close();

const sha = createHash("sha256").update(require("node:fs").readFileSync(target)).digest("hex");
const summary = [
  `db=${target}`,
  `sha256=${sha}`,
  `rows: ${Object.entries(counts).map(([t, n]) => `${t}=${n}`).join(" ")}`,
  `integrity: ${integrity}`,
].join("\n");
writeFileSync(path.join(outDir, `packs-${stamp}.sha256.txt`), summary + "\n");
console.log(`[supply-store-dump] done\n${summary}`);
