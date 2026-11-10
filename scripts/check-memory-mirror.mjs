// Single-writer discipline sampler (openspec: add-unified-memory-and-outputs,
// task 5.3).
//
// Truth for tier/tags lives in the fd-memory reference page; the resources row
// only carries a mirror. A gesture that writes one side and not the other, or a
// pod that died mid-mirror, leaves silent drift — and drift is invisible in both
// read faces because each face believes its own copy. This script samples the
// two sides and prints every disagreement:
//
//   · mirror row has tier/tags but no page (write landed locally, truth lost)
//   · page missing for a row that claims a reference (page forgotten/deleted)
//   · tier or tag set differs between row and page (mirror went stale)
//   · memoryRefPath outside the reference lane (a row pointing at prose)
//
// Read-only, exit 1 on drift so it can gate a cron/drill.
//
//   node scripts/check-memory-mirror.mjs            # uses the cell's own DB + env
//   OWNER=aloadtree@gmail.com DB_PATH=… node …
//
// In a production pod it needs the same env the platform already has:
// CELL_MEMORY_URL / CELL_MEMORY_PLATFORM_TOKEN, plus MEMORY_MIRROR_OWNER.

import path from "node:path";

const LANE = /(^|\/)references\/r-[A-Za-z0-9_-]+\.md$/;

function normTags(raw) {
  if (Array.isArray(raw)) return raw.map(String).sort();
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String).sort() : [];
  } catch {
    return [];
  }
}

async function fetchPages({ base, token, rootKey, project, fetchImpl }) {
  const out = [];
  for (let offset = 0; ; offset += 200) {
    const qs = new URLSearchParams({ project, limit: "200", offset: String(offset) });
    const url = `${base}/memory?rootKey=${encodeURIComponent(rootKey)}&${qs}`;
    const r = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`/memory HTTP ${r.status}`);
    const body = await r.json();
    const items = Array.isArray(body.items) ? body.items : [];
    out.push(...items);
    if (items.length < 200) break;
  }
  return out;
}

// Pure comparison: rows (db shape) × pages (fd-memory items) → drift list.
export function diffMirror(rows, pages) {
  const byPath = new Map(pages.map((p) => [p.path, p]));
  const drift = [];
  for (const row of rows) {
    const tags = normTags(row.tags);
    const tier = row.tier ?? "draft";
    const claimed = row.memoryRefPath ?? null;
    const touched = claimed !== null || tier !== "draft" || tags.length > 0;
    if (!touched) continue; // never remembered, never graded: nothing to mirror
    if (!claimed) {
      drift.push({ id: row.id, kind: "mirror_without_page", detail: `tier=${tier} tags=[${tags.join(", ")}] but no memoryRefPath` });
      continue;
    }
    if (!LANE.test(claimed)) {
      drift.push({ id: row.id, kind: "path_outside_lane", detail: claimed });
      continue;
    }
    const page = byPath.get(claimed);
    if (!page) {
      drift.push({ id: row.id, kind: "page_missing", detail: claimed });
      continue;
    }
    if ((page.tier ?? "draft") !== tier) {
      drift.push({ id: row.id, kind: "tier_drift", detail: `row=${tier} page=${page.tier ?? "draft"} @${claimed}` });
    }
    const pageTags = normTags(page.tags);
    if (JSON.stringify(pageTags) !== JSON.stringify(tags)) {
      drift.push({ id: row.id, kind: "tags_drift", detail: `row=[${tags.join(", ")}] page=[${pageTags.join(", ")}] @${claimed}` });
    }
  }
  return drift;
}

export async function checkMirror({ db, base, token, rootKey, project = "default", fetchImpl = fetch }) {
  const rows = [];
  for (let offset = 0; ; offset += 200) {
    const page = db.listResources({ limit: 200, offset });
    rows.push(...page.items);
    if (page.items.length < 200) break;
  }
  const pages = await fetchPages({ base, token, rootKey, project, fetchImpl });
  return { rows: rows.length, pages: pages.length, drift: diffMirror(rows, pages) };
}

async function main() {
  const base = String(process.env.CELL_MEMORY_URL || "").replace(/\/+$/, "");
  const token = String(process.env.CELL_MEMORY_PLATFORM_TOKEN || "");
  const owner = String(process.env.MEMORY_MIRROR_OWNER || process.env.CELL_USER_EMAIL || "");
  if (!base || !token || !owner) {
    console.error("需要 CELL_MEMORY_URL / CELL_MEMORY_PLATFORM_TOKEN / MEMORY_MIRROR_OWNER（或 CELL_USER_EMAIL）");
    process.exit(2);
  }
  const db = await import(path.resolve(process.cwd(), "db.js"));
  await db.initDb();
  const rootKey = `u-${owner}`;
  const report = await checkMirror({ db, base, token, rootKey });
  console.log(`[memory-mirror] rows=${report.rows} pages=${report.pages} drift=${report.drift.length} rootKey=${rootKey}`);
  for (const d of report.drift) console.log(`  ! ${d.kind}\t${d.id}\t${d.detail}`);
  process.exit(report.drift.length ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
