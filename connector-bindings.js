// connector-bindings.js — resolve a pack's declared external-system bindings
// into per-user, per-binding facts (add-connector-bindings D2/D3).
//
// A binding says "this pack needs provider X, for these operation classes".
// Turning that into a state needs two kinds of facts and they come from
// different places:
//
//   The connector's catalog (does provider X exist, does it have read/write
//   actions) — asked over `catalog-coverage`, never copied or cached here.
//   The user's own connections (do they hold a connection for X) — asked over
//   `GET /api/tenant/connections` with their credential.
//
// The four states are therefore not interchangeable, and the distinction is the
// product: `missing` means the user has to connect something; `unwired` means
// the platform cannot serve that requirement yet; `stale` means the credential
// died; `undetermined` means we could not ask (that one is deliberately NOT
// `unwired` — an outage must not be reported as a capability gap).
//
// Resolution is idempotent: same inputs, same rows, and it never mints or
// re-mints a token (granting is a separate, user-confirmed step).

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as db from "./db.js";
import { ownerKey, liveToken as liveConnectorToken } from "./connector-credentials.js";

/** Resolution states. `deprecated` is ledger-only (a binding the pack dropped). */
export const BINDING_STATUS = Object.freeze({
  satisfied: "satisfied",
  missing: "missing",
  stale: "stale",
  unwired: "unwired",
  // add-connector-role-mapping: the binding names a ROLE and the identity has
  // not chosen a system for it yet. Not `unwired` (nothing is missing from the
  // catalog — the user can close this) and not `missing` (nothing was chosen to
  // connect to). The three imply three different fixes, so they stay distinct.
  unmapped: "unmapped",
  undetermined: "undetermined",
  deprecated: "deprecated",
});

export const DEFAULT_CONNECTOR_TIMEOUT_MS = 8000;

function mcpConfigPath() {
  return path.resolve(process.env.MCP_CONFIG_PATH || "mcp.json");
}

/**
 * The deployment's connector origin, from the operator baseline row in
 * mcp.json — same single source the credential routes use. null when the
 * deployment has no connector row (self-hosted without a connector).
 */
export function connectorOrigin() {
  try {
    const row = JSON.parse(readFileSync(mcpConfigPath(), "utf8")).mcpServers?.connector;
    return row && typeof row.url === "string" ? new URL(row.url).origin : null;
  } catch {
    return null;
  }
}

/**
 * Minimal read-only client over the connector's tenant routes. Only the two
 * introspection calls a resolution needs; nothing here mints, revokes, or
 * executes an action.
 */
