// connector-grants.js — turn a resolved binding into a live scoped token
// (add-connector-bindings D5/D6).
//
// A binding's authority is a connector PAT minted for exactly that binding:
// `(provider, operationType)` pairs, nothing else. Two rules keep that honest:
//
//   Granting is a user action. Nothing here mints on its own — the install gate
//   only *reports* what is missing, the dialog calls grantPack, and a rejected
//   tool call calls grantForAction after the user confirms. A 403 never widens
//   scope by itself and a rejected call is never replayed.
//   Scope only ever widens by re-mint. The connector unions a same-name re-mint
//   and revokes the replaced token, so a binding holds one live token whose
//   range is the union of everything the user has granted it.
//
// Everything server-to-server: the caller is 壹座, the credential is the user's
// own active connector account (attenuation — the child can only be narrower).

import * as db from "./db.js";
import * as connectorCredentials from "./connector-credentials.js";
import * as bindings from "./connector-bindings.js";

/** Grantable operation classes (a binding may not grant `destructive`). */
export const GRANTABLE_OPERATIONS = Object.freeze(["read", "write"]);

export function bindingPatName(packId, bindingKey) {
  return `pack:${packId}:${bindingKey}`;
}

export function bindingPurpose(packId, bindingKey) {
  return `pack:${packId}/${bindingKey}`;
}

