// capability-catalog-client.js — the read contract to fd-capability-catalog
// (change: wire-capability-catalog-into-pack-assembly, design D3).
//
// paas is Node, the catalog is Python; the bridge is a subprocess to the
// `capability-catalog` CLI (the directory has a console_scripts entry). This
// module is the ONE place that knows how to reach the catalog:
//
//   CAPABILITY_CATALOG_CMD   default "capability-catalog"
//   CAPABILITY_CATALOG_DB    the catalog SQLite path
//
// Honest interface note (2026-11-22): the catalog CLI's `list` today emits
// provider NAMES (`served_by: ["fd-open-data-mcp"]`), not the `(server, tool)`
// edges this check needs. The CLI needs a way to emit edges before the LIVE
// loader can work. So `makeCatalogLoader` fails closed with a clear error until
// the catalog exposes them — it does NOT return an empty map that would read as
// "every ref is missing" (indistinguishable from a real all-missing catalog).
// The check LOGIC is fully unit-tested against an injected loader meanwhile.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const CMD = () => process.env.CAPABILITY_CATALOG_CMD || "capability-catalog";
const DB = () => process.env.CAPABILITY_CATALOG_DB || "";

//: The catalog CLI ships a `serving` command (capability -> [[server,tool],...])
//: as of fd-capability-catalog (2026-11-22). Set to the CLI verb name.
const SERVING_VERB = "serving";

function _run(args, { timeoutMs = 8000 } = {}) {
  return execFileAsync(CMD(), args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
}

async function _resolveEffective(db, serverAccessJson) {
  if (!serverAccessJson) return null; // admin / no governor -> no restriction
  const { stdout } = await _run(["--db", db, "resolve", "--agent", serverAccessJson]);
  const res = JSON.parse(stdout);
  return Array.isArray(res.effective) ? res.effective : [];
}

/**
 * Build the loader checkCapabilityRefs expects.
 *
 * @param {object} opts
 * @param {string} [opts.governorServerAccess] JSON of the governor's
 *        server_access list; omit for admin/full view.
 * @returns {function} async () => {serving, effective}
 */
export function makeCatalogLoader(opts = {}) {
  const db = opts.db || DB();
  const governor = opts.governorServerAccess || null;
  return async () => {
    if (!db) throw new Error("CAPABILITY_CATALOG_DB not configured");
    const { stdout } = await _run(["--db", db, SERVING_VERB]);
    const serving = JSON.parse(stdout); // capability -> [[server,tool],...]
    const effective = await _resolveEffective(db, governor);
    return { serving, effective };
  };
}