#!/usr/bin/env node
// standardize-mcp-public-endpoints task 3.3 — one-shot remediation scanner.
//
// Scans every extension_configs store it can find for MCP install records whose
// config.url points at a deployment-internal position (mesh MagicDNS, tailnet
// CGNAT, loopback/private literals). Matching records are rewritten in place to
// the gateway endpoint derived from the registry path — idempotent: gateway-form
// URLs are skipped, so re-running is a no-op.
//
// Usage (in a pod that has the DB mounted):
//   node mcp-endpoint-remediate.mjs            # dry-run: report only
//   APPLY=1 node mcp-endpoint-remediate.mjs    # rewrite matching rows
//
// 2026-11-04 production scan result (dry-run): zero matching rows across
// platform /data/data/app.db (8 mcp rows), platform-demo app.db (8), all cell
// packs.db / trace.db / mcp.json overlays — no rewrite needed; the leak window
// closed when the registry's mcp_endpoint fields were nulled (task 1.3).

import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";

const APPLY = process.env.APPLY === "1";
const INTERNAL_URL_PATTERN =
  /^https?:\/\/([^/]*mesh\.finddata\.cn|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|127\.\d+\.\d+\.\d+|localhost)(:\d+)?/i;

// pathToName mirrors paas/registry-bridge.js: "/fd-info" → "fd-info"
const pathToName = (p) => String(p || "").split("/").filter(Boolean).join("-");

// Installed name → registered path, for installs whose name predates or
// diverges from the registry path (verified against the 2026-11-04 registry
// dump; anything not listed derives from the name itself).
const NAME_TO_PATH = {
  "facet-market": "facet-market-mcp",
  "lex-ops": "lex-ops-mcp",
  "paper-trading": "fd-paper-trading",
  "wanxing-ops": "wanxing-ops-mcp",
  "wire-ops": "wire-ops-mcp",
};

// Locally-served per-tenant services that were never registry leaks — a
// rewrite would break them. open-connector runs inside each cell on 44315.
const SKIP_NAMES = new Set(["open-connector"]);

const REGISTRY_URL =
  process.env.MARKET_REGISTRY_URL ||
  process.env.REGISTRY_URL ||
  "https://mcp.finddatatech.cloud";

function findDbs(root, depth = 0, out = []) {
  if (depth > 4) return out;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) findDbs(p, depth + 1, out);
    else if (e.name === "app.db") out.push(p);
  }
  return out;
}

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const roots = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["/data/data", "/data/cells"];
const dbFiles = roots.flatMap((r) => findDbs(r));

let scanned = 0;
let hits = 0;
for (const file of dbFiles) {
  let db;
  try {
    db = new Database(file, { readonly: !APPLY });
  } catch (e) {
    console.log(`skip ${file}: ${e.message.slice(0, 60)}`);
    continue;
  }
  try {
    const has = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='extension_configs'")
      .get();
    if (!has) continue;
    const rows = db.prepare("SELECT id, name, config_json FROM extension_configs WHERE type='mcp'").all();
    const update = db.prepare("UPDATE extension_configs SET config_json = ?, updated_at = ? WHERE id = ?");
    for (const row of rows) {
      scanned += 1;
      let cfg;
      try {
        cfg = JSON.parse(row.config_json);
      } catch {
        continue;
      }
      const url = cfg?.url;
      if (typeof url !== "string" || !INTERNAL_URL_PATTERN.test(url)) continue;
      if (SKIP_NAMES.has(row.name)) continue;
      hits += 1;
      const regName = NAME_TO_PATH[row.name] ?? pathToName(row.name);
      const gateway = `${REGISTRY_URL}/${regName}/mcp`;
      console.log(`${APPLY ? "REWRITE" : "WOULD REWRITE"} ${file} ${row.name}: ${url} -> ${gateway}`);
      if (APPLY) {
        cfg.url = gateway;
        update.run(JSON.stringify(cfg), new Date().toISOString(), row.id);
      }
    }
  } finally {
    db.close();
  }
}
console.log(`${APPLY ? "APPLIED" : "DRY-RUN"}: scanned ${scanned} mcp records in ${dbFiles.length} dbs, ${hits} internal-form${APPLY ? " rewritten" : ""}`);
if (hits && !APPLY) process.exitCode = 1;
