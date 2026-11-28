// ── Bench store binding + HTTP client (openspec: add-pack-bench-ability) ────
//
// A pack declares WHICH store (`platform` or `customer`); the deployment owns
// WHERE that store is and which credential reaches it. This module is that
// deployment side: it resolves the row, reads the token from the env var the
// row names (never a stored secret), and speaks the bench transfer API.
//
// No fallback, ever: a missing binding is reported as missing. Falling back to
// the platform store would send a customer's assets exactly where they said
// they must not go (the same failure fleet_credentials exists to prevent).

const ASSET_KIND_MAP = Object.freeze({
  ontology: "ontology-template",
  ruler: "ruler-set",
  gold: "gold-set",
  "eval-suite": "eval-suite",
});

const FETCH_TIMEOUT_MS = 10_000;

function stripDigest(value) {
  return String(value || "").trim().replace(/^sha256:/, "");
}

/**
 * Look up the configured store for one home.
 *
 * Order: a `bench_stores` row (per-cell operator config) first, then a
 * deployment-level env binding (`BENCH_STORE_URL` + `BENCH_STORE_TOKEN`, with
 * `BENCH_STORE_HOME` naming which home it serves, default `platform`). The env
 * fallback exists because a hosted deployment runs one cell per user: there is
 * no single cell database in which to put a platform-wide row, and a store the
 * deployment owns is exactly what env config is for. It is NOT a fallback from
 * a missing customer binding to the platform store — the env binding declares
 * its own home, so `store.home=customer` finds it only when `BENCH_STORE_HOME`
 * says `customer`.
 *
 * `db` may be omitted in tests.
 */
export function resolveStore(home, { db = null, env = process.env } = {}) {
  if (db && typeof db.prepare === "function") {
    try {
      const row = db
        .prepare("SELECT * FROM bench_stores WHERE home = ? ORDER BY created_at ASC LIMIT 1")
        .get(home);
      if (row) return row;
    } catch {
      // An un-migrated database must read as "no store", never as a crash on a
      // pack install (graceful degradation is a house rule).
    }
  }
  const url = String(env?.BENCH_STORE_URL || "").trim().replace(/\/+$/, "");
  const envHome = String(env?.BENCH_STORE_HOME || "platform").trim();
  if (url && envHome === home) {
    return {
      id: "env-store",
      home: envHome,
      adapter_system: null,
      base_url: url,
      token_env_ref: "BENCH_STORE_TOKEN",
      conformance_status: null,
      created_by: "deployment",
      created_at: null,
    };
  }
  return null;
}

export function storeToken(store, env = process.env) {
  const ref = store?.token_env_ref;
  if (!ref) return null;
  const value = env?.[ref];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function kindForAsset(asset) {
  return ASSET_KIND_MAP[asset] ?? null;
}

/**
 * Read-face projection of one store row: never the credential, only its last 4
 * characters (and "unset" when the env var is missing). A reader must be able
 * to tell "configured" from "misconfigured" without being handed the secret.
 */
export function benchStoreView(row, env = process.env) {
  if (!row) return null;
  const token = storeToken(row, env);
  return {
    id: row.id,
    home: row.home,
    adapter_system: row.adapter_system ?? null,
    base_url: row.base_url,
    token_env_ref: row.token_env_ref,
    token_hint: token ? `…${token.slice(-4)}` : null,
    token_configured: Boolean(token),
    conformance_status: row.conformance_status ?? null,
    created_by: row.created_by ?? null,
    created_at: row.created_at ?? null,
  };
}

async function request(store, token, path, init = {}) {
  const url = `${String(store.base_url).replace(/\/+$/, "")}${path}`;
  let response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        Accept: "application/json",
        // One credential, one header. 知验台 binds a present-but-invalid
        // Bearer to 401 *before* it looks at X-API-Key, so sending both would
        // make its own API key unusable. Its long-lived keys are documented as
        // `lbk_...`, and the capability-limited asset token is `fda_...`
        // (X-Consumer-Token); anything else is treated as a bearer token for a
        // store behind an OAuth proxy.
        ...(String(token).startsWith("lbk_")
          ? { "X-API-Key": token }
          : String(token).startsWith("fda_")
            ? { "X-Consumer-Token": token }
            : { Authorization: `Bearer ${token}` }),
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    return { ok: false, status: 0, error: error?.message || String(error) };
  }
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { ok: response.ok, status: response.status, body };
}

