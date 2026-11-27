#!/usr/bin/env node
// ── aggregate-studio-metrics.mjs (add-agent-builder-workspace 8.4) ──────────
//
// Reads an exported metrics JSON (the browser-local ring at
// localStorage["platform.studio.metrics.v1"] — paste it into a file) and
// prints the three spec'd aggregates:
//
//   1. time-to-first-emit   — doc_created → first emit, per document, median
//   2. error-resolution     — validation_error_seen → validation_jump clicks,
//                             per episode (a new "seen" opens an episode)
//   3. cast→deploy rate     — deploy events / cast events (per packId+docId
//                             pairs; a deploy without a prior cast still counts
//                             in the denominator as an honest miss)
//
//   node scripts/aggregate-studio-metrics.mjs metrics.json
//
// Nothing here talks to a server: the ring is user-local by design.

import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/aggregate-studio-metrics.mjs <metrics.json>");
  process.exit(1);
}

let events;
try {
  events = JSON.parse(readFileSync(file, "utf8"));
} catch (err) {
  console.error(`cannot read ${file}: ${err.message}`);
  process.exit(1);
}
if (!Array.isArray(events)) {
  console.error("expected a JSON array of metric events");
  process.exit(1);
}
const byDoc = new Map();
for (const e of events) {
  if (!e || typeof e !== "object" || !e.type) continue;
  const list = byDoc.get(e.docId) ?? [];
  list.push(e);
  byDoc.set(e.docId, list);
}

// 1) time-to-first-emit (ms), per document with both a create and an emit.
const ttfe = [];
for (const list of byDoc.values()) {
  const created = list.find((e) => e.type === "doc_created");
  const firstEmit = list.find((e) => e.type === "emit");
  if (created && firstEmit && firstEmit.at >= created.at) ttfe.push(firstEmit.at - created.at);
}
const median = (xs) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
};
const fmtMs = (ms) => (ms == null ? "n/a" : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${(ms / 60_000).toFixed(1)}m`);

// 2) error-resolution clicks: episodes opened by validation_error_seen; each
// validation_jump inside the episode window (until the next seen) counts.
let episodes = 0;
let jumps = 0;
for (const list of byDoc.values()) {
  const sorted = [...list].sort((a, b) => a.at - b.at);
  let open = false;
  for (const e of sorted) {
    if (e.type === "validation_error_seen") {
      if (open) jumps += 0; // a re-seen without a jump closes nothing — honest
      episodes += 1;
      open = true;
    } else if (e.type === "validation_jump" && open) {
      jumps += 1;
      open = false; // one jump closes the episode (the user reached the field)
    }
  }
}
const rate = episodes > 0 ? `${((jumps / episodes) * 100).toFixed(0)}%` : "n/a";

// 3) cast→deploy conversion: a deploy counts when its docId has a cast at or
// before it. The denominator counts distinct cast events (reseals included —
// each is a real publish the owner then chose to deploy or not).
let casts = 0;
let deploys = 0;
for (const [, list] of byDoc) {
  let castAt = -Infinity;
  for (const e of [...list].sort((a, b) => a.at - b.at)) {
    if (e.type === "cast") {
      casts += 1;
      castAt = e.at;
    } else if (e.type === "deploy" && e.at >= castAt) {
      deploys += 1;
      castAt = -Infinity; // one deploy consumes the conversion
    }
  }
}
const conversion = casts > 0 ? `${((deploys / casts) * 100).toFixed(0)}%` : "n/a";

console.log(`events: ${events.length} across ${byDoc.size} document(s)`);
console.log(`1. time-to-first-emit: median ${fmtMs(median(ttfe))} (n=${ttfe.length})`);
console.log(`2. error-resolution jumps: ${jumps}/${episodes} episodes (${rate})`);
console.log(`3. cast→deploy conversion: ${deploys}/${casts} (${conversion})`);
