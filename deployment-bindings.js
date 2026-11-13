// Deployment-scoped connector bindings (add-deployment-binding-grant).
//
// The interactive path mints a binding from the user's own connector account:
// the account token is the parent, and the binding token is an attenuated
// child (connector-grants.mintBindingToken). That path needs a person present.
//
// A served agent has no person at runtime, so the mint has to happen at DEPLOY
// time, by the deployer, and the token has to live somewhere the runtime can
// reach without a session. `deployment_secrets` is exactly that seat: the value
// stays platform-side and only an opaque reference rides the descriptor to the
// runner. This module is the bridge between the two — mint with the deployer's
// account, record as a deployment secret.
//
// Deliberately NOT done here: relaxing the connector's "service tokens cannot
// mint PATs" rule. That rule is right — a service identity does not own what it
// would mint — and deployment-time minting keeps the parent a real person.

import * as db from "./db.js";
import * as grants from "./connector-grants.js";
import * as connectorCredentials from "./connector-credentials.js";

/** Prefix that marks a deployment secret as ours. Secrets are user-namespaced. */
export const DEPLOYMENT_BINDING_PREFIX = "connector_binding_";

/**
 * PAT name for a deployment-scoped binding: `deploy:<pack>:<agent>:<binding>`.
 *
 * Two deliberate choices. `deploy:` keeps this namespace disjoint from the
 * interactive bindings' `pack:<pack>:<binding>` — pruning must never be able to
 * reach a token a person granted by hand. And the agent segment is what makes
 * the name unique per agent: the connector unions same-name mints and revokes
 * the replaced token, so two agents sharing a name would make the second
 * mint silently kill the first agent's credential.
 */
export function deploymentBindingPatName(packId, agentId, bindingKey) {
  return `deploy:${packId}:${agentId}:${bindingKey}`;
}

/** The namespace a pack's deployment tokens live in (prune/uninstall scope). */
export function deploymentBindingPatPrefix(packId) {
  return `deploy:${packId}:`;
}

/**
 * Deployment secret name for a binding key. Secret names are `[a-z0-9_]{1,32}`
 * (SECRET_NAME_RE), so the key is folded into that alphabet and truncated —
 * consults `deploymentBindingKey()` to read it back rather than parsing.
 */
export function deploymentBindingSecretName(bindingKey) {
  const folded = String(bindingKey)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const room = 32 - DEPLOYMENT_BINDING_PREFIX.length;
  return `${DEPLOYMENT_BINDING_PREFIX}${folded.slice(0, room) || "binding"}`;
}

/**
 * The credential-owner channel (fix-deploy-binding-mint-process).
 *
 * This module runs in two processes with very different reach: the cell holds
 * the user's connector account, the market plane (facet) holds the deployment
 * secrets. Whichever one is asked, the MINT must happen where the account is.
 * `PLATFORM_INTERNAL_URL` + `FACET_INTERNAL_TOKEN` name that door; without them
 * (single-process deployments) everything stays local, byte for byte.
 */
function credentialChannel() {
  const base = String(process.env.PLATFORM_INTERNAL_URL || "").replace(/\/+$/, "");
  const token = String(process.env.FACET_INTERNAL_TOKEN || "");
  return base && token ? { base, token } : null;
}

/** True when this process can see the user's connector account itself. */
export function hasLocalConnectorAccount(email) {
  return Boolean(connectorCredentials.liveToken(email));
}

async function callChannel({ path, body, fetchImpl = fetch }) {
  const channel = credentialChannel();
  if (!channel) return { ok: false, code: "no_credential_channel" };
  try {
    const response = await fetchImpl(`${channel.base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-facet-token": channel.token },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const parsed = await response.json().catch(() => null);
    if (!response.ok || parsed?.ok !== true) {
      return { ok: false, code: parsed?.code ?? `http_${response.status}` };
    }
    return parsed;
  } catch (e) {
    return { ok: false, code: e?.name === "TimeoutError" || e?.name === "AbortError" ? "channel_timeout" : "channel_unreachable" };
  }
}

/**
 * Mint through the process that owns the credential.
 *
 * Only reached when the local credential is absent — a process that can see the
 * account never takes this path, so single-process deployments keep working and
 * a split deployment stops reporting "the user never connected" for what is
 * really "this process cannot see them".
 */
export async function mintBindingsViaChannel({ email, packId, agentIds, fetchImpl = fetch }) {
  // One round trip for the whole deployment: the cell owns the ledger AND the
  // credential, so it is the only side that can answer "what does this need".
  return callChannel({
    path: "/api/gateway/binding-mint-batch",
    body: { email, packId, agentIds: [...new Set(agentIds ?? [])] },
    fetchImpl,
  });
}

/** Revoke through the credential owner (same split as the mint). */
export async function revokeBindingsViaChannel({ email, packId, agentIds = null, fetchImpl = fetch }) {
  return callChannel({
    path: "/api/gateway/binding-revoke",
    body: { email, packId, agentIds },
    fetchImpl,
  });
}

/**
 * Which declared bindings a deployment should carry a token for.
 *
 * The state matrix is the binding ledger's, not a local opinion: only
 * `satisfied` rows are mintable, `optional` rows are the user's choice, and the
 * three "cannot answer" states (`missing`, `unwired`, `undetermined`) are
 * skipped rather than guessed at. `deprecated` is history.
 */
export function mintableBindings({ email, packId }) {
  const rows = db.listConnectorBindingLedger(email, packId);
  return rows
    .filter((row) => !row.optional && row.status === "satisfied")
    .map((row) => ({ bindingKey: row.bindingKey, provider: row.provider, operations: row.operations ?? [] }));
}

/**
 * Mint one deployment binding and record it as a deployment secret.
 *
 * Idempotent per (pack, agent, key): re-recording rotates the stored value, and
 * the caller is expected to have revoked the previous token first (redeploying
 * must not leave two live tokens for one binding).
 */
/**
 * Mint ONE binding and return the value, without storing it.
 *
 * Split out from the store step because the two halves can live in different
 * processes (fix-deploy-binding-mint-process): the connector account belongs to
 * the user's cell, while the deployment-secret store belongs to the market
 * plane. The caller that holds the credential mints and hands back the value;
 * the caller that owns the store records it.
 */
export async function mintBindingForAgent({ email, packId, agentId, bindingKey, provider, operations, fetchImpl = fetch }) {
  const minted = await grants.mintBindingToken({
    email,
    packId,
    bindingKey,
    provider,
    operations,
    fetchImpl,
    patName: deploymentBindingPatName(packId, agentId, bindingKey),
    patPurpose: `deploy:${packId}/${agentId}/${bindingKey}`,
  });
  if (!minted.ok) return { ok: false, bindingKey, code: minted.code ?? "mint_failed" };
  const name = deploymentBindingSecretName(bindingKey);
  return {
    ok: true,
    bindingKey,
    name,
    // The reference is what the descriptor carries; the token never does.
    secretRef: `sec_${packId}_${agentId}_${name}`,
    secretValue: minted.token,
    patId: minted.patId ?? null,
  };
}

export async function mintDeploymentBinding({ email, packId, agentId, bindingKey, provider, operations, record, fetchImpl = fetch }) {
  const minted = await mintBindingForAgent({ email, packId, agentId, bindingKey, provider, operations, fetchImpl });
  if (!minted.ok) return { ok: false, bindingKey, code: minted.code };
  record({
    packId,
    agentId,
    name: minted.name,
    secretRef: minted.secretRef,
    secretValue: minted.secretValue,
    deployer: email,
  });
  return { ok: true, bindingKey, name: minted.name, patId: minted.patId };
}

/**
 * Mint every mintable binding for the agents being deployed.
 *
 * Never throws and never fails the deploy: a pack that cannot get a binding
 * token still deploys (the binding surface reports it as unresolved), which is
 * the same posture install takes — a capability gap must not block shipping.
 * Failures are returned so the deploy surface can name them.
 */
export async function mintDeploymentBindings({ email, packId, agentIds, record, fetchImpl = fetch }) {
  const mintable = mintableBindings({ email, packId });
  const granted = [];
  const failed = [];
  // Where the credential lives decides who mints (fix-deploy-binding-mint-process):
  // this process holds the user's account → mint here; it does not (market plane)
  // → ask the process that does, then store the value locally.
  // Channel only when it is configured AND this process cannot see the account:
  // a single-process deployment without the env keeps its local answer
  // (`no_account` = the person really has none), while the split topology always
  // carries the env and therefore reports the owner's answer instead.
  const local = hasLocalConnectorAccount(email) || !credentialChannel();
  if (!local) {
    const batch = await mintBindingsViaChannel({ email, packId, agentIds, fetchImpl });
    if (!batch.ok) {
      const failed = [...new Set(agentIds)].flatMap((agentId) =>
        mintable.map((binding) => ({ agentId, ok: false, bindingKey: binding.bindingKey, code: batch.code ?? "channel_failed", via: "channel" })),
      );
      return { granted: [], failed, keys: mintable.map((b) => b.bindingKey), skipped: db.listConnectorBindingLedger(email, packId).length - mintable.length };
    }
    const granted = [];
    for (const row of batch.granted ?? []) {
      record({ packId, agentId: row.agentId, name: row.name, secretRef: row.secretRef, secretValue: row.secretValue, deployer: email });
      granted.push({ agentId: row.agentId, ok: true, bindingKey: row.bindingKey, name: row.name, ...(row.patId ? { patId: row.patId } : {}), via: "channel" });
    }
    return {
      granted,
      failed: (batch.failed ?? []).map((f) => ({ agentId: f.agentId, ok: false, bindingKey: f.bindingKey, code: f.code, via: "channel" })),
      keys: batch.keys ?? mintable.map((b) => b.bindingKey),
      skipped: db.listConnectorBindingLedger(email, packId).length - mintable.length,
    };
  }
  for (const agentId of agentIds) {
    for (const binding of mintable) {
      const result = local
        ? await mintDeploymentBinding({
            email,
            packId,
            agentId,
            bindingKey: binding.bindingKey,
            provider: binding.provider,
            operations: binding.operations,
            record,
            fetchImpl,
          })
        : await mintBindingViaChannel({
            email,
            packId,
            agentId,
            bindingKey: binding.bindingKey,
            provider: binding.provider,
            operations: binding.operations,
            fetchImpl,
          });
      if (result.ok && !local) {
        record({
          packId,
          agentId,
          name: result.name,
          secretRef: result.secretRef,
          secretValue: result.secretValue,
          deployer: email,
        });
      }
      // Never spread `result` straight in: the channel's answer carries the
      // token value, and these rows reach the deploy HTTP response.
      const summary = {
        agentId,
        ok: result.ok,
        bindingKey: result.bindingKey,
        ...(result.name ? { name: result.name } : {}),
        ...(result.patId ? { patId: result.patId } : {}),
        ...(result.code ? { code: result.code } : {}),
        ...(local ? {} : { via: "channel" }),
      };
      (result.ok ? granted : failed).push(summary);
    }
  }
  return {
    granted,
    failed,
    // The keys the deployment intends to carry. Kept even when a mint failed:
    // pruning decides "no longer declared", not "not freshly minted", so a
    // transient mint failure must not revoke a token that still works.
    keys: mintable.map((binding) => binding.bindingKey),
    skipped: db.listConnectorBindingLedger(email, packId).length - mintable.length,
  };
}

/**
 * Drop what the deployment no longer needs (add-deployment-binding-grant 2.3).
 *
 * Two kinds of leftovers, both of which would otherwise outlive their reason:
 *   - a deployment secret whose agent left the serving set or whose binding the
 *     pack stopped declaring (or stopped satisfying);
 *   - the connector PAT behind it — deleting the local row alone leaves a live
 *     credential on the connector, which is the exact leak this closes.
 *
 * Scope is the `deploy:<pack>:` namespace, so a token a person granted through
 * the interactive path is never reachable from here. A missing parent
 * credential is reported, not thrown: the local rows still go.
 */
export async function pruneDeploymentBindings({ email, packId, agentIds, keepKeys, secrets, remove, fetchImpl = fetch }) {
  const agents = [...new Set(agentIds ?? [])];
  const keys = [...new Set(keepKeys ?? [])];
  const keepPats = new Set();
  const keepSecrets = new Set();
  for (const agentId of agents) {
    for (const bindingKey of keys) {
      keepPats.add(deploymentBindingPatName(packId, agentId, bindingKey));
      keepSecrets.add(`${agentId}\u0000${deploymentBindingSecretName(bindingKey)}`);
    }
  }

  const staleSecrets = (secrets ?? []).filter(
    (row) => typeof row?.name === "string" && row.name.startsWith(DEPLOYMENT_BINDING_PREFIX) && !keepSecrets.has(`${row.agentId}\u0000${row.name}`),
  );
  for (const row of staleSecrets) remove(row.agentId, row.name);

  if (!hasLocalConnectorAccount(email) && credentialChannel()) {
    const viaChannel = await revokeBindingsViaChannel({ email, packId, agentIds: agents, fetchImpl });
    return {
      removedSecrets: staleSecrets.map((r) => ({ agentId: r.agentId, name: r.name })),
      revoked: viaChannel.revoked ?? [],
      failed: viaChannel.failed ?? [],
      ...(viaChannel.ok ? {} : { code: viaChannel.code ?? "channel_unavailable" }),
    };
  }
  const listed = await grants.listBindingTokens({ email, fetchImpl }).catch((e) => ({ ok: false, code: e?.message || "unavailable" }));
  if (!listed.ok) {
    return { removedSecrets: staleSecrets.map((r) => ({ agentId: r.agentId, name: r.name })), revoked: [], failed: [], code: listed.code ?? "unavailable" };
  }
  const prefix = deploymentBindingPatPrefix(packId);
  const stalePats = listed.pats.filter((pat) => pat.name.startsWith(prefix) && !keepPats.has(pat.name));
  const revoked = [];
  const failed = [];
  for (const pat of stalePats) {
    const result = await grants.revokeBindingTokenById({ email, patId: pat.id, fetchImpl }).catch((e) => ({ ok: false, code: e?.message || "unavailable" }));
    (result.ok ? revoked : failed).push({ name: pat.name, ...(result.ok ? {} : { code: result.code ?? "revoke_failed" }) });
  }
  return { removedSecrets: staleSecrets.map((r) => ({ agentId: r.agentId, name: r.name })), revoked, failed };
}

/**
 * Revoke every deployment token of a pack, and drop its binding secrets.
 *
 * This is the uninstall half of 2.3, and it is NOT the same event as a
 * redeploy: a pack can be uninstalled while agents it published keep serving
 * elsewhere, and revoking their credentials then would be a silent outage. So
 * the caller gates this on "this cell holds no deployment of the pack any more"
 * — the only state in which the tokens have no consumer left.
 */
export async function revokeDeploymentBindingsForPack({ email, packId, secrets, remove, fetchImpl = fetch }) {
  const rows = (secrets ?? []).filter((row) => typeof row?.name === "string" && row.name.startsWith(DEPLOYMENT_BINDING_PREFIX));
  for (const row of rows) remove(row.agentId, row.name);

  if (!hasLocalConnectorAccount(email) && credentialChannel()) {
    const viaChannel = await revokeBindingsViaChannel({ email, packId, agentIds: [], fetchImpl });
    return {
      removedSecrets: rows.length,
      revoked: viaChannel.revoked ?? [],
      failed: viaChannel.failed ?? [],
      ...(viaChannel.ok ? {} : { code: viaChannel.code ?? "channel_unavailable" }),
    };
  }
  const listed = await grants.listBindingTokens({ email, fetchImpl }).catch((e) => ({ ok: false, code: e?.message || "unavailable" }));
  if (!listed.ok) return { removedSecrets: rows.length, revoked: [], failed: [], code: listed.code ?? "unavailable" };
  const prefix = deploymentBindingPatPrefix(packId);
  const ours = listed.pats.filter((pat) => pat.name.startsWith(prefix));
  const revoked = [];
  const failed = [];
  for (const pat of ours) {
    const result = await grants.revokeBindingTokenById({ email, patId: pat.id, fetchImpl }).catch((e) => ({ ok: false, code: e?.message || "unavailable" }));
    (result.ok ? revoked : failed).push({ name: pat.name, ...(result.ok ? {} : { code: result.code ?? "revoke_failed" }) });
  }
  return { removedSecrets: rows.length, revoked, failed };
}
