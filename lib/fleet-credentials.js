// Fleet-scoped credentials (fleet-scoped-bench-credentials D2/D3).
//
// Why this module exists: `BENCH_FLEET_TOKEN` used to be ONE platform-process
// env var, resolved by dsh-profile's envRefs as `scopedEnv?.[ref] ?? process.env[ref]`.
// One dsh child serves a whole cell, and a cell hosts several fleets, so every
// fleet's post ran the machine face as the SAME identity — whoever held that
// token could claim anyone's work order and sign writes to one name. The 403
// "not your fleet's work" could never fire, by construction.
//
// The store lives beside the fleets it belongs to (`fleet_credentials` in the
// per-cell fleets.db), and this module is the only place that turns "who is
// this member" into "which token". Two rules it enforces, both learned from
// production:
//
//   1. No fallback to a process-level value. A fleet without a credential row
//      gets NO bench tools (rows dropped), never a shared token. A visible
//      absence is honest; a shared identity is not.
//   2. A row whose fleet is gone is not a credential (ghost fleet, 2026-11-14:
//      `fleet_1794335712751_wfa3ww` was registered bench-side, signed 13
//      proposals, and existed in no live fleets.db). getFleetCredential
//      already reads such rows as absent; `benchScopeDecision` here never
//      promotes a ghost into a sole holder.
//
// Pure functions first (unit-tested without a database), then the thin DB
// readers that lazily import the singleton so this module stays importable in
// tests and in the browser-less profile-writing path.

export const CREDENTIAL_KINDS = Object.freeze(["bench"]);

// The two machine-face MCP rows, and the env keys they carry. `BENCH_FLEET_REF`
// is what lets the client refuse a foreign `source` BEFORE sending anything
// (bind-bench-proposal-identity-to-credential D3) — it must therefore travel
// with the token, never from a separate config value.
export const BENCH_SERVERS = Object.freeze(["bench-proposal", "bench-ops"]);
export const BENCH_ENV = Object.freeze({ token: "BENCH_FLEET_TOKEN", ref: "BENCH_FLEET_REF" });

// Decision from the holder rows of one kind. Exactly one holder = that fleet
// may ride the SHARED patch (identity unambiguous, byte-identical to the
// single-token past). Zero or several = the shared patch must carry no bench
// rows at all: with several, a shared value would be one fleet's token acting
// for the others, which is precisely the defect this change removes.
export function benchScopeDecision(rows) {
  const list = Array.isArray(rows) ? rows.filter((r) => r && r.fleetId) : [];
  if (list.length === 1) return { mode: "sole", fleetId: list[0].fleetId, holders: [list[0].fleetId] };
  if (list.length === 0) return { mode: "none", fleetId: null, holders: [] };
  return { mode: "multiple", fleetId: null, holders: list.map((r) => r.fleetId).sort() };
}

function isBenchRow(entry) {
  return BENCH_SERVERS.includes(entry?.config?.serverName);
}

export function dropBenchRows(insert) {
  return Array.isArray(insert) ? insert.filter((e) => !isBenchRow(e)) : [];
}

// Stamp one fleet's credential onto both bench rows. Both keys are written
// together: a token without its ref would make the client unable to tell
// "that is not me" before sending, and a ref without its token would let the
// child run with whatever BENCH_FLEET_TOKEN happened to be in the environment
// (the exact fallback rule 1 forbids).
export function stampBenchRows(insert, credential) {
  if (!Array.isArray(insert)) return [];
  const fleetId = String(credential?.fleetId ?? "").trim();
  const token = String(credential?.token ?? "").trim();
  if (!fleetId || !token) return dropBenchRows(insert);
  return insert.map((e) => {
    if (!isBenchRow(e)) return e;
    return {
      ...e,
      config: {
        ...e.config,
        env: { ...(e.config?.env ?? {}), [BENCH_ENV.token]: token, [BENCH_ENV.ref]: fleetId },
      },
    };
  });
}

// The member-patch rule in one place: a resolvable credential stamps the rows,
// anything else removes them. `null` is not "leave as-is" — leaving as-is is
// what would carry the shared value straight into a member's private patch.
export function applyBenchToRows(insert, credential) {
  return credential ? stampBenchRows(insert, credential) : dropBenchRows(insert);
}

// ── DB-backed readers (lazy: pure helpers above stay dependency-free) ───────

async function fleetDb() {
  const mod = await import("../server/routes/fleets-db.js");
  return mod.getFleetDatabase();
}

// The credential a fleet's members may use, or null. Null covers all three
// reasons on purpose (no row / ghost row / unreadable store) because the
// caller's action is identical — drop the rows — but `status` keeps them
// distinguishable for logs and for the gate.
export async function resolveFleetBenchCredential(fleetId) {
  const id = String(fleetId ?? "").trim();
  if (!id) return { status: "no_fleet", credential: null };
  let db;
  try {
    db = await fleetDb();
  } catch (e) {
    return { status: "store_unavailable", credential: null, error: e?.message || String(e) };
  }
  const fleet = db.getFleet?.(id);
  if (!fleet) return { status: "ghost", credential: null };
  const row = db.getFleetCredential?.(id, "bench");
  if (!row?.token) return { status: "no_row", credential: null };
  return { status: "ok", credential: { fleetId: id, token: row.token } };
}

// Holder rows for the shared-patch decision. Reads the fingerprint list (the
// token never enters this path), and reports unreadable stores as `unknown`
// rather than as "none" — "we could not look" must not read as "nobody holds one".
export async function benchHolderScope() {
  let db;
  try {
    db = await fleetDb();
  } catch (e) {
    return { mode: "unknown", fleetId: null, holders: [], error: e?.message || String(e) };
  }
  let rows;
  try {
    rows = db.listFleetCredentials?.({ kind: "bench" }) ?? [];
  } catch (e) {
    return { mode: "unknown", fleetId: null, holders: [], error: e?.message || String(e) };
  }
  return benchScopeDecision(rows);
}

// The same decision expressed for the shared patch: only a sole holder may be
// carried, and its token has to be read separately (the list is fingerprints).
export async function sharedBenchCredential() {
  const scope = await benchHolderScope();
  if (scope.mode !== "sole") return { scope, credential: null };
  const resolved = await resolveFleetBenchCredential(scope.fleetId);
  return { scope, credential: resolved.credential };
}