export function createConnectorClient({ origin, token, fetchImpl = fetch, timeoutMs = DEFAULT_CONNECTOR_TIMEOUT_MS }) {
  async function getJson(pathname) {
    // A refusing origin (DNS, ECONNREFUSED, the timeout abort) rejects the
    // promise, and the caller must see that as "we could not ask" — never as an
    // answer. Uncaught, it would escape the resolver and read as a crash.
    let response;
    try {
      response = await fetchImpl(`${origin}${pathname}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return { ok: false, code: "unavailable" };
    }
    if (response.status === 401) return { ok: false, code: "unauthorized" };
    if (response.status === 404) return { ok: false, code: "not_found" };
    if (!response.ok) return { ok: false, code: "unavailable" };
    try {
      return { ok: true, body: await response.json() };
    } catch {
      return { ok: false, code: "unavailable" };
    }
  }

  return {
    origin,
    /** `{ operations: [{operation, covered, actionCount}], gaps }` or a failure code. */
    coverage(provider, operations) {
      const query = new URLSearchParams({ provider, operations: operations.join(",") });
      return getJson(`/api/tenant/catalog-coverage?${query.toString()}`);
    },
    /** `{ connections: [{service, connectionName, configured}] }` or a failure code. */
    connections() {
      return getJson("/api/tenant/connections");
    },
  };
}

/**
 * The connector client for one identity: the deployment's connector origin plus
 * the user's own active connection token. Null when either is missing, and null
 * is meaningful — "we cannot ask", not "there is nothing there".
 */
export function tenantClient(email, { fetchImpl = fetch } = {}) {
  const origin = connectorOrigin();
  const token = liveConnectorToken(email);
  return origin && token ? createConnectorClient({ origin, token, fetchImpl }) : null;
}

/** The operation classes a declaration asks for, in catalog terms. */
export function declaredOperations(binding) {
  const classes = new Set();
  for (const operation of binding?.allowOperations ?? []) {
    const type = typeof operation === "string" ? operation : operation?.operationType;
    if (type) classes.add(String(type).trim());
  }
  return [...classes];
}

/** Candidates in preference order: the declared provider, then its alternatives. */
export function providerCandidates(binding) {
  return [binding?.provider, ...(binding?.alternativeProviders ?? [])]
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim());
}

function bindingSlot(packId, bindingKey) {
  return `${packId}:${bindingKey}`;
}

function sameOperations(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

/**
 * Provider or operation range changed: the granted token no longer describes it.
 *
 * `role` participates for the one case the provider string cannot express: a
 * binding that switches between role form and fixed-provider form while keeping
 * the same name (`provider: "wms"` with and without `providerRole`). The token
 * would keep pointing at the same string, but what that string MEANS changed —
 * a role is the customer's choice, not a catalog id.
 */
function sameDeclaration(previous, resolved) {
  return (
    previous.provider === resolved.provider &&
    (previous.role ?? null) === (resolved.role ?? null) &&
    sameOperations(previous.operations, resolved.operations)
  );
}

/** Nothing at all changed — not even the resolved state or the pack version. */
function sameResolvedRow(previous, resolved, packVersion) {
  return (
    previous.packVersion === packVersion &&
    previous.connectionId === resolved.connectionId &&
    previous.status === resolved.status &&
    previous.optional === resolved.optional &&
    (previous.role ?? null) === (resolved.role ?? null)
  );
}

/**
 * Resolve one declared binding into a ledger-shaped row (no persistence).
 *
 * @param {object} input
 * @param {string} input.email          identity (raw; owner-keyed here)
 * @param {string} input.packId
 * @param {string|null} input.packVersion
 * @param {object} input.binding        the pack's declaration
 * @param {object} input.client         createConnectorClient result (or null when unconfigured)
 */
export async function resolveBinding({ email, packId, binding, client }) {
  const key = ownerKey(email);
  const declaredProvider = String(binding?.provider ?? "").trim();
  const role = binding?.providerRole === true ? declaredProvider : null;
  const operations = declaredOperations(binding);
  const row = {
    email: key,
    packId,
    bindingKey: String(binding?.key ?? "").trim(),
    provider: declaredProvider,
    operations,
    connectionId: null,
    connectionName: null,
    connectionVirtual: false,
    optional: !!binding?.optional,
    role,
    status: BINDING_STATUS.undetermined,
    reason: null,
  };

  // A declaration with only `allowActions` has no operation classes; the
  // classes are whatever the action rules imply, which only the catalog knows.
  // `catalog-coverage` without `operations` defaults to read,write, so an
  // action-only binding is qualified against both and refined on the first
  // grant. Keeping that explicit beats guessing here.
  const classes = operations.length > 0 ? operations : ["read", "write"];

  if (!key || !row.bindingKey || !declaredProvider) {
    return { ...row, status: BINDING_STATUS.undetermined, reason: "invalid_declaration" };
  }

  // No connector in this deployment: nothing can be resolved, and that is not
  // the same as "the user has no connection".
  if (!client) {
    return { ...row, reason: "connector_not_configured" };
  }

  const bindingRow = db.getConnectorBinding(key, bindingSlot(packId, row.bindingKey));
  if (bindingRow?.stale) {
    // A dead binding token is a *known* credential failure: report it as stale
    // rather than re-asking the catalog with a token that cannot authenticate.
    return { ...row, status: BINDING_STATUS.stale, reason: "binding_token_stale" };
  }

  // Role bindings (add-connector-role-mapping D5): the pack names a role, the
  // identity names the system. No mapping means the question is unanswered —
  // report that, and do NOT ask the catalog about the role name (that would
  // turn "not chosen yet" into "unknown provider", i.e. a product gap).
  // Once mapped, the mapped provider is the ONLY candidate: falling back to
  // alternativeProviders would silently switch the system out from under the
  // user who chose one, and the status face would then disagree with them.
  let candidates = providerCandidates(binding);
  if (role) {
    const mapping = db.getConnectorRoleMapping(key, role);
    if (!mapping?.provider) {
      return { ...row, status: BINDING_STATUS.unmapped, reason: `role_not_mapped:${role}` };
    }
    row.provider = mapping.provider;
    candidates = [mapping.provider];
  }

  // Catalog coverage, trying each candidate provider until one is wired.
  let unresolved = null;
  let resolvedProvider = null;
  for (const candidate of candidates) {
    let coverage;
    try {
      coverage = await client.coverage(candidate, classes);
    } catch {
      // Same reasoning as in the client: an exception is silence, not a gap.
      return { ...row, status: BINDING_STATUS.undetermined, reason: "catalog_unreachable" };
    }
    if (coverage.ok) {
      const gaps = Array.isArray(coverage.body?.gaps) ? coverage.body.gaps : [];
      if (gaps.length === 0) {
        resolvedProvider = candidate;
        break;
      }
      // Known provider, insufficient surface: a capability gap, never `missing`.
      unresolved = unresolved ?? { status: BINDING_STATUS.unwired, reason: `catalog_gap:${gaps.join(",")}` };
      continue;
    }
    if (coverage.code === "unauthorized") {
      return { ...row, status: BINDING_STATUS.stale, reason: "credential_rejected" };
    }
    if (coverage.code === "not_found") {
      unresolved = unresolved ?? { status: BINDING_STATUS.unwired, reason: `unknown_provider:${candidate}` };
      continue;
    }
    // Timeout / 5xx / malformed body: we simply do not know.
    return { ...row, status: BINDING_STATUS.undetermined, reason: "catalog_unreachable" };
  }

  if (!resolvedProvider) {
    return { ...row, ...(unresolved ?? { status: BINDING_STATUS.undetermined, reason: "no_candidate" }) };
  }
  row.provider = resolvedProvider;

  // Local fact: does this identity hold a connection for that provider?
  let connections;
  try {
    connections = await client.connections();
  } catch {
    return { ...row, status: BINDING_STATUS.undetermined, reason: "connections_unreachable" };
  }
  if (!connections.ok) {
    if (connections.code === "unauthorized") {
      return { ...row, status: BINDING_STATUS.stale, reason: "credential_rejected" };
    }
    return { ...row, status: BINDING_STATUS.undetermined, reason: "connections_unreachable" };
  }
  const matches = (connections.body?.connections ?? []).filter(
    (connection) => connection?.service === resolvedProvider && connection?.configured !== false
  );
  if (matches.length === 0) {
    return { ...row, status: BINDING_STATUS.missing, reason: "no_connection" };
  }
  // Prefer the hinted connection name when the hint matches one of them.
  const hint = typeof binding?.connectionHint === "string" ? binding.connectionHint.trim() : "";
  const chosen = matches.find((connection) => connection.connectionName === hint) ?? matches[0];
  // The ledger records the connector's connection id (stable across renames).
  // The name and the virtual flag are transient: the status face needs them to
  // say "已连到 账套A" or "平台代管", but nothing keys off them.
  row.connectionId = chosen.id ?? chosen.connectionName ?? null;
  row.connectionName = chosen.connectionName ?? null;
  row.connectionVirtual = !!chosen.virtual;
  return { ...row, status: BINDING_STATUS.satisfied, reason: null };
}

/**
 * Resolve every binding a pack declares and write the ledger.
 *
 * Declaration changes are detected per binding key: a different provider or a
 * different operation set means the previous grant no longer describes what the
 * pack needs, so the binding token is dropped (the caller must ask the user to
 * grant again) and the row is rebuilt. A binding key the pack no longer
 * declares is marked `deprecated` — its token is left alone, because silently
 * revoking on upgrade would break a running session with no user action.
 *
 * Idempotent: an unchanged binding writes nothing, so a second resolution
 * leaves the ledger byte-for-byte identical (updated_at included).
 */
export async function resolvePack({ email, packId, packVersion = null, bindings = [], client = null }) {
  const key = ownerKey(email);
  const rows = [];
  for (const binding of bindings) {
    const resolved = await resolveBinding({ email: key, packId, binding, client });
    const slot = bindingSlot(packId, resolved.bindingKey);
    const previous = db.getConnectorBindingLedgerRow(key, packId, resolved.bindingKey);
    const declarationChanged = !!previous && !sameDeclaration(previous, resolved);
    if (declarationChanged) {
      // Old token describes the old declaration; keeping it would authorize a
      // surface the pack no longer asks for (or fail the new one silently).
      db.deleteConnectorBinding(key, slot);
      // And the old grant time must not outlive the grant: a row that says
      // "granted at T" with no token behind it is a lie to the status face.
      db.deleteConnectorBindingLedgerRow(key, packId, resolved.bindingKey);
    }
    const unchanged = !declarationChanged && previous && sameResolvedRow(previous, resolved, packVersion);
    const stored = unchanged
      ? previous
      : db.upsertConnectorBindingLedgerRow({
          email: key,
          packId,
          packVersion,
          bindingKey: resolved.bindingKey,
          provider: resolved.provider,
          operations: resolved.operations,
          connectionId: resolved.connectionId,
          status: resolved.status,
          optional: resolved.optional,
          role: resolved.role ?? null,
        });
    rows.push({ ...resolved, grantedAt: stored?.grantedAt ?? null });
  }

  // Keys the pack dropped become deprecated, not deleted.
  const declared = new Set(bindings.map((binding) => String(binding?.key ?? "").trim()));
  for (const previous of db.listConnectorBindingLedger(key, packId)) {
    if (declared.has(previous.bindingKey)) continue;
    if (previous.status === BINDING_STATUS.deprecated) continue;
    db.upsertConnectorBindingLedgerRow({
      email: key,
      packId,
      packVersion,
      bindingKey: previous.bindingKey,
      provider: previous.provider,
      operations: previous.operations,
      connectionId: previous.connectionId,
      status: BINDING_STATUS.deprecated,
      optional: previous.optional,
      role: previous.role ?? null,
    });
  }

  return rows;
}

/**
 * The roles this identity's ledger actually needs, with the operation classes
 * each one must cover (add-connector-role-mapping 4.3).
 *
 * Derived from the ledger rather than from the pack manifests: the ledger is
 * already per-identity and already carries the resolved operation range, so the
 * candidate list never has to re-read (or trust) a pack.
 */
export function declaredRoles(email) {
  const byRole = new Map();
  for (const row of listBindings(email)) {
    const role = row.role ?? null;
    if (!role || row.status === BINDING_STATUS.deprecated) continue;
    const entry = byRole.get(role) ?? { role, operations: new Set(), packs: new Set(), optional: true };
    for (const operation of row.operations ?? []) entry.operations.add(operation);
    entry.packs.add(row.packId);
    if (!row.optional) entry.optional = false;
    byRole.set(role, entry);
  }
  return [...byRole.values()]
    .map((entry) => ({
      role: entry.role,
      operations: [...entry.operations].sort(),
      packs: [...entry.packs],
      optional: entry.optional,
    }))
    .sort((a, b) => a.role.localeCompare(b.role));
}

/**
 * Which systems this identity could pick for a role: the connections it already
 * has, narrowed to those whose catalog surface covers the declared classes.
 *
 * Deliberately NOT a catalog browse: an unchosen system the user has no account
 * for cannot be used, so listing all 1570 providers would turn a configuration
 * step into a product-selection exercise. A provider that is connected but
 * under-covers is reported separately (with its gaps) so the card can say why
 * it is not offered instead of silently dropping it.
 */
export async function roleCandidates({ operations = [], client = null }) {
  const classes = operations.length > 0 ? operations : ["read", "write"];
  if (!client) return { ok: false, code: "connector_not_configured", candidates: [], rejected: [] };
  let connections;
  try {
    connections = await client.connections();
  } catch {
    return { ok: false, code: "connections_unreachable", candidates: [], rejected: [] };
  }
  if (!connections.ok) {
    return {
      ok: false,
      code: connections.code === "unauthorized" ? "credential_rejected" : "connections_unreachable",
      candidates: [],
      rejected: [],
    };
  }
  const services = [
    ...new Set(
      (connections.body?.connections ?? [])
        .filter((connection) => connection?.configured !== false && typeof connection?.service === "string")
        .map((connection) => connection.service.trim())
        .filter(Boolean),
    ),
  ];
  const candidates = [];
  const rejected = [];
  for (const service of services) {
    let coverage;
    try {
      coverage = await client.coverage(service, classes);
    } catch {
      // Silence is not a gap: this system stays unlisted, and the caller can
      // still see that we could not ask.
      return { ok: false, code: "catalog_unreachable", candidates, rejected };
    }
    if (coverage.ok) {
      const gaps = Array.isArray(coverage.body?.gaps) ? coverage.body.gaps : [];
      if (gaps.length === 0) {
        const connection = (connections.body?.connections ?? []).find(
          (row) => row?.service === service && row?.configured !== false,
        );
        candidates.push({ provider: service, connectionName: connection?.connectionName ?? null });
      } else {
        rejected.push({ provider: service, gaps });
      }
      continue;
    }
    if (coverage.code === "unauthorized") {
      return { ok: false, code: "credential_rejected", candidates, rejected };
    }
    if (coverage.code === "not_found") {
      // A connection for a service the catalog no longer knows: not offerable.
      rejected.push({ provider: service, gaps: classes });
      continue;
    }
    return { ok: false, code: "catalog_unreachable", candidates, rejected };
  }
  return { ok: true, candidates, rejected };
}

/** Ledger rows for one identity, optionally narrowed to one pack. Token-free. */
export function listBindings(email, packId = null) {
  return db.listConnectorBindingLedger(ownerKey(email), packId);
}

/**
 * Bindings a profile may inject: satisfied and backed by a live binding token.
 * A row without a token is not injectable (no grant yet), which is what keeps
 * "declared" from being mistaken for "authorized".
 */
export function injectableBindings(email, packId = null) {
  return listBindings(email, packId).filter((row) => {
    if (row.status !== BINDING_STATUS.satisfied) return false;
    const credential = db.getConnectorBinding(ownerKey(email), bindingSlot(row.packId, row.bindingKey));
    return credential && !credential.stale;
  });
}

/** The binding token a satisfied row injects, or null. */
export function liveBindingToken(email, packId, bindingKey) {
  const row = db.getConnectorBinding(ownerKey(email), bindingSlot(packId, bindingKey));
  return row && !row.stale ? row.token : null;
}

// ── Injection (add-connector-bindings D4: one track, per binding) ───────────
//
// A session's connector capability is a set of `connector:<slot>` MCP rows, one
// per authorized binding, each carrying its own scoped token. The slot is the
// binding's storage identity — `chat:explore` for the built-in, `<packId>:<key>`
// for a pack binding — so the row name is resolvable back to exactly one
// credential row without guessing (two packs may declare the same binding key).

export const CONNECTOR_BINDING_CREDENTIAL_REF = "connector-binding";
// The MCP server name must satisfy the mcp-client plugin's own constraint,
// `^[A-Za-z0-9_-]{1,32}$` — measured live 2026-11-09: `connector:<pack>:<key>`
// (colons, 38 chars) fails config validation, and because the row is inserted
// with `failOnStartupError: false` the server simply never starts. The tools
// then do not exist, which reads as "the binding was never injected" even
// though every artifact on disk is correct.
const BINDING_SERVER_PREFIX = "connector_";
const SERVER_NAME_MAX = 32;

/** Slug a slot into the mcp-client alphabet (lossy on purpose; see hash). */
function serverNameSlug(slot) {
  return String(slot)
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, SERVER_NAME_MAX - BINDING_SERVER_PREFIX.length - 9) || "binding";
}

/**
 * The MCP server name for a binding slot.
 *
 * `connector_<slug>_<hash8>`: the slug keeps it readable, the hash keeps two
 * slots that fold to the same slug distinct, and the whole thing stays inside
 * the plugin's 32-character alphabet. The name is NOT the slot — callers that
 * need the slot resolve it through `injectionRows` (the same definition that
 * produced the name), never by parsing.
 */
export function bindingServerName(slot) {
  const digest = createHash("sha256").update(String(slot)).digest("hex").slice(0, 8);
  return `${BINDING_SERVER_PREFIX}${serverNameSlug(slot)}_${digest}`;
}

/** Every slot this owner could have injected right now (name→slot lookup). */
export function bindingSlotsForOwner(email) {
  if (!email) return [];
  try {
    const installedPacks = db.isDbReady() ? db.listInstalledPacks().map((pack) => pack.packId) : [];
    return injectionRows(email, { installedPacks }).map((row) => row.slot);
  } catch {
    return [];
  }
}

/** True for a name this module generates (prefix check only, not a slot). */
export function isBindingServerName(name) {
  return typeof name === "string" && name.startsWith(BINDING_SERVER_PREFIX);
}

/** The slot behind one of OUR names, given the candidate slots to match. */
export function slotForServerName(name, slots = []) {
  for (const slot of slots) if (bindingServerName(slot) === name) return slot;
  return null;
}

/** The live token for a slot, by slot alone (injection + the 401 handler). */
export function liveTokenBySlot(email, slot) {
  const key = ownerKey(email);
  if (!key || !slot) return null;
  const row = db.getConnectorBinding(key, slot);
  return row && !row.stale ? row.token : null;
}

/**
 * Bindings this identity may inject right now, as `{slot, name, ...}` rows.
 *
 * Two sources, one rule ("a live token means authorized"):
 *   the built-in free-exploration binding, which has no ledger row (it belongs
 *   to no pack) — its token IS its authorization;
 *   pack bindings whose ledger row is `satisfied` — `missing`/`stale`/`unwired`
 *   must not inject, and `deprecated` must not either: a key the pack dropped
 *   keeps its token (so a running session is not broken mid-flight) but is no
 *   longer advertised.
 *
 * Pack bindings are additionally filtered by `installedPacks`: a pack that is no
 * longer installed must not keep a row, even if its ledger row lingers.
 */
export function injectionRows(email, { installedPacks = null } = {}) {
  const key = ownerKey(email);
  if (!key) return [];
  const live = new Map(
    db
      .listConnectorBindings(key)
      .filter((row) => !row.stale)
      .map((row) => [row.slot, row]),
  );
  const installed = installedPacks ? new Set(installedPacks) : null;
  const rows = [];

  for (const ledgerRow of db.listConnectorBindingLedger(key)) {
    if (ledgerRow.status !== BINDING_STATUS.satisfied) continue;
    if (installed && !installed.has(ledgerRow.packId)) continue;
    const slot = bindingSlot(ledgerRow.packId, ledgerRow.bindingKey);
    if (!live.has(slot)) continue;
    rows.push({
      slot,
      name: bindingServerName(slot),
      packId: ledgerRow.packId,
      bindingKey: ledgerRow.bindingKey,
      provider: ledgerRow.provider,
      operations: ledgerRow.operations,
      connectionId: ledgerRow.connectionId,
      builtin: false,
    });
  }

  const explore = live.get(db.CONNECTOR_EXPLORE_BINDING);
  if (explore) {
    rows.push({
      slot: db.CONNECTOR_EXPLORE_BINDING,
      name: bindingServerName(db.CONNECTOR_EXPLORE_BINDING),
      packId: null,
      bindingKey: db.CONNECTOR_EXPLORE_BINDING,
      provider: null,
      // Full authority, as granted before this change: the token's own scope is
      // the whole story, so there is no declared class list to report.
      operations: null,
      connectionId: null,
      builtin: true,
      purpose: explore.purpose ?? null,
    });
  }
  return rows;
}

/** Drop one binding's grant: the token row goes, the ledger row falls back. */
export function revokeBindingGrant(email, packId, bindingKey) {
  const key = ownerKey(email);
  const removed = db.deleteConnectorBinding(key, bindingSlot(packId, bindingKey));
  const previous = db.getConnectorBindingLedgerRow(key, packId, bindingKey);
  if (previous) {
    // The row must be rebuilt, not updated: `granted_at` upserts with COALESCE,
    // so a plain update would keep the old stamp and the status face would say
    // "granted at T" with no token behind it for the rest of the install.
    db.deleteConnectorBindingLedgerRow(key, packId, bindingKey);
    db.upsertConnectorBindingLedgerRow({
      email: key,
      packId,
      packVersion: previous.packVersion,
      bindingKey,
      provider: previous.provider,
      operations: previous.operations,
      connectionId: previous.connectionId,
      // Without a token the binding is back to "needs a grant"; the next
      // resolution decides between missing / unwired / satisfied.
      status: BINDING_STATUS.missing,
      optional: previous.optional,
      // Full-row upsert: dropping `role` here would un-role a role binding.
      role: previous.role ?? null,
    });
  }
  return removed;
}

/**
 * A 401 on an injected binding row: mark that binding stale. Returns true only
 * when the state actually changed, so the caller re-applies the profile once.
 */
export function markBindingInvalid(email, packId, bindingKey) {
  return db.markConnectorBindingStale(ownerKey(email), bindingSlot(packId, bindingKey));
}

/**
 * The same, addressed by slot — the 401 handler only knows the MCP server name
 * (`connector:<slot>`), and the slot identifies one binding even when two packs
 * declare the same key. Ledger rows keyed to that slot follow the credential
 * into `stale`, so the status face and the profile agree.
 */
export function markSlotInvalid(email, slot) {
  const key = ownerKey(email);
  if (!key || !slot) return false;
  const changed = db.markConnectorBindingStale(key, slot);
  if (!changed) return false;
  for (const row of db.listConnectorBindingLedger(key)) {
    if (bindingSlot(row.packId, row.bindingKey) !== slot) continue;
    if (row.status === BINDING_STATUS.deprecated) continue;
    db.upsertConnectorBindingLedgerRow({
      email: key,
      packId: row.packId,
      packVersion: row.packVersion,
      bindingKey: row.bindingKey,
      provider: row.provider,
      operations: row.operations,
      connectionId: row.connectionId,
      status: BINDING_STATUS.stale,
      optional: row.optional,
      // Full-row upsert: dropping `role` here would un-role a role binding.
      role: row.role ?? null,
    });
  }
  return true;
}

export { bindingSlot };
