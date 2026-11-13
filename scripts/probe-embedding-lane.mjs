// Embedding lane health probe (2026-10-29, §15.79 续二).
//
// The vector rung degrades SILENTLY: when the embeddings upstream answers 429 /
// 503, the gateway filters the only account in the group, returns 503, and
// fd-memory falls back to keyword recall. Nothing errors, nothing alerts — the
// digest simply stops using vectors. Twice now that silence cost hours:
//   2026-10-28  both embedding accounts bound to dead proxy 35
//   2026-10-29  group 8 held a single account; one upstream 429 emptied the pool
//
// This probe makes the degradation LOUD. It reads fd-memory's own
// /admin/metrics counters (digest.vector_ratio, embed.failed) and the
// vector store, then exits non-zero when the vector rung is not carrying its
// share — so a cron / drill can gate on it instead of waiting for a human to
// notice recall got worse.
//
//   node scripts/probe-embedding-lane.mjs
//   FD_MEMORY_URL=http://… FD_MEMORY_TOKEN=… node scripts/probe-embedding-lane.mjs
//
// Env:
//   FD_MEMORY_URL        base URL of the fd-memory service (default: distill URL host)
//   FD_MEMORY_TOKEN      platform/runner token for /admin/metrics (required for metrics gate)
//   EMBED_MIN_VECTOR_RATIO  minimum acceptable digest vector ratio (default 0.9)
//   EMBED_MAX_FAIL_RATE     maximum acceptable embed failure rate (default 0.2)
//   EMBED_PROBE_SKIP_METRICS=1  skip the metrics gate (vector-store check only)
//
// Exit codes: 0 healthy · 1 degraded · 2 cannot evaluate (config/transport).
//
// Read-only: it never writes a vector, never mints, never mutates.

const env = process.env;
const BASE = (env.FD_MEMORY_URL || "").replace(/\/+$/, "");
const TOKEN = env.FD_MEMORY_TOKEN || env.DISTILLER_SHARED_TOKEN || "";
const MIN_VECTOR_RATIO = Number(env.EMBED_MIN_VECTOR_RATIO ?? 0.9);
const MAX_FAIL_RATE = Number(env.EMBED_MAX_FAIL_RATE ?? 0.2);
const SKIP_METRICS = env.EMBED_PROBE_SKIP_METRICS === "1";

const problems = [];
const notes = [];

function fail(msg) {
  problems.push(msg);
}

function pct(n) {
  return `${(n * 100).toFixed(1)}%`;
}

// ── 0. Live probe (the real gate) ─────────────────────────────────────────
// Cumulative counters CANNOT be the gate: they never recover, so one past
// incident pins vector_ratio low forever and the probe cries wolf after the
// lane is healthy again (measured 2026-10-29: 71.4% persisted after recovery).
// The honest question is "is it degraded RIGHT NOW", which only a live call
// answers: /digest attaches model_note exactly when it fell back to keyword.
async function checkLiveDigest() {
  const rootKey = env.EMBED_PROBE_ROOT_KEY || "";
  const project = env.EMBED_PROBE_PROJECT || "memory";
  if (!rootKey) {
    notes.push("no EMBED_PROBE_ROOT_KEY — live digest probe not run (gate is weaker)");
    return null;
  }
  if (!BASE || !TOKEN) {
    notes.push("no FD_MEMORY_URL/TOKEN — live digest probe not run");
    return null;
  }
  // q is REQUIRED: without it /digest takes the blank-query path, which has no
  // vector to compute and therefore says nothing about the embed lane. A probe
  // that omits q measures the empty-query rung and reports its own mistake as
  // an outage (learned the hard way 2026-10-29).
  const probeQuery = env.EMBED_PROBE_QUERY || "health probe vector recall check";
  const url = `${BASE}/digest?rootKey=${encodeURIComponent(rootKey)}&project=${encodeURIComponent(project)}&k=3&q=${encodeURIComponent(probeQuery)}`;
  let res;
  try {
    res = await fetch(url, {
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    notes.push(`live digest unreachable: ${e?.message ?? e}`);
    return null;
  }
  if (!res.ok) {
    // A failing digest request is itself a signal (auth/quota/clamp), but it is
    // not the vector rung's fault — report it separately.
    notes.push(`live digest http ${res.status} — cannot judge rung`);
    return null;
  }
  const j = await res.json();
  const degraded = typeof j.model_note === "string" && j.model_note.length > 0;
  if (degraded) {
    fail(`live digest fell back to keyword recall: ${String(j.model_note).slice(0, 160)}`);
  } else {
    notes.push("live digest served from the vector rung (ok)");
  }
  return { degraded, model_note: j.model_note ?? null, items: j.items ?? 0 };
}

// ── 1. Metrics (informational) ────────────────────────────────────────────
// digest.vector_ratio and embed.failure_reasons are cumulative since process
// start, so they describe HISTORY, not current health. They explain WHY a
// degradation happened; they must not fail the probe on their own.
async function checkMetrics() {
  if (SKIP_METRICS) {
    notes.push("metrics gate skipped (EMBED_PROBE_SKIP_METRICS=1)");
    return null;
  }
  if (!BASE) {
    notes.push("no FD_MEMORY_URL — cannot reach /admin/metrics");
    return null;
  }
  if (!TOKEN) {
    // A missing token is a configuration gap, not a degradation: say so
    // distinctly so the operator does not read it as "lane is down".
    notes.push("no FD_MEMORY_TOKEN — metrics gate not evaluated");
    return null;
  }
  let res;
  try {
    res = await fetch(`${BASE}/admin/metrics`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    notes.push(`metrics unreachable: ${e?.message ?? e}`);
    return null;
  }
  if (!res.ok) {
    notes.push(`metrics http ${res.status}`);
    return null;
  }
  const m = await res.json();
  const digest = m.digest ?? {};
  const embed = m.embed ?? {};
  const total = Number(digest.total ?? 0);
  const ratio = digest.vector_ratio == null ? null : Number(digest.vector_ratio);
  const samples = Number(embed.samples ?? 0);
  const failed = Number(embed.failed ?? 0);
  const failRate = samples ? failed / samples : 0;

  if (total === 0) {
    // No digest traffic since restart: nothing to judge. Restarting the pod
    // resets these counters, so a quiet window is not evidence of health OR
    // of breakage.
    notes.push("no digest traffic since process start (counters reset on restart) — inconclusive");
  } else if (ratio != null) {
    const detail = `vector=${digest.vector ?? 0} keyword=${digest.keyword ?? 0} cooling=${digest.cooling ?? 0}`;
    if (ratio < MIN_VECTOR_RATIO) {
      notes.push(
        `HISTORICAL: digest vector ratio ${pct(ratio)} of ${total} (${detail}) — ` +
          `an embed incident happened since process start; live probe decides if it is still degraded`,
      );
    } else {
      notes.push(`digest vector ratio ${pct(ratio)} of ${total} (ok)`);
    }
  }

  if (samples > 0) {
    const reasons = embed.failure_reasons ?? {};
    const top = Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const tail = top.length ? `; top: ${top.map(([r, n]) => `${r}×${n}`).join(", ")}` : "";
    if (failRate > MAX_FAIL_RATE) {
      notes.push(`HISTORICAL: embed failures ${failed}/${samples} (${pct(failRate)})${tail}`);
    } else {
      notes.push(`embed failures ${failed}/${samples} (ok)${tail}`);
    }
  }
  return { digest, embed };
}

// ── 2. Vector store gate ──────────────────────────────────────────────────
// Model mixing is the failure that destroys retrieval without any error:
// page_vectors filtered by model means a second model silently strands history.
// This gate reports the model set; more than one model is a hard fail.
async function checkVectorStore() {
  const dataDir = env.FD_MEMORY_DATA;
  if (!dataDir) {
    notes.push("no FD_MEMORY_DATA — vector store not inspected");
    return null;
  }
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    notes.push("node:sqlite unavailable — vector store not inspected");
    return null;
  }
  const fs = await import("node:fs");
  const path = await import("node:path");

  const ownersDir = path.join(dataDir, "owners");
  if (!fs.existsSync(ownersDir)) {
    notes.push(`no owners dir under ${dataDir}`);
    return null;
  }
  const totals = {};
  let multiModelRoots = 0;
  let rootsWithVectors = 0;
  let scanned = 0;

  for (const root of fs.readdirSync(ownersDir)) {
    const dbPath = path.join(ownersDir, root, "db", "memory.sqlite");
    if (!fs.existsSync(dbPath)) continue;
    scanned += 1;
    let db;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const rows = db.prepare("SELECT model, COUNT(*) n FROM page_vectors GROUP BY model").all();
      if (!rows.length) continue;
      rootsWithVectors += 1;
      for (const r of rows) totals[r.model] = (totals[r.model] ?? 0) + Number(r.n);
      if (rows.length > 1) {
        multiModelRoots += 1;
        fail(
          `root ${root} holds ${rows.length} embedding models ` +
            `(${rows.map((r) => `${r.model}:${r.n}`).join(", ")}) — vectors from mixed ` +
            `spaces make cosine similarity meaningless`,
        );
      }
    } catch (e) {
      notes.push(`root ${root}: cannot read vectors (${e?.message ?? e})`);
    } finally {
      try { db?.close(); } catch {}
    }
  }

  const models = Object.keys(totals);
  if (models.length > 1) {
    fail(
      `vector store spans ${models.length} models: ` +
        models.map((m) => `${m}=${totals[m]}`).join(", ") +
        ` — every model is its own vector space`,
    );
  } else if (models.length === 1) {
    notes.push(`all ${Object.values(totals)[0]} vectors on ${models[0]} across ${rootsWithVectors} roots (ok)`);
  } else {
    notes.push(`no vectors found in ${scanned} scanned roots`);
  }
  return { models, totals, multiModelRoots, rootsWithVectors };
}

// ── main ───────────────────────────────────────────────────────────────────
const live = await checkLiveDigest();
const metrics = await checkMetrics();
const vectors = await checkVectorStore();

const report = {
  url: BASE || null,
  live_probe: live ? (live.degraded ? "degraded" : "vector") : "not_run",
  metrics_evaluated: metrics != null,
  vectors_evaluated: vectors != null,
  notes,
  problems,
};
console.log(JSON.stringify(report, null, 2));

if (problems.length > 0) {
  console.error(`\nDEGRADED: ${problems.length} problem(s)`);
  for (const p of problems) console.error(`  · ${p}`);
  process.exit(1);
}
if (!live && !metrics && !vectors) {
  console.error("\nCANNOT EVALUATE: no live probe, no metrics, no vector store");
  process.exit(2);
}
if (!live) {
  // Without the live probe the gate rests on cumulative counters, which do not
  // recover. Say so loudly: a green result here is weaker evidence.
  console.error("\nWEAK PASS: vector rung not verified live — set EMBED_PROBE_ROOT_KEY");
}
console.log("\nHEALTHY: vector rung intact");
