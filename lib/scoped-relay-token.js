// Host-side facade over the canonical scoped-token implementation that ships
// with the relay (services/search-relay/scoped-token.js — one implementation,
// two runtimes; the platform image COPYs that file, see Dockerfile). Adds the
// host-only helper mapping a cell identity to a stable scope id.
//
// Usage: writeMcpPatch resolves SEARCH_RELAY_TOKEN for a cell by deriving
// wsrc-<scope>-<mac> from SEARCH_RELAY_SCOPED_MASTER (add-mcp-credential-hygiene
// D3), so each cell's patch carries a single-cell-revocable value instead of
// the platform-wide shared secret.

import { createHash } from "node:crypto";

export {
  deriveScopedToken,
  parseScopedToken,
  verifyScopedToken,
  checkTokenAuth,
  SCOPED_PREFIX,
} from "../services/search-relay/scoped-token.js";

// Stable, PII-free scope id for a hosted cell (the patch writer's ownerEmail):
// cell-<first 12 hex of sha256(email)> — deterministic across restarts, so a
// revoked scope stays bound to the same cell.
export function scopeIdForEmail(email) {
  const h = createHash("sha256").update(String(email ?? "").trim().toLowerCase(), "utf8").digest("hex");
  return `cell-${h.slice(0, 12)}`;
}
