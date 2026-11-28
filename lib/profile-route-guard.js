// ── Profile route guard (openspec: harden-plugin-supply-gates, task 1.3) ─────
//
// The boot half of the route-exclusivity assertion. `writeLlmProfile` refuses to
// COMPOSE a foreign model route; this reads the composition that is actually on
// disk and refuses to start on it. Hand edits, an older writer, or a restored
// backup all reach the runtime through the file, not through the generator — so
// the file is what boot has to judge.
//
// Kept in its own module because the bridge must not import `dsh-profile.js`
// (that would freeze its module-level DSH_HOME constants earlier in the import
// graph — the env-freeze incident) and because a file-reading guard has to be
// testable without spawning a runtime.
//
// Scope, stated honestly: this inspects the profile's own patch layer — the
// composition the platform owns. Entries a bundle contributes from inside its
// package are not visible here; that half is covered by the supply whitelist's
// contribution classes (task 4.2 of the same change).

import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import { findRouteExclusivityViolations, throwRouteViolations } from "./llm-route-exclusivity.js";
import { applyRouteExceptions, loadRouteExceptions } from "./route-exceptions.js";

/**
 * @param {string|null} patchPath  the profile's cordis.patch.yml
 * @param {{ mode?: string, log?: Pick<Console, "warn">, exceptions?: object[], exceptionsFile?: string }} [opts]
 *   mode: "enforce" (default) | "warn" (observation run) | "off"
 *   exceptions: pre-loaded entries (tests); otherwise read from the exceptions file
 * @returns {{ checked: boolean, violations: {id: string|null, name: string|null, reason: string}[] }}
 */
export function guardProfileRouteExclusivity(
  patchPath,
  { mode = process.env.DSH_ROUTE_EXCLUSIVITY ?? "", log = console, exceptions, exceptionsFile } = {},
) {
  const normalized = String(mode || "").toLowerCase();
  if (normalized === "off" || !patchPath) return { checked: false, violations: [] };

  let raw;
  try {
    raw = readFileSync(patchPath, "utf8");
  } catch (err) {
    // No profile patch yet (first boot) is not a violation.
    if (err?.code === "ENOENT") return { checked: false, violations: [] };
    throw err;
  }

  let rows;
  try {
    rows = yaml.load(raw);
  } catch {
    // Unparsable YAML fails inside dsh with a clearer message than we could
    // give; asserting here would replace it with a worse one.
    return { checked: false, violations: [] };
  }
  if (!Array.isArray(rows)) return { checked: true, violations: [] };

  const found = findRouteExclusivityViolations(rows);
  if (found.length === 0) return { checked: true, violations: [] };

  // Operator exceptions are decisions with an expiry (task 4.3), matched by
  // package name. An expired or malformed entry grants nothing.
  let entries = exceptions;
  if (!Array.isArray(entries)) {
    const loaded = loadRouteExceptions(exceptionsFile);
    for (const problem of loaded.errors) log.warn(`[profile-route-guard] exception file: ${problem}`);
    entries = loaded.exceptions;
  }
  const { violations, allowed, expired } = applyRouteExceptions(found, entries);
  for (const { violation, exception } of allowed) {
    log.warn(
      `[profile-route-guard] EXCEPTED '${exception.name}' until ${new Date(exception.expiresAt).toISOString()} (approved by ${exception.approvedBy}): ${violation.reason}`,
    );
  }
  for (const exception of expired) {
    log.warn(`[profile-route-guard] EXPIRED exception for '${exception.name}' (expired ${new Date(exception.expiresAt).toISOString()}) — re-review or remove it`);
  }
  if (violations.length === 0) return { checked: true, violations: [] };

  if (normalized === "warn") {
    log.warn(`[profile-route-guard] WARN (not enforced): ${violations.map((v) => v.reason).join("; ")}`);
    return { checked: true, violations };
  }

  throwRouteViolations(violations); // throws: code + violations
  return { checked: true, violations };
}
