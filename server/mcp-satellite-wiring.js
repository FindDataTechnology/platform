// ── Cell-side wiring for the shared MCP satellite host (2.1) ────────────────
//
// The host itself lives in server/mcp-satellite-host.js. This module is the
// boot-time decision a CELL makes about it:
//
//   TASK_WORKER_MAX=0  → do nothing at all. One dsh means the satellites are not
//                        duplicated, and this path must stay byte-identical
//                        (that is also the rollback face).
//   TASK_WORKER_MAX>0  → parse the patch we just wrote, start ONE host for the
//                        shareable servers, then let the caller re-write the
//                        patch (which now emits `url` entries because
//                        MCP_SATELLITE_HOST_URL is set).
//
// Satellite specs come from the COMPOSED PATCH, not from a second copy of the
// composition logic — the patch is the single source of truth for command,
// args, env and cwd, and re-deriving them here is how the two drift apart.
//
// Fail-open: any failure leaves `MCP_SATELLITE_HOST_URL` unset, so the patch
// keeps its stdio entries and the cell behaves exactly as before.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import yaml from "js-yaml";
import { SHARED_SATELLITE_SERVERS } from "../dsh-profile.js";
import { createMcpSatelliteHost } from "./mcp-satellite-host.js";

// Reads the composed patch and returns the specs for the shareable servers.
//
// The AUTHORITY is mcp.shared.json — written by writeMcpPatch with the exact
// set the patch rewrite converted. Deriving the set here instead (any shareable
// name that still has a command) is how the host came to own satellites that
// every dsh also spawns: an envRefs-bearing satellite keeps its stdio entry in
// the patch, so "still has a command" and "was converted" are different sets.
// The fallback keeps directories written by an older image working.
export function satelliteSpecsFromPatch(patchPath) {
  let rows;
  try {
    rows = yaml.load(readFileSync(patchPath, "utf8")) ?? [];
  } catch {
    return [];
  }
  let authoritative = null;
  try {
    const parsed = JSON.parse(readFileSync(join(dirname(patchPath), "mcp.shared.json"), "utf8"));
    if (Array.isArray(parsed?.sharedSatelliteNames)) authoritative = new Set(parsed.sharedSatelliteNames);
  } catch {
    /* older profile dir — fall back to the declared list */
  }
  const inserts = rows.filter((r) => r?.insert).flatMap((r) => r.insert);
  const specs = [];
  for (const row of inserts) {
    const name = row?.config?.serverName;
    if (!name || !SHARED_SATELLITE_SERVERS.includes(name)) continue;
    if (authoritative && !authoritative.has(name)) continue;
    const command = row.config.command;
    if (!command) continue; // already a url entry — nothing to spawn
    specs.push({
      name,
      // A patch may say `node` (the image's PATH node); the host runs inside the
      // cell server, so pin our own binary — PATH in a container is a guess.
      command: command === "node" ? process.execPath : command,
      args: row.config.args ?? [],
      env: { ...process.env, ...(row.config.env ?? {}) },
      cwd: row.config.cwd,
    });
  }
  return specs;
}

// Returns { host, url } on success, or { host: null, url: null } when the pool
// is off, no shareable satellite was found, or the host could not start. The
// caller re-writes the patch only when `url` is non-null.
// Gray switch, mirroring BROWSER_SHARED_CELLS: TASK_WORKER_MAX is deployment-wide,
// so a rollout still has to start with ONE cell. Unset/empty/* = every cell.
export function satelliteHostAllowedForCell(cellEmail, env = process.env) {
  const raw = (env.MCP_SATELLITE_HOST_CELLS || "").trim();
  if (!raw) return true;
  const wanted = raw
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (wanted.includes("*")) return true;
  if (!cellEmail) return false;
  return wanted.includes(String(cellEmail).trim().toLowerCase());
}

export async function startCellSatelliteHost({ patchPath, poolSize, logger = console, env = process.env, cellEmail = null }) {
  if (!(Number(poolSize) > 0)) return { host: null, url: null, reason: "worker pool off" };
  if (String(env.MCP_SATELLITE_HOST ?? "") === "0") return { host: null, url: null, reason: "disabled by MCP_SATELLITE_HOST=0" };
  if (!satelliteHostAllowedForCell(cellEmail, env)) {
    return { host: null, url: null, reason: `cell ${cellEmail ?? "(unknown)"} is not in MCP_SATELLITE_HOST_CELLS` };
  }
  const specs = satelliteSpecsFromPatch(patchPath);
  if (!specs.length) return { host: null, url: null, reason: "no shareable satellites in the composed patch" };
  const host = createMcpSatelliteHost({ satellites: specs, port: 0, logger });
  try {
    await host.start();
  } catch (err) {
    logger.error(`[satellite-host] start failed (falling back to per-dsh satellites): ${err?.message || err}`);
    await host.stop().catch(() => {});
    return { host: null, url: null, reason: `start failed: ${err?.message || err}` };
  }
  const url = `http://127.0.0.1:${host.port}`;
  logger.log(
    `[satellite-host] sharing ${specs.length} satellite(s) across this cell's dsh generations: ` +
      specs.map((s) => s.name).join(","),
  );
  return { host, url, reason: "started" };
}
