#!/usr/bin/env node
// ── Live probe: per-cell MCP satellite footprint (share-mcp-satellites 4.2) ──
//
// The change's whole payoff is 「卫星按 cell 一份，而不是按 dsh 一份」. Proving it
// needs two readings of the SAME deployment:
//
//   baseline (cap=0)  → every cell has 1 dsh  → N satellites per cell
//   window   (cap=1)  → a cell with 2 dsh     → still N satellites per cell
//                                              (was 2N before the change)
//
// This probe prints exactly those numbers from inside the running pod, by
// running the image's own sampler against the live /proc — no HTTP, no auth, no
// writes. Run it before and after flipping `TASK_WORKER_MAX`, and diff the two
// "cells" blocks.
//
//   node scripts/probe-satellite-sharing.mjs                 # fd-prod/platform
//   POD=platform-xxxx node scripts/probe-satellite-sharing.mjs
//   node scripts/probe-satellite-sharing.mjs --json           # one JSON line
//
// Exit 0 = sampled; 1 = could not reach a pod or the sampler said unavailable.

import { execFileSync } from "node:child_process";

const NAMESPACE = process.env.NS || "fd-prod";
const JSON_ONLY = process.argv.includes("--json");
const MiB = 1024 * 1024;

function kubectl(args, opts = {}) {
  return execFileSync("kubectl", args, { encoding: "utf8", maxBuffer: 8 * MiB, ...opts }).trim();
}

function platformPod() {
  if (process.env.POD) return process.env.POD;
  const names = kubectl(["-n", NAMESPACE, "get", "pods", "-o", "name"])
    .split("\n")
    .map((l) => l.replace(/^pod\//, ""))
    // The production deployment is `platform-…`; `platform-demo-…` is the demo
    // line and has no worker pool at all.
    .filter((n) => n.startsWith("platform-") && !n.startsWith("platform-demo-"));
  const running = names.filter((n) => {
    try {
      return kubectl(["-n", NAMESPACE, "get", "pod", n, "-o", "jsonpath={.status.phase}"]) === "Running";
    } catch {
      return false;
    }
  });
  if (!running.length) throw new Error(`no running platform pod in ${NAMESPACE}`);
  return running[0];
}

// The sampler is the product's own reader (lib/proc-memory.js), so the probe and
// the memory face can never disagree about what a "satellite" is.
const SAMPLER = `
import("/app/lib/proc-memory.js").then((m) => {
  const s = m.createProcMemorySampler({}).sample();
  if (!s.available) { console.log(JSON.stringify({ available: false, reason: s.reason })); return; }
  const cells = (s.cells || []).map((c) => {
    const sats = c.processes.filter((p) => p.role === "mcp-satellite");
    return {
      cell: c.cellId,
      dsh: c.processes.filter((p) => p.role === "dsh-runtime").length,
      satellites: sats.length,
      satelliteBytes: sats.reduce((a, p) => a + p.rssBytes, 0),
      totalBytes: c.totalBytes,
    };
  });
  console.log(JSON.stringify({ available: true, buckets: s.buckets, cells }));
}).catch((e) => { console.log(JSON.stringify({ available: false, reason: String(e && e.message || e) })); });
`;

function main() {
  const pod = platformPod();
  // Plain $VAR (no braces): the SHELL expands this, and biome rightly flags
  // `${…}` inside a non-template string as a probable JS mistake.
  const env = kubectl([
    "-n", NAMESPACE, "exec", pod, "-c", "platform", "--",
    "sh", "-c", "echo CAP=$TASK_WORKER_MAX; echo CELLS=$MCP_SATELLITE_HOST_CELLS",
  ])
    .split("\n")
    .map((l) => l.replace(/=$/, "=<unset>"))
    .join("\n");
  const raw = kubectl(["-n", NAMESPACE, "exec", pod, "-c", "platform", "--", "node", "-e", SAMPLER]);
  const last = raw.split("\n").filter((l) => l.trim().startsWith("{")).pop();
  if (!last) throw new Error(`sampler produced no JSON: ${raw.slice(0, 200)}`);
  const sample = JSON.parse(last);
  if (!sample.available) throw new Error(`sampler unavailable: ${sample.reason}`);

  const rows = sample.cells
    .map((c) => ({
      cell: c.cell.slice(0, 8),
      dsh: c.dsh,
      sats: c.satellites,
      satMi: Math.round(c.satelliteBytes / MiB),
      totalMi: Math.round(c.totalBytes / MiB),
    }))
    .sort((a, b) => b.totalMi - a.totalMi);

  if (JSON_ONLY) {
    console.log(JSON.stringify({ pod, env: env.split("\n"), buckets: sample.buckets, cells: rows }));
    return;
  }

  console.log(`pod: ${pod}  (${env.replace(/\n/g, "  ")})`);
  console.log("");
  console.log("  cell      dsh  satellites  satMi  totalMi  sat/total");
  for (const r of rows) {
    const pct = r.totalMi ? Math.round((r.satMi / r.totalMi) * 100) : 0;
    console.log(
      `  ${r.cell}   ${String(r.dsh).padStart(2)}        ${String(r.sats).padStart(2)}   ${String(r.satMi).padStart(5)}   ${String(r.totalMi).padStart(6)}      ${String(pct).padStart(3)}%`,
    );
  }
  console.log("");
  console.log(`  buckets: ${JSON.stringify(sample.buckets)}`);
  const sats = rows.reduce((a, r) => a + r.sats, 0);
  const dshs = rows.reduce((a, r) => a + r.dsh, 0);
  console.log(`  totals: ${rows.length} cells, ${dshs} dsh, ${sats} satellites`);
  // The comparison line the window is judged on: satellites per dsh. With the
  // change it stays ~flat as dsh count rises; without it, it scales with dsh.
  console.log(`  satellites per dsh: ${dshs ? (sats / dshs).toFixed(2) : "n/a"}`);
}

try {
  main();
} catch (err) {
  console.error(`probe-satellite-sharing: FAIL — ${err?.message || err}`);
  process.exit(1);
}
