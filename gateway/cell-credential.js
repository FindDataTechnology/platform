// ── Per-cell gateway credential ─────────────────────────────────────────────
//
// One master secret lives on the gateway; each cell gets a token that names
// only itself: `<cellId>.<hmac(master, cellId)>`. The gateway can mint any
// cell's token, a cell can hold only its own, and a token stolen from A fails
// at B (B compares against its own token). This replaces the shared secret
// that proved "some cell" rather than "the gateway" (audit-ponytail/01 §1).
//
// Master acceptance alone would reintroduce the flaw, so the gateway's internal
// doors verify the token shape; `CELL_CREDENTIAL_LEGACY=1` keeps the old exact
// master compare as a grey switch (default off) and is never combined with
// token acceptance (spec: the two must not both be accepted).

import { createHmac, timingSafeEqual } from "node:crypto";

const TOKEN = /^([0-9a-f]{16})\.([0-9a-f]{64})$/;

export function cellCredential(master, cellId) {
  if (!master || !cellId) return "";
  const mac = createHmac("sha256", String(master)).update(`cell:${cellId}`).digest("hex");
  return `${cellId}.${mac}`;
}

// The cellId a token vouches for, or null when it was not minted by `master`.
export function verifyCellCredential(provided, master) {
  if (typeof provided !== "string" || !master) return null;
  const m = TOKEN.exec(provided.trim());
  if (!m) return null;
  const expected = Buffer.from(cellCredential(master, m[1]).slice(m[1].length + 1));
  const given = Buffer.from(m[2]);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return m[1];
}

export function legacyMasterMatches(provided, master) {
  if (process.env.CELL_CREDENTIAL_LEGACY !== "1") return false;
  if (typeof provided !== "string" || !master) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(master);
  return a.length === b.length && timingSafeEqual(a, b);
}

// What an internal cell→gateway door checks. A per-cell token is the normal
// answer; the master itself is accepted only under the explicit grey switch.
export function cellDoorAuthorized(provided, master) {
  return Boolean(verifyCellCredential(provided, master)) || legacyMasterMatches(provided, master);
}
