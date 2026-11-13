// M1 exit-criterion re-measurement probe (weekly-active packs ≥5).
// Two telemetry lanes, cross-checked:
//   1. gateway /api/ops/pack-usage — per-cell SQLite aggregate over ALL cells
//      (chat-lane turns through the platform gateway);
//   2. wanxing facade wanxing_usage — the A2A billing ledger (per-agent turns
//      with outcome, the settlement input).
// Pack IDs resolve to names + author through the facet packs.db; facade slugs
// map to packIds by lowercase prefix (slug = "packs-" + lower(packId) + "-" +
// lower(agentId) — the slugFor discipline). Read-only everywhere.
// Run: node scripts/probe-m1-weekly-active.mjs [days]
import { execFileSync } from "node:child_process";

const days = Number(process.argv[2]) || 7;
const CTX = "cheap";
const NS = "fd-prod";
const kexec = (pod, args) => execFileSync("kubectl", ["--context", CTX, "exec", "-n", NS, pod, "--", ...args], { encoding: "utf8" });
const podFor = (label) =>
  execFileSync("kubectl", ["--context", CTX, "-n", NS, "get", "pods", "-l", `app.kubernetes.io/name=${label}`, "-o", "jsonpath={.items[0].metadata.name}"], { encoding: "utf8" }).trim();

const platformPod = podFor("platform");
const facetPod = podFor("facet");
const facadePod = podFor("wanxing-facade");

// ── lane 1: gateway aggregate ───────────────────────────────────────────────
const token = kexec(platformPod, ["printenv", "PACK_USAGE_TOKEN"]).trim();
const usage = JSON.parse(kexec(platformPod, ["curl", "-s", "--max-time", "30", "-H", `Authorization: Bearer ${token}`, `http://127.0.0.1:3100/api/ops/pack-usage?days=${days}`]));

// ── pack table (facet packs.db): id → {name, author, category, visibility} ──
const packsScript = `
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/data/facet/packs.db', { readOnly: true });
const rows = db.prepare('SELECT id, author_email, category, visibility FROM packs').all();
const out = {};
for (const p of rows) {
  const v = db.prepare('SELECT name FROM pack_versions WHERE pack_id = ? ORDER BY published_at DESC LIMIT 1').get(p.id);
  out[p.id] = { name: v?.name ?? null, author: p.author_email, category: p.category || null, visibility: p.visibility };
}
console.log(JSON.stringify(out));
`;
const packs = JSON.parse(kexec(facetPod, ["node", "-e", packsScript]));
const packIds = Object.keys(packs);

// ── lane 2: facade billing ledger, per slug with caller breakdown ───────────
const usageScript = `
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/data/wanxing.db', { readOnly: true });
const since = Date.now() - ${days} * 86400000;
const rows = db.prepare("SELECT agent_slug, COUNT(*) AS turns, SUM(CASE WHEN outcome='ok' THEN 1 ELSE 0 END) AS ok, GROUP_CONCAT(DISTINCT caller_email) AS callers FROM wanxing_usage WHERE started_at >= ? GROUP BY agent_slug ORDER BY turns DESC").all(since);
console.log(JSON.stringify(rows));
`;
const facadeRows = JSON.parse(kexec(facadePod, ["node", "-e", usageScript]));

const pidForSlug = (slug) => {
  for (const id of packIds) if (slug.startsWith(`packs-${id.toLowerCase()}-`)) return id;
  return null;
};

// ── report ──────────────────────────────────────────────────────────────────
console.log(`window=${days}d  cells=${usage.cells}  gateway.weeklyActivePacks=${usage.weeklyActivePacks}`);
console.log("\n[gateway lane] packId | name | author | turns | users");
for (const r of usage.rows) {
  const m = r.packId ? packs[r.packId] : null;
  console.log(`${r.packId ?? "(packless)"} | ${m?.name ?? "-"} | ${m?.author ?? "-"} | ${r.turns} | ${r.activeUsers}`);
}

console.log("\n[facade lane] slug | pack | name | author | turns | ok | callers");
for (const r of facadeRows) {
  const id = pidForSlug(r.agent_slug);
  const m = id ? packs[id] : null;
  console.log(`${r.agent_slug} | ${id ?? "UNRESOLVED"} | ${m?.name ?? "-"} | ${m?.author ?? "-"} | ${r.turns} | ${r.ok} | ${r.callers}`);
}

const union = new Map(); // packId → {gw: bool, a2a: bool, calls: Set}
for (const r of usage.rows) if (r.packId) union.set(r.packId, { gw: true, a2a: false, callers: new Set() });
for (const r of facadeRows) {
  const id = pidForSlug(r.agent_slug);
  if (!id) continue;
  const u = union.get(id) ?? { gw: false, a2a: false, callers: new Set() };
  u.a2a = true;
  for (const c of String(r.callers ?? "").split(",")) u.callers.add(c);
  union.set(id, u);
}
console.log(`\n[union] distinct packs with weekly activity = ${union.size}`);
for (const [id, u] of union) {
  const m = packs[id];
  console.log(`${id} | ${m?.name ?? "-"} | ${m?.author ?? "-"} | ${u.gw ? "gateway" : ""}${u.gw && u.a2a ? "+" : ""}${u.a2a ? "a2a" : ""} | callers: ${[...u.callers].join(", ") || "-"}`);
}
