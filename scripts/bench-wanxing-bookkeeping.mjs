#!/usr/bin/env node
// ── 10k-form bench for the bookkeeping snapshot (add-wanxing-deployments-cache 4.1) ─
//
// Wanxing-scale shape check, local: 10k synthetic bookkeeping rows in the
// snapshot cache — slug resolution must be O(1)-flat (Map), and a refresh's
// diff must handle 10k×10k with ~1% churn inside the TTL budget. Not a test:
// a repeatable probe with a pass line (exit 0) for CI/deploy rehearsal.
//
//   node scripts/bench-wanxing-bookkeeping.mjs [--rows N]

import { createBookkeepingCache, diffDeployments } from "../gateway/wanxing/bookkeeping.js";

const ROWS = Number.parseInt(process.argv.includes("--rows") ? process.argv[process.argv.indexOf("--rows") + 1] : "10000", 10);

const mk = (i) => ({
  packId: `pk${i}`,
  agentId: `agent-${i}`,
  agentPath: `/packs/pk${i}/deployments/agent-${i}`,
  version: "1",
});

const rows = Array.from({ length: ROWS }, (_, i) => mk(i));
let fetches = 0;
const cache = createBookkeepingCache({
  fetchRows: async () => {
    fetches += 1;
    return rows;
  },
  ttlMs: 60_000,
});

const p95 = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length * 0.95)];

// resolve: cold load then 10k random-slug lookups
await cache.rows();
const slugs = Array.from({ length: ROWS }, () => rows[Math.floor(Math.random() * rows.length)].agentPath)
  .map((p) => p.replace(/^\/+/, "").replace(/[^A-Za-z0-9._-]+/g, "-").toLowerCase());
const lat = [];
for (const s of slugs) {
  const t0 = performance.now();
  const hit = await cache.resolve(s);
  lat.push(performance.now() - t0);
  if (!hit) throw new Error(`resolve miss for ${s}`);
}
const resolveP95 = p95(lat);

// diff: 10k vs 10k with 1% churn (50 add / 50 remove / 50 change)
const next = rows.slice();
for (let i = 0; i < 50; i++) next.shift(); // removed
for (let i = 0; i < 50; i++) next.push(mk(ROWS + i)); // added
for (let i = 0; i < 50; i++) next[i] = { ...next[i], version: "2" }; // changed
const t1 = performance.now();
const d = diffDeployments(rows, next);
const diffMs = performance.now() - t1;

const checks = [
  ["resolve p95 < 1ms", resolveP95 < 1, `${resolveP95.toFixed(4)}ms over ${ROWS} lookups`],
  ["single fetch for all lookups", fetches === 1, `fetches=${fetches}`],
  ["diff buckets exact", d.added.length === 50 && d.removed.length === 50 && d.changed.length === 50,
    `+${d.added.length} -${d.removed.length} ~${d.changed.length}`],
  ["diff 10k×10k < 500ms", diffMs < 500, `${diffMs.toFixed(1)}ms`],
];

let fail = 0;
console.log(`bench-wanxing-bookkeeping rows=${ROWS}`);
for (const [name, ok, detail] of checks) {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name} — ${detail}`);
  if (!ok) fail += 1;
}
process.exit(fail ? 1 : 0);