/**
 * Confirm a declared source exists in the store and is the pinned version.
 *
 * Returns `{status, reason}` where status is one of `bound` / `missing` /
 * `unreachable`. A digest mismatch is `missing` — the store has *a* version of
 * that name, but not the one this pack declared.
 */
export async function probeSource(store, token, { asset, source }) {
  const kind = kindForAsset(asset);
  if (!kind) return { status: "missing", reason: `no transfer kind for asset '${asset}'` };
  const query = new URLSearchParams({
    kind,
    name: String(source.name),
    version: String(source.version),
  });
  const out = await request(store, token, `/api/v1/assets/${asset}/export?${query}`);
  if (out.status === 0) return { status: "unreachable", reason: out.error };
  if (out.status === 401 || out.status === 403) {
    return { status: "unreachable", reason: `bench store rejected the credential (${out.status})` };
  }
  if (out.status === 404) return { status: "missing", reason: "the declared version is not in the store" };
  if (!out.ok) {
    return { status: "unreachable", reason: `bench store answered ${out.status}` };
  }
  const actual = stripDigest(out.body?.digest);
  if (actual !== stripDigest(source.digest)) {
    return {
      status: "missing",
      reason: `the store has ${source.name} v${source.version} at a different digest`,
    };
  }
  return { status: "bound", reason: null };
}

/** Fetch the declared envelope from the store (used by fork). */
export async function fetchEnvelope(store, token, { asset, source }) {
  const kind = kindForAsset(asset);
  if (!kind) return { ok: false, status: "missing", reason: `no transfer kind for asset '${asset}'` };
  const query = new URLSearchParams({
    kind,
    name: String(source.name),
    version: String(source.version),
  });
  const out = await request(store, token, `/api/v1/assets/${asset}/export?${query}`);
  if (out.status === 0) return { ok: false, status: "unreachable", reason: out.error };
  if (out.status === 401 || out.status === 403) {
    return { ok: false, status: "unreachable", reason: `bench store rejected the credential (${out.status})` };
  }
  if (out.status === 404) return { ok: false, status: "missing", reason: "the declared version is not in the store" };
  if (!out.ok) return { ok: false, status: "unreachable", reason: `bench store answered ${out.status}` };
  return { ok: true, body: out.body };
}

/**
 * Enroll one fleet into an approved domain and hand back its one-time
 * credential. The deployment credential's bound domains are the human policy;
 * this call is the automatic consequence.
 */
export async function enrollFleet(store, token, { fleetRef, domain }) {
  const out = await request(store, token, "/api/v1/assets/fleets/enroll", {
    method: "POST",
    body: JSON.stringify({ fleet_ref: fleetRef, domain }),
  });
  if (out.status === 0) return { ok: false, status: "unreachable", reason: out.error };
  if (out.status === 401 || out.status === 403) {
    return { ok: false, status: "forbidden", reason: out.body?.detail || `store answered ${out.status}` };
  }
  if (out.status === 409) {
    return { ok: false, status: "already-enrolled", reason: out.body?.detail || "fleet already enrolled" };
  }
  if (!out.ok) {
    return { ok: false, status: "unreachable", reason: out.body?.detail || `store answered ${out.status}` };
  }
  return { ok: true, token: out.body?.token ?? null, body: out.body };
}

/** Import one envelope into the store; returns `{status, reason, body}`. */
export async function importEnvelope(store, token, envelope, targetDomainKey = null) {
  const out = await request(store, token, "/api/v1/assets/import", {
    method: "POST",
    body: JSON.stringify({
      envelope,
      ...(targetDomainKey ? { target_domain_key: targetDomainKey } : {}),
    }),
  });
  if (out.status === 0) return { status: "unreachable", reason: out.error };
  if (out.ok) {
    const created = out.body?.created !== false;
    return {
      status: created ? "forked" : "bound",
      reason: created ? null : "already present in the store",
      body: out.body,
    };
  }
  if (out.status === 503) {
    return {
      status: "conformance-failed",
      reason: out.body?.detail || "the bench store has transfer disabled",
    };
  }
  if (out.status === 401 || out.status === 403) {
    return { status: "unreachable", reason: `bench store rejected the credential (${out.status})` };
  }
  if (out.status === 404) return { status: "missing", reason: out.body?.detail || "not found in the store" };
  return { status: "missing", reason: out.body?.detail || `bench store answered ${out.status}` };
}

export { ASSET_KIND_MAP };
