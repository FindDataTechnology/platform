// ── Offline market snapshot generator (add-supply-catalog-unification 3.1) ──
//
// Regenerates the bundled `market-catalog.json` / `market-catalog-skills.json`
// as GENERATED offline snapshots of the unified supply catalog (facet catalog
// API family): the gateway-sourced MCP servers and registry-sourced skills,
// as-of stamped. A 壹座 with no catalog source configured serves these alone
// (beside its app-shipped starter floor — market-starters*.json, which this
// script never touches).
//
// Run:  node scripts/export-market-snapshot.mjs [--base <facet-url>]
//       [--out <dir>] [--token <internal-token>] [--fixture <file>]
//
// Gates (fail = non-zero exit, zero artifacts written):
//   S1 transport — every generated MCP entry carries a gateway `url` (a
//                  snapshot that lost the endpoint cannot install);
//   S2 as-of     — both files carry `_meta.as_of` + `_meta.source`;
//   S3 trio      — the served market keeps its zero-config starter floor
//                  (fetch/time/everything stdio entries stay in
//                  market-starters.json; this script asserts that file
//                  still carries ≥3 requiresConfig===false servers, since
//                  the invariant moved from the catalog copy to the floor).
import fs from "node:fs";
import path from "node:path";

const DEFAULT_BASE = process.env.FACET_BASE || "https://facet.finddatatech.cloud";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function fetchJson(url, token) {
  const res = await fetch(url, {
    headers: { accept: "application/json", ...(token ? { "x-facet-internal-token": token } : {}) },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

// facet mcp-catalog row → market MCP entry (gateway configTemplate, the same
// shape the registry bridge produces, so requiresConfig derivation classifies
// it as needing the user's gateway token).
function mapMcpRow(r) {
  if (!r?.name) return null;
  const url = r.endpoint || "";
  return {
    name: r.name,
    displayName: r.displayName || r.name,
    description: r.description || "",
    category: "Catalog",
    icon: "box",
    configTemplate: { url, headers: { Authorization: "Bearer <your_token>" } },
    installInstructions: "Served through your MCP gateway. Fill in your gateway access token.",
    origin: "facet-catalog",
    groups: Array.isArray(r.requiredGroups) ? r.requiredGroups : [],
    ...(r.annotations ? { annotation: r.annotations } : {}),
  };
}

// facet skills-catalog row → market skill entry. Content is fetched at install
// time through the catalog face by NAME (facet proxies the registry), so no
// contentPath rides the snapshot.
function mapSkillRow(r) {
  if (!r?.name) return null;
  return {
    name: r.name,
    displayName: r.displayName || r.name,
    description: r.description || "",
    category: "Catalog",
    icon: "file-text",
    origin: "facet-catalog",
    groups: Array.isArray(r.requiredGroups) ? r.requiredGroups : [],
    repositoryUrl: r.repositoryUrl ?? null,
    author: r.author ?? null,
    version: r.version ?? null,
    tags: Array.isArray(r.tags) ? r.tags : [],
    ...(r.annotations ? { annotation: r.annotations } : {}),
  };
}

function isPlaceholderValue(v) {
  return typeof v === "string" && (/\/path\//.test(v) || /your_/.test(v) || /<[^<>]+>/.test(v));
}

function requiresConfig(template) {
  if (!template) return false;
  if (Object.keys(template.env || {}).length > 0) return true;
  if (Object.values(template.headers || {}).some(isPlaceholderValue)) return true;
  return (template.args || []).some((a) => isPlaceholderValue(String(a)));
}

async function main() {
  const fixturePath = arg("fixture", null);
  const base = arg("base", DEFAULT_BASE).replace(/\/+$/, "");
  const token = arg("token", process.env.FACET_CATALOG_TOKEN || "");
  const outDir = arg("out", ".");

  let mcpDoc, skillDoc;
  if (fixturePath) {
    const fx = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
    mcpDoc = fx.mcpCatalog ?? { servers: [] };
    skillDoc = fx.skillsCatalog ?? { skills: [] };
  } else {
    [mcpDoc, skillDoc] = await Promise.all([
      fetchJson(`${base}/api/mcp-catalog?locale=zh-CN`, token),
      fetchJson(`${base}/api/skills-catalog?locale=zh-CN`, token),
    ]);
  }

  const mcpServers = (mcpDoc.servers ?? []).map(mapMcpRow).filter(Boolean);
  const skills = (skillDoc.skills ?? []).map(mapSkillRow).filter(Boolean);

  // S1: gateway transport integrity.
  for (const s of mcpServers) {
    if (!s.configTemplate?.url) {
      console.error(`[snapshot] S1 fail: "${s.name}" has no gateway url`);
      process.exit(1);
    }
  }

  // S3: the starter floor still carries the zero-config trio (the invariant
  // moved from the catalog copy to the floor — assert it at generation time).
  const startersFile = path.join(outDir, "market-starters.json");
  if (fs.existsSync(startersFile)) {
    const starters = JSON.parse(fs.readFileSync(startersFile, "utf8")).mcpServers ?? [];
    const zero = starters.filter((s) => !requiresConfig(s.configTemplate));
    if (zero.length < 3) {
      console.error(`[snapshot] S3 fail: starter floor has ${zero.length} zero-config servers (<3)`);
      process.exit(1);
    }
  }

  const asOf = new Date().toISOString();
  const meta = { as_of: asOf, source: "supply-catalog", base: fixturePath ? "fixture" : base };
  fs.writeFileSync(path.join(outDir, "market-catalog.json"), `${JSON.stringify({ _meta: meta, mcpServers }, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, "market-catalog-skills.json"), `${JSON.stringify({ _meta: meta, skills }, null, 2)}\n`);
  console.log(`[snapshot] wrote market-catalog.json (${mcpServers.length} servers) + market-catalog-skills.json (${skills.length} skills) as_of ${asOf}`);
}

main().catch((err) => {
  console.error(`[snapshot] failed: ${err.message}`);
  process.exit(1);
});
