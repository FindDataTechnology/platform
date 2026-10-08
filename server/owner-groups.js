// Cell-owner group snapshot (add-role-gated-extensions, design D4).
//
// A hosted cell learns its owner's groups only per-request (gateway-injected
// headers); at boot nothing identity-shaped exists yet. This persists the
// latest observed groups of the cell's single user so the boot MCP patch can
// apply the role filter (revocation survives a cell restart). Write-on-change
// only — the in-memory cache keeps steady-state requests at a string compare.

import path from "node:path";
import { atomicWriteJsonSync, readJsonOr } from "../lib/persistence.js";
import { PLATFORM_DATA_DIR } from "../paths.js";

const FILE = PLATFORM_DATA_DIR
  ? path.join(PLATFORM_DATA_DIR, "owner-groups.json")
  : path.resolve("owner-groups.json");

let cached = null;

export function readOwnerGroups() {
  if (cached) return cached;
  const snap = readJsonOr(FILE, null, { label: "owner-groups" });
  return snap && typeof snap === "object" ? snap : null;
}

// Records the owner's groups; returns true when the snapshot changed.
export function noteOwnerGroups(user) {
  if (!user?.email || !Array.isArray(user.groups)) return false;
  const next = { email: user.email, groups: user.groups };
  if (cached && cached.email === next.email && JSON.stringify(cached.groups) === JSON.stringify(next.groups)) {
    return false;
  }
  atomicWriteJsonSync(FILE, next);
  cached = next;
  return true;
}
