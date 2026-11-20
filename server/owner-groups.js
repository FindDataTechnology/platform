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
//
// Empty is not a revocation (2026-11-09, live): the profile gate reads [] as
// "authenticated, holds no matching group" and DELETES every server behind
// `requiredGroups`. A request that carries the owner's email with an explicitly
// empty `x-forwarded-groups` header therefore rewrote the snapshot to [] and the
// next profile rewrite dropped the whole data plane (`fd-open-data-mcp` gone;
// 26 servers instead of 30) — the fleet then reported "these three tools are
// not enabled for the current focused role" while the data was fine. A missing
// header is already distinguished upstream (`groupsKnown`); an explicitly empty
// one is still not proof that the owner lost every group, so it must not be
// allowed to blank a populated snapshot. A real full revocation passes
// `{ revokeAll: true }`.
export function noteOwnerGroups(user, opts = {}) {
  if (!user?.email || !Array.isArray(user.groups)) return false;
  const next = { email: user.email, groups: user.groups };
  const prev = readOwnerGroups();
  const prevCount = Array.isArray(prev?.groups) ? prev.groups.length : 0;
  if (next.groups.length === 0 && prevCount > 0 && opts?.revokeAll !== true) {
    console.warn(
      `[owner-groups] refused to blank the snapshot for ${user.email}: ` +
        `${prevCount} group(s) -> 0. An explicitly empty x-forwarded-groups header is not ` +
        `proof of a full revocation; pass { revokeAll: true } to force it.`,
    );
    return false;
  }
  if (cached && cached.email === next.email && JSON.stringify(cached.groups) === JSON.stringify(next.groups)) {
    return false;
  }
  atomicWriteJsonSync(FILE, next);
  cached = next;
  return true;
}
