// credential-refs.js — the credentialRef dispatch table (add-connector-credentials, design D1).
//
// `credentialRef` is a system-managed marker a server config carries instead of
// an embedded secret; the effective-profile writer resolves it to the current
// user's stored credential for that ref name at every write. This module is the
// name → resolver registry so a third ref registers here instead of forking the
// orchestration in dsh-profile/dsh-events/overlay.
//
// Every entry must satisfy the registry contract used by the three consumers:
//   refName            the literal `credentialRef` value
//   isRef(config)      does this config carry our ref?
//   liveToken(email)   the injectable token or null (= omit the server)
//   markInvalid(email) 401 handler: true when state changed (= re-apply once)
//   staleEvent         the WS event clients refresh on after invalidation
//
// registry-credentials stays the module of record for its ref (its exports are
// unchanged and still imported directly elsewhere); this table only forwards.

import * as registryCredentials from "./registry-credentials.js";
import * as connectorCredentials from "./connector-credentials.js";

const REFS = new Map(
  [
    {
      refName: registryCredentials.REGISTRY_CREDENTIAL_REF,
      isRef: registryCredentials.isRegistryRef,
      liveToken: registryCredentials.liveToken,
      markInvalid: registryCredentials.markStale,
      staleEvent: "registry_credential_stale",
    },
    {
      refName: connectorCredentials.CONNECTOR_CREDENTIAL_REF,
      isRef: connectorCredentials.isConnectorRef,
      liveToken: connectorCredentials.liveToken,
      markInvalid: connectorCredentials.markInvalid,
      staleEvent: "connector_credential_stale",
    },
  ].map((entry) => [entry.refName, entry]),
);

export function knownRef(name) {
  return REFS.has(name);
}

// The registry entry for a config's `credentialRef`, or null for an absent or
// unknown ref name — callers decide what an unknown name means (the profile
// writer omits the server; a hand-entered config is rejected outright).
export function refFor(config) {
  const name = config?.credentialRef;
  return typeof name === "string" ? REFS.get(name) ?? null : null;
}

export function isCredentialRef(config) {
  return Boolean(config?.credentialRef);
}

// Resolve every ref-carrying config in `servers` for `email`: returns a new
// object where each carried server either gained an Authorization header or was
// dropped, plus per-ref diagnostics for the omission warnings. Grouped by ref
// so one warning line covers all servers of the same ref (the registry shape).
export function resolveCredentials(servers, email) {
  const out = { ...servers };
  const omitted = [];
  const injected = [];
  try {
    for (const entry of REFS.values()) {
      const names = Object.entries(servers)
        .filter(([, config]) => entry.isRef(config))
        .map(([name]) => name);
      if (names.length === 0) continue;
      const token = entry.liveToken(email);
      if (token) {
        for (const name of names) {
          out[name] = {
            ...out[name],
            headers: { ...(out[name].headers || {}), Authorization: `Bearer ${token}` },
          };
        }
        injected.push({ ref: entry.refName, names });
      } else {
        for (const name of names) delete out[name];
        omitted.push({ ref: entry.refName, names });
      }
    }
  } catch (e) {
    // A resolver blowing up must never pass its servers through unauthenticated:
    // drop every ref-carrying server and report the failure as one omission.
    for (const [name, config] of Object.entries(servers)) {
      if (isCredentialRef(config)) delete out[name];
    }
    omitted.length = 0;
    injected.length = 0;
    return { servers: out, omitted, injected, error: e?.message || String(e) };
  }
  return { servers: out, omitted, injected };
}
