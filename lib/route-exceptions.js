// ── Route-exception file loader (openspec: harden-plugin-supply-gates, 4.3) ──
//
// The exception list is operator data, not code: it is read at the moment of the
// decision (write or boot), never snapshotted into a module constant, so an
// entry that expires or is revoked takes effect on the next write/restart
// without a rebuild.
//
//   default path: dsh-matrix/route-exceptions.json
//   override:     DSH_ROUTE_EXCEPTIONS_FILE
//
// An unreadable or malformed file grants NOTHING and is reported — the failure
// direction has to be "gate stays closed", never "gate silently skipped".

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyRouteExceptions, validateRouteException } from "./llm-route-exclusivity.js";

/** Repo default, resolved from this module's location (lib/ → repo root). */
export const DEFAULT_ROUTE_EXCEPTIONS_FILE = path.join(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
  "dsh-matrix",
  "route-exceptions.json",
);

/**
 * @param {string} [file]
 * @returns {{ file: string, exceptions: object[], errors: string[] }}
 *   errors: problems with the FILE (unreadable/invalid entries). Per-entry
 *   invalid entries are also dropped from `exceptions` by applyRouteExceptions.
 */
export function loadRouteExceptions(file = process.env.DSH_ROUTE_EXCEPTIONS_FILE || DEFAULT_ROUTE_EXCEPTIONS_FILE) {
  const target = file || DEFAULT_ROUTE_EXCEPTIONS_FILE;
  let doc;
  try {
    doc = JSON.parse(readFileSync(target, "utf8"));
  } catch (err) {
    // Absent is the normal case (nobody has needed an exception yet).
    if (err?.code === "ENOENT") return { file: target, exceptions: [], errors: [] };
    return { file: target, exceptions: [], errors: [`${target}: unreadable or unparsable (${err?.message || err})`] };
  }

  const list = Array.isArray(doc) ? doc : Array.isArray(doc?.exceptions) ? doc.exceptions : null;
  if (!list) return { file: target, exceptions: [], errors: [`${target}: expected an exceptions array`] };

  const errors = [];
  list.forEach((entry, index) => {
    for (const problem of validateRouteException(entry)) errors.push(`${target}: exceptions[${index}]: ${problem}`);
  });
  return { file: target, exceptions: list, errors };
}

/** Re-exported so callers only import this module. */
export { applyRouteExceptions, validateRouteException };