async function requestJson({ origin, token, pathname, method = "POST", body, timeoutMs = 8000, fetchImpl = fetch }) {
  let response;
  try {
    response = await fetchImpl(`${origin}${pathname}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { ok: false, code: "unavailable" };
  }
  let parsed = null;
  try {
    parsed = response.status === 204 ? null : await response.json();
  } catch {
    parsed = null;
  }
  if (response.ok) return { ok: true, body: parsed };
  // The connector's envelope is `{ error: { code, message } }` (jsonError).
  // A flat `code` is tolerated because not every endpoint dates from the same
  // era, but the nested one is the contract — reading only the flat form made
  // every refusal look like `http_404`, which reads as "broken", not "typo".
  const nested = parsed?.error && typeof parsed.error === "object" ? parsed.error : null;
  const code = nested?.code ?? (typeof parsed?.code === "string" ? parsed.code : `http_${response.status}`);
  const message = nested?.message ?? (typeof parsed?.error === "string" ? parsed.error : null);
  return { ok: false, code, message, status: response.status };
}

/**
 * Mint (or widen) one binding's PAT.
 *
 * `operations` are the classes the binding must be able to use after this call.
 * Sending the full desired set keeps the call idempotent: the connector unions
 * it with the same-name sibling's scope, so repeating a grant changes nothing
 * and extending one only adds the new class.
 */
export async function mintBindingToken({
  email,
  packId,
  bindingKey,
  provider,
  operations,
  // A declaration may name action rules instead of operation classes
  // (`allowActions`, the finer of the two forms the manifest validator accepts).
  // Those rules travel with the mint as-is: turning them into classes locally
  // would be inventing catalog facts, and dropping them would make a legal
  // declaration un-grantable (`empty_scope` forever).
  actions = [],
  origin = bindings.connectorOrigin(),
  fetchImpl = fetch,
  // Deployment-scoped minting names its PAT per (pack, AGENT, binding). The
  // connector unions a same-name re-mint and revokes the replaced token, so
  // sharing the interactive name across agents of one pack would make the
  // second agent's mint silently kill the first agent's token
  // (add-deployment-binding-grant 2.3).
  patName = bindingPatName(packId, bindingKey),
  patPurpose = bindingPurpose(packId, bindingKey),
}) {
  const wanted = [...new Set(operations ?? [])].filter((operation) => GRANTABLE_OPERATIONS.includes(operation));
  const rules = [...new Set((actions ?? []).filter((rule) => typeof rule === "string" && rule.trim()))];
  if (!provider || (wanted.length === 0 && rules.length === 0)) return { ok: false, code: "empty_scope" };
  if (!origin) return { ok: false, code: "connector_not_configured" };
  // The parent credential: the user's own active account. Without it there is
  // nothing to attenuate from, and we must not reach for a deployment token.
  const accountToken = connectorCredentials.liveToken(email);
  if (!accountToken) return { ok: false, code: "no_account" };

  const minted = await requestJson({
    origin,
    token: accountToken,
    pathname: "/api/tenant/pats",
    fetchImpl,
    body: {
      name: patName,
      purpose: patPurpose,
      allowedOperations: wanted.map((operationType) => ({ provider, operationType })),
      ...(rules.length === 0 ? {} : { allowedActions: rules }),
    },
  });
  if (!minted.ok) return minted;
  if (typeof minted.body?.token !== "string" || !minted.body.token) {
    return { ok: false, code: "unexpected_response" };
  }
  return { ok: true, token: minted.body.token, patId: minted.body.id ?? null, name: minted.body.name ?? null };
}

/**
 * The PATs this identity already holds on the connector, by name.
 *
 * Deployment-minted tokens are ours to clean up, and their ids are never
 * persisted platform-side (a deployment secret stores the value, not the id),
 * so revoking one starts from its NAME: list, match, delete. The connector's
 * list is tenant-scoped by the account token, so this can never see a token
 * that belongs to someone else.
 */
export async function listBindingTokens({ email, fetchImpl = fetch, origin = bindings.connectorOrigin() }) {
  if (!origin) return { ok: false, code: "connector_not_configured" };
  const accountToken = connectorCredentials.liveToken(email);
  if (!accountToken) return { ok: false, code: "no_account" };
  const listed = await requestJson({ origin, token: accountToken, pathname: "/api/tenant/pats", method: "GET", fetchImpl });
  if (!listed.ok) return listed;
  const pats = Array.isArray(listed.body?.pats) ? listed.body.pats : [];
  return {
    ok: true,
    pats: pats
      .filter((pat) => pat && typeof pat.id === "string")
      .map((pat) => ({ id: pat.id, name: typeof pat.name === "string" ? pat.name : "", purpose: pat.purpose ?? null })),
  };
}

/**
 * Revoke one of this identity's PATs by id.
 *
 * A 404 counts as success: the token is gone either way, and a cleanup that
 * treats "already revoked" as failure would fire forever.
 */
export async function revokeBindingTokenById({ email, patId, fetchImpl = fetch, origin = bindings.connectorOrigin() }) {
  if (!origin) return { ok: false, code: "connector_not_configured" };
  const accountToken = connectorCredentials.liveToken(email);
  if (!accountToken) return { ok: false, code: "no_account" };
  const response = await requestJson({
    origin,
    token: accountToken,
    pathname: `/api/tenant/pats/${encodeURIComponent(String(patId))}`,
    method: "DELETE",
    fetchImpl,
  });
  if (response.ok || response.status === 404 || response.code === "runtime_token_not_found") {
    return { ok: true, alreadyGone: !response.ok };
  }
  return response;
}

/**
 * Store a minted token as the binding's credential and stamp the grant time.
 * The ledger status is NOT touched: whether the binding is satisfied depends on
 * the connection and the catalog, which the next resolution re-reads.
 */
function recordGrant({ email, packId, bindingKey, token, patId, provider, operations }) {
  const slot = bindings.bindingSlot(packId, bindingKey);
  db.setConnectorBinding({
    email,
    slot,
    token,
    patId,
    purpose: bindingPurpose(packId, bindingKey),
    sourceAccount: connectorCredentials.status(email).slot ?? null,
  });
  const row = db.getConnectorBindingLedgerRow(email, packId, bindingKey);
  if (row) {
    db.upsertConnectorBindingLedgerRow({
      email,
      packId,
      packVersion: row.packVersion,
      bindingKey,
      provider: row.provider ?? provider,
      operations: row.operations?.length ? row.operations : operations,
      connectionId: row.connectionId,
      status: row.status,
      optional: row.optional,
      // The ledger upsert is a full-row write, so a partial update that forgets
      // `role` silently turns a role binding back into a fixed-provider one.
      role: row.role ?? null,
      grantedAt: new Date().toISOString(),
    });
  }
  return slot;
}

/**
 * Grant one binding. `operations` defaults to the binding's declared classes —
 * the declarative dialog grants exactly what the pack asked for, no more.
 */
export async function grantBinding({ email, packId, bindingKey, operations = null, provider = null, fetchImpl = fetch }) {
  const ledger = db.getConnectorBindingLedgerRow(email, packId, bindingKey);
  if (!ledger) return { ok: false, code: "unknown_binding" };
  const classes = operations ?? ledger.operations ?? [];
  // The action rules always come from the declaration, never from the caller: a
  // widening call that dropped them would re-mint an action-scoped binding with
  // no actions (the connector's same-name union usually masks that, but only
  // while the previous token is still listed).
  const declaration = (db.getInstalledPack(packId)?.manifest?.connector_bindings ?? []).find(
    (entry) => entry?.key === bindingKey,
  );
  const actions = Array.isArray(declaration?.allowActions) ? declaration.allowActions : [];
  const minted = await mintBindingToken({
    email,
    packId,
    bindingKey,
    provider: provider ?? ledger.provider,
    operations: classes,
    actions,
    fetchImpl,
  });
  if (!minted.ok) return { ...minted, packId, bindingKey };
  recordGrant({
    email,
    packId,
    bindingKey,
    token: minted.token,
    patId: minted.patId,
    provider: ledger.provider,
    operations: classes,
  });
  return {
    ok: true,
    packId,
    bindingKey,
    operations: classes,
    ...(actions.length === 0 ? {} : { actions }),
    patId: minted.patId,
  };
}

/**
 * The declarative grant: one confirmation grants every resolvable binding of the
 * pack at once (spec: 一次弹窗授予全部声明). Per-binding outcomes are returned
 * instead of failing the whole batch — a binding whose provider is unwired must
 * not block the others, and the surface has to say which one failed.
 */
export async function grantPack({ email, packId, bindingKeys = null, fetchImpl = fetch }) {
  const rows = bindings.listBindings(email, packId);
  const wanted = bindingKeys ? new Set(bindingKeys) : null;
  const granted = [];
  const failed = [];
  // A role binding with no chosen system is not a failure of this call — there
  // is no provider to bound a scope with. It belongs to the "choose a system"
  // list, so it is reported separately instead of inflating `failed`.
  const deferred = [];
  for (const row of rows) {
    if (row.status === bindings.BINDING_STATUS.deprecated) continue;
    if (wanted && !wanted.has(row.bindingKey)) continue;
    if (row.status === bindings.BINDING_STATUS.unmapped) {
      deferred.push({ bindingKey: row.bindingKey, role: row.role ?? null, code: "unmapped" });
      continue;
    }
    // Only a resolvable binding can be granted: minting for an unwired provider
    // would be rejected by the connector and reading as "granted" would lie.
    if (row.status !== bindings.BINDING_STATUS.satisfied) {
      failed.push({ bindingKey: row.bindingKey, provider: row.provider, code: `not_grantable:${row.status}` });
      continue;
    }
    const result = await grantBinding({ email, packId, bindingKey: row.bindingKey, fetchImpl });
    if (result.ok) {
      granted.push({
        bindingKey: row.bindingKey,
        provider: row.provider,
        operations: result.operations,
        ...(result.actions ? { actions: result.actions } : {}),
      });
    }
    else failed.push({ bindingKey: row.bindingKey, provider: row.provider, code: result.code });
  }
  return { ok: failed.length === 0 || granted.length > 0, granted, failed, deferred };
}

/**
 * Progressive grant, step 1: what did this action need? The connector's
 * `scope-explain` is the only authority on the class of an action id, and it
 * distinguishes unknown from denied — a typo must not render an authorization
 * card.
 */
export async function explainAction({ email, actionId, origin = bindings.connectorOrigin(), fetchImpl = fetch }) {
  if (!origin) return { ok: false, code: "connector_not_configured" };
  const accountToken = connectorCredentials.liveToken(email);
  if (!accountToken) return { ok: false, code: "no_account" };
  const query = new URLSearchParams({ actionId });
  const explained = await requestJson({
    origin,
    token: accountToken,
    pathname: `/api/tenant/scope-explain?${query.toString()}`,
    method: "GET",
    fetchImpl,
  });
  if (!explained.ok) return explained;
  return {
    ok: true,
    actionId: explained.body?.actionId ?? actionId,
    provider: explained.body?.provider ?? null,
    operationType: explained.body?.operationType ?? null,
    allowed: !!explained.body?.allowed,
    code: explained.body?.code ?? null,
  };
}

/**
 * Progressive grant, step 2: widen the binding that owns this action so the
 * class it needs is inside its scope. Returns the binding to point the UI at;
 * it deliberately does NOT replay the rejected call (spec: 不自动重试, writes
 * especially) — the caller's next round issues whatever it decides to.
 */
export async function grantForAction({ email, packId, actionId, fetchImpl = fetch }) {
  const explained = await explainAction({ email, actionId, fetchImpl });
  if (!explained.ok) return explained;
  if (explained.allowed) {
    // Already permitted: a second card would be a lie (the scope was fine; the
    // failure was something else), so report it and let the surface say so.
    return { ...explained, ok: false, code: "already_allowed" };
  }
  if (!explained.provider || !explained.operationType) {
    return { ...explained, ok: false, code: "unknown_action" };
  }
  if (!GRANTABLE_OPERATIONS.includes(explained.operationType)) {
    return { ...explained, ok: false, code: "not_grantable" };
  }
  const declared = db.getInstalledPack(packId)?.manifest?.connector_bindings ?? [];
  const declarationByKey = new Map(declared.map((declaration) => [declaration.key, declaration]));
  const ledger = bindings
    .listBindings(email, packId)
    .filter((row) => row.status !== bindings.BINDING_STATUS.deprecated)
    .filter((row) => {
      // A binding owns the action when the action's provider is the declared
      // provider or one of its declared alternatives.
      const declaration = declarationByKey.get(row.bindingKey);
      const providers = [declaration?.provider ?? row.provider, ...(declaration?.alternativeProviders ?? [])];
      return providers.includes(explained.provider);
    });
  if (ledger.length === 0) return { ...explained, ok: false, code: "no_binding_for_provider" };
  // Prefer the binding that already carries a grant: extending it keeps one
  // token per binding instead of spreading a class across two.
  const target =
    ledger.find((row) => bindings.liveBindingToken(email, packId, row.bindingKey)) ?? ledger[0];
  const operations = [...new Set([...(target.operations ?? []), explained.operationType])];
  const granted = await grantBinding({
    email,
    packId,
    bindingKey: target.bindingKey,
    operations,
    provider: explained.provider,
    fetchImpl,
  });
  if (!granted.ok) return { ...granted, ...explained };
  return {
    ok: true,
    packId,
    bindingKey: target.bindingKey,
    provider: explained.provider,
    operationType: explained.operationType,
    operations,
    // Everything the caller needs to render "已授权，下一轮生效" without
    // re-asking the connector.
    actionId: explained.actionId,
    replayed: false,
  };
}

/**
 * Revoke one binding's grant: connector-side PAT first (best effort — a leftover
 * PAT is the pre-change status quo), then the local row, so the profile row and
 * the ledger stop claiming authority immediately.
 */
export async function revokeBinding({ email, packId, bindingKey, fetchImpl = fetch, origin = bindings.connectorOrigin() }) {
  const slot = bindings.bindingSlot(packId, bindingKey);
  const row = db.getConnectorBinding(email, slot);
  let revoked = false;
  if (row?.token && origin) {
    // A PAT can revoke itself, which is exactly the credential we hold here.
    const response = await requestJson({
      origin,
      token: row.token,
      pathname: `/api/tenant/pats/${encodeURIComponent(row.patId || "")}`,
      method: "DELETE",
      fetchImpl,
    }).catch(() => ({ ok: false }));
    revoked = !!response.ok;
  }
  const removed = bindings.revokeBindingGrant(email, packId, bindingKey);
  return { ok: true, removed, revokedOnConnector: revoked };
}

// ── Install / activate gate (D7) ────────────────────────────────────────────

/**
 * Re-resolve every binding this identity has for one role (add-connector-role-mapping
 * D6). The mapping is (email, role), so the blast radius is "all packs that
 * declare this role", not "the pack the user happens to be looking at" —
 * refreshing only the current pack would leave a sibling pack injecting a token
 * minted for the system the user just replaced.
 *
 * Row-level declaration comparison in resolvePack drops the tokens whose
 * provider changed, so nothing here revokes by hand.
 */
export async function refreshRoleBindings({ email, role, client = undefined, fetchImpl = fetch }) {
  const name = typeof role === "string" ? role.trim() : "";
  if (!name) return { ok: false, code: "role_required", packs: [] };
  let rows;
  try {
    rows = bindings.listBindings(email);
  } catch {
    return { ok: false, code: "ledger_unavailable", packs: [] };
  }
  const packIds = [
    ...new Set((rows ?? []).filter((row) => (row.role ?? null) === name).map((row) => row.packId)),
  ];
  const packs = [];
  for (const packId of packIds) {
    const result = await refreshPackBindings({ email, packId, client, fetchImpl });
    packs.push({ packId, ...result });
  }
  return { ok: true, role: name, packs };
}

/**
 * Resolve every binding a pack declares, right now, for this identity.
 *
 * Called on install and on activate. Missing non-optional bindings mean the pack
 * must NOT be presented as connected; a missing optional binding only degrades
 * itself. Both lists come back so the surface can render one row per unmet
 * binding with the right fix (connect / grant / wait for the provider).
 */
export async function refreshPackBindings({
  email,
  packId,
  // At install time the pack is not in the DB yet (the gate runs before the
  // record is written), so the caller may hand the declarations in directly.
  // Without this the gate read an absent pack and reported "nothing open".
  declarations = null,
  packVersion = null,
  client = undefined,
  fetchImpl = fetch,
}) {
  let declared = declarations;
  let version = packVersion;
  if (!declared) {
    const installed = db.getInstalledPack(packId);
    if (!installed) return { ok: false, code: "pack_not_installed" };
    declared = installed.manifest?.connector_bindings ?? [];
    version = String(installed.version);
  }
  if (declared.length === 0) {
    return { ok: true, bindings: [], gate: { required: 0, connected: true, unresolved: [], optionalUnmet: [], pendingGrant: [] } };
  }
  let resolvedClient = client;
  if (resolvedClient === undefined) {
    resolvedClient = bindings.tenantClient(email, { fetchImpl });
  }
  const rows = await bindings.resolvePack({
    email,
    packId,
    packVersion: version === null ? null : String(version),
    bindings: declared,
    client: resolvedClient,
  });
  return { ok: true, bindings: rows, gate: gateFromRows(email, packId, rows) };
}

/** The gate projection itself — pure, so callers can recompute it from rows. */
export function gateFromRows(email, packId, rows) {
  const unresolved = [];
  const optionalUnmet = [];
  const pendingGrant = [];
  for (const row of rows) {
    if (row.status === bindings.BINDING_STATUS.satisfied) {
      // Satisfied but token-less: usable only after the one-click grant.
      if (!bindings.liveBindingToken(email, packId, row.bindingKey)) {
        pendingGrant.push({ bindingKey: row.bindingKey, provider: row.provider, operations: row.operations });
      }
      continue;
    }
    if (row.status === bindings.BINDING_STATUS.deprecated) continue;
    const item = {
      bindingKey: row.bindingKey,
      provider: row.provider,
      role: row.role ?? null,
      operations: row.operations,
      status: row.status,
      reason: row.reason,
      optional: row.optional,
    };
    (row.optional ? optionalUnmet : unresolved).push(item);
  }
  return {
    // The pack is "connected" only when nothing non-optional is left open AND
    // every satisfied binding can actually be used (granted).
    connected: unresolved.length === 0 && pendingGrant.length === 0,
    required: rows.filter((row) => !row.optional && row.status !== bindings.BINDING_STATUS.deprecated).length,
    unresolved,
    optionalUnmet,
    pendingGrant,
    // What the single dialog should show / grant.
    grantable: rows
      .filter((row) => row.status === bindings.BINDING_STATUS.satisfied)
      .map((row) => ({
        bindingKey: row.bindingKey,
        provider: row.provider,
        role: row.role ?? null,
        operations: row.operations,
        optional: row.optional,
        connectionHint: row.connectionName ?? null,
      })),
  };
}
