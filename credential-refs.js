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
//   liveToken(email, config)
//                      the injectable token or null (= omit the server). config
//                      is passed because a ref may resolve DIFFERENT tokens for
//                      different rows of the same ref — `connector-binding`
//                      does exactly that (one scoped PAT per binding slot). The
//                      single-token refs simply ignore the second argument.
//   markInvalid(email, config) 401 handler: true when state changed (= re-apply once)
//   staleEvent         the WS event clients refresh on after invalidation
//
// registry-credentials stays the module of record for its ref (its exports are
// unchanged and still imported directly elsewhere); this table only forwards.

import * as registryCredentials from "./registry-credentials.js";
import * as connectorCredentials from "./connector-credentials.js";
import * as connectorBindings from "./connector-bindings.js";
import * as facetMarketCredentials from "./facet-market-credentials.js";
import * as lineCredentials from "./line-credentials.js";
import * as paperTradingCredentials from "./paper-trading-credentials.js";
import * as ciyuanAccountCredentials from "./ciyuan-account-credentials.js";
// Wire line tool hosting: the vendored tool_risk snapshot is a generated,
// import-only module (safe from cycles) — derive the server set from it rather
// than hand-editing the snapshot. The registry's public API does not surface
// metadata.credential_ref, so the credential dispatch derives the ref from tool
// hosting instead: any market entry of these names installs with — and its
// sessions inject — the USER's wire-customer ID token. A wgk- key (the
// incumbent registry credential) only speaks the wire data plane; every
// control-plane read in these servers 401s (real-machine acceptance 10-21).
import { WIRE_TOOL_RISK } from "./lib/wire-tool-risk.js";
import * as chatwootCredentials from "./chatwoot-credentials.js";
const WIRE_LINE_SERVERS = new Set(Object.values(WIRE_TOOL_RISK).map((w) => w.server));

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
    {
      refName: facetMarketCredentials.FACET_MARKET_CREDENTIAL_REF,
      isRef: facetMarketCredentials.isFacetMarketRef,
      liveToken: facetMarketCredentials.liveToken,
      markInvalid: facetMarketCredentials.markInvalid,
      staleEvent: "facet_market_credential_stale",
    },
    {
      refName: paperTradingCredentials.PAPER_TRADING_CREDENTIAL_REF,
      isRef: paperTradingCredentials.isPaperTradingRef,
      liveToken: paperTradingCredentials.liveToken,
      markInvalid: paperTradingCredentials.markInvalid,
      staleEvent: "paper_trading_credential_stale",
    },
    {
      refName: lineCredentials.WIRE_CUSTOMER_CREDENTIAL_REF,
      isRef: lineCredentials.isWireCustomerRef,
      liveToken: (email) => lineCredentials.liveToken(email, "wire-customer"),
      markInvalid: (email) => lineCredentials.markInvalid(email, "wire-customer"),
      // Refresh-first on 401 (add-line-credential-renewal D4): server-side
      // recovery attempt before invalidation.
      renewOn401: (email) => lineCredentials.renewOn401(email, "wire-customer"),
      staleEvent: "line_credential_stale",
      // Install-gate fields (fix-wire-install-gate D1): the gate must judge
      // liveness by THIS ref's own resolver — falling through to the registry
      // check refused wire-line installs for customers whose registry was
      // never connected (2026-10-24, wire-tester2). Same resolution the
      // profile writer applies, so "connected" = the install will inject.
      connected: (email) => Boolean(lineCredentials.liveToken(email, "wire-customer")),
      missingReason: "connect your wire line first — no live wire credential",
    },
    {
      refName: lineCredentials.LEX_CREDENTIAL_REF,
      isRef: lineCredentials.isLexRef,
      liveToken: (email) => lineCredentials.liveToken(email, "lex"),
      markInvalid: (email) => lineCredentials.markInvalid(email, "lex"),
      renewOn401: (email) => lineCredentials.renewOn401(email, "lex"),
      staleEvent: "line_credential_stale",
      connected: (email) => Boolean(lineCredentials.liveToken(email, "lex")),
      missingReason: "connect your lex line first — no live lex credential",
    },
    {
      // ciyuan-account-lane (design D5): the wanxing-caller ref is served by the
      // user's bound 词元 account key first, a legacy pasted caller key second —
      // one key for the model lane and the operations MCP alike.
      refName: lineCredentials.WANXING_CALLER_CREDENTIAL_REF,
      isRef: lineCredentials.isWanxingCallerRef,
      liveToken: (email) => ciyuanAccountCredentials.liveToken(email),
      markInvalid: (email) => ciyuanAccountCredentials.markStale(email),
      staleEvent: "line_credential_stale",
      connected: (email) => Boolean(ciyuanAccountCredentials.liveToken(email)),
      missingReason: "connect your Wanxing caller key first — no live caller credential",
    },
    {
      // add-crm-desk-pack-embed: the merchant's own Chatwoot token — cell patch
      // env (credentialEnv) and the gated send execution alike. Paste family.
      refName: chatwootCredentials.CHATWOOT_CREDENTIAL_REF,
      isRef: chatwootCredentials.isChatwootRef,
      liveToken: (email) => chatwootCredentials.liveToken(email),
      markInvalid: (email) => chatwootCredentials.markInvalid(email),
      staleEvent: "chatwoot_credential_stale",
    },
    {
      // add-connector-bindings D4: one connector MCP row per authorized binding,
      // each with that BINDING's scoped token — the single global `connector` row
      // is retired (its mcp.json entry survives as a url-only template). The
      // token resolves by slot, so two rows never share one, and a 401 marks
      // exactly the row that failed.
      refName: connectorBindings.CONNECTOR_BINDING_CREDENTIAL_REF,
      isRef: (config) => config?.credentialRef === connectorBindings.CONNECTOR_BINDING_CREDENTIAL_REF,
      liveToken: (email, config) => connectorBindings.liveTokenBySlot(email, config?.slot),
      markInvalid: (email, config) => connectorBindings.markSlotInvalid(email, config?.slot),
      staleEvent: "connector_credential_stale",
    },
  ].map((entry) => [entry.refName, entry]),
);

// The gateway credential (one per identity, minted by the registry SSO) is what
// makes a dual-credential server possible: it authenticates the caller to the
// gateway while the server's OWN credential rides X-Authorization upstream.
const gatewayEntry = REFS.get(registryCredentials.REGISTRY_CREDENTIAL_REF);

// A server reached through the MCP gateway rather than a direct upstream. Only
// there does the Authorization header belong to the gateway instead of the
// server: a direct URL has no gateway to authenticate to, so relaying must not
// apply (the server's own token stays in Authorization, as before).
const GATEWAY_HOST = "mcp.finddatatech.cloud";

export function isGatewayUrl(url) {
  if (typeof url !== "string" || !url) return false;
  try {
    return new URL(url).hostname.toLowerCase() === GATEWAY_HOST;
  } catch {
    return false;
  }
}

export function knownRef(name) {
  return REFS.has(name);
}

// ── Install-path dispatch (add-facet-market-credentials D4; hoisted here when
// the second consumer appeared — add-paper-trading-credentials) ─────────────
// Which 壹座-side credentialRef a registry entry's install must wire and
// require: the registering line declares it via metadata.credential_ref
// (mapped onto entry.credentialRef by registry-bridge); absent = the
// incumbent registry credential. Consumed by BOTH install paths — the pack
// install (pack-store) and the market card install (routes/extensions) —
// which is why it lives on the dispatch table, not in one consumer.

export function credentialRefForEntry(entry) {
  if (entry?.credentialRef) return entry.credentialRef;
  if (entry?.name && WIRE_LINE_SERVERS.has(entry.name)) {
    return lineCredentials.WIRE_CUSTOMER_CREDENTIAL_REF;
  }
  return registryCredentials.REGISTRY_CREDENTIAL_REF;
}

// Refs whose credential belongs to the END USER and is verified by the upstream
// itself (wire/lex Logto ID tokens, facet device tokens). A server installed
// with one of these and reached THROUGH the gateway needs the dual-credential
// shape: the gateway authenticates the caller with its own token, and the
// caller's own credential rides X-Authorization upstream (auth-server's
// INGRESS_RELAY_SERVERS). Without it the gateway strips the caller's auth and
// every call 401s.
//
// Derived, not configured: these servers are composed from the market catalog at
// profile-write time, so there is no `extension_configs` row to carry a flag —
// grep confirms zero such rows for wire/lex/facet. Deriving from the ref keeps
// the behaviour correct for every install path (pack store and market card)
// without asking anyone to remember a flag.
const RELAY_REF_NAMES = new Set([
  lineCredentials.WIRE_CUSTOMER_CREDENTIAL_REF,
  lineCredentials.LEX_CREDENTIAL_REF,
  facetMarketCredentials.FACET_MARKET_CREDENTIAL_REF,
]);

export function needsRelayedCallerCredential(config, refName) {
  if (!isGatewayUrl(config?.url)) return false;
  if (config?.relayCallerCredential === true) return true;   // explicit opt-in wins
  return RELAY_REF_NAMES.has(refName);
}

export function credentialConnected(refName, email) {
  // Table-first (fix-wire-install-gate D1): an entry that declares `connected`
  // is judged by its own resolver — a line ref falling through to the registry
  // check refused installs for the wrong missing credential. Entries without
  // the field keep the legacy chain below, byte-identical.
  const entry = REFS.get(refName);
  if (typeof entry?.connected === "function") return entry.connected(email);
  if (refName === facetMarketCredentials.FACET_MARKET_CREDENTIAL_REF) {
    return facetMarketCredentials.status(email).connected;
  }
  if (refName === chatwootCredentials.CHATWOOT_CREDENTIAL_REF) {
    return chatwootCredentials.status(email).connected;
  }
  if (refName === paperTradingCredentials.PAPER_TRADING_CREDENTIAL_REF) {
    return paperTradingCredentials.status(email).connected;
  }
  return registryCredentials.status(email).connected;
}

// Human-readable "what to connect" for a refused install, per ref (the 409
// body's reason; the UI turns it into the connect-card pointer).
export function credentialMissingReason(refName) {
  const entry = REFS.get(refName);
  if (typeof entry?.missingReason === "string") return entry.missingReason;
  if (refName === facetMarketCredentials.FACET_MARKET_CREDENTIAL_REF) {
    return "pair the facet market first — no live market credential";
  }
  if (refName === chatwootCredentials.CHATWOOT_CREDENTIAL_REF) {
    return "connect your Chatwoot account first — no live Chatwoot credential";
  }
  if (refName === paperTradingCredentials.PAPER_TRADING_CREDENTIAL_REF) {
    return "connect the paper-trading service first — no live paper-trading credential";
  }
  return "connect the MCP market first — no live registry credential";
}

// Where the connect card for a ref lives (connection-center): the Settings
// connections section, on the ref's own panel. Consumed by both install paths
// alongside credentialMissingReason so the UI can deep-link the exact card.
export function connectPathForRef(refName) {
  return `/settings/connections?panel=${connectPanelForRef(refName)}`;
}
// The connect panel id for a ref name (chat-connect-guidance consumes this
// to point failed tool calls at the right card without parsing the path).
export function connectPanelForRef(refName) {
  return KNOWN_CONNECT_PANELS.get(refName) ?? "registry";
}
const KNOWN_CONNECT_PANELS = new Map([
  [registryCredentials.REGISTRY_CREDENTIAL_REF, "registry"],
  [facetMarketCredentials.FACET_MARKET_CREDENTIAL_REF, "facet-market"],
  [paperTradingCredentials.PAPER_TRADING_CREDENTIAL_REF, "paper-trading"],
  ["wire-customer", "line-wire-customer"],
  ["lex", "line-lex"],
  ["wanxing-caller", "ciyuan-account"],
  [chatwootCredentials.CHATWOOT_CREDENTIAL_REF, "chatwoot"],
  [connectorBindings.CONNECTOR_BINDING_CREDENTIAL_REF, "connector-bindings"],
]);

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

// Resolve one ref NAME for one user — the same resolution the profile writer
// applies per server, for callers that hold a name instead of a server config
// (action preflight and the action executor, add-line-boards-and-action-gate).
// A name the table does not list falls back to the line-credentials store so a
// registered action can name any ref the platform stores (wanxing-deployer is
// preflight-only today and lives there alone).
//
// `config` is optional and only matters for a ref whose token depends on the
// row it is attached to (connector-binding). Callers that hold a config must
// pass it; callers that only have a name keep the single-token behaviour.
export function liveTokenForRef(refName, email, config = null) {
  if (typeof refName !== "string" || !refName) return null;
  const entry = REFS.get(refName);
  if (entry) return entry.liveToken(email, config) || null;
  return lineCredentials.liveToken(email, refName) || null;
}

// The 401 handler for a ref name; true when state changed (= re-apply once).
// `config` selects WHICH row of a per-row ref failed (connector-binding).
export function invalidateRef(refName, email, config = null) {
  if (typeof refName !== "string" || !refName) return false;
  const entry = REFS.get(refName);
  if (entry) return Boolean(entry.markInvalid(email, config));
  return Boolean(lineCredentials.markInvalid(email, refName));
}

// Resolve every ref-carrying config in `servers` for `email`: returns a new
// object where each carried server either gained an Authorization header or was
// dropped, plus per-ref diagnostics for the omission warnings. Grouped by ref
// so one warning line covers all servers of the same ref (the registry shape).
//
// Resolution is PER SERVER, not per ref: a ref may hand out a different token
// to each row (connector-binding: one scoped PAT per binding), so a single
// per-ref token would collapse every binding onto one authority. For the
// single-token refs the result is byte-identical to the old per-ref loop —
// every row of that ref resolves to the same value.
export function resolveCredentials(servers, email) {
  const out = { ...servers };
  const omitted = [];
  const injected = [];
  try {
    for (const entry of REFS.values()) {
      const rows = Object.entries(servers).filter(([, config]) => entry.isRef(config));
      if (rows.length === 0) continue;
      const injectedNames = [];
      const omittedNames = [];
      for (const [name, config] of rows) {
        const token = entry.liveToken(email, config);
        if (!token) {
          delete out[name];
          omittedNames.push(name);
          continue;
        }
        if (needsRelayedCallerCredential(out[name], entry.refName)) {
          // Dual credential (relayCallerCredential): the gateway authenticates
          // the CALLER with its own token, and forwards the caller's own
          // credential to the upstream as X-Authorization (auth-server's
          // INGRESS_RELAY_SERVERS). Servers whose upstream authenticates the
          // end user — wire/lex Logto ID tokens, facet device tokens — are
          // otherwise unusable through the gateway: the gateway strips the
          // caller's Authorization, and the designed alternative (egress vault)
          // needs a secret store this deployment does not have.
          // Fail closed: no gateway credential -> omit the server entirely,
          // never fall back to putting a foreign token in Authorization.
          const gatewayToken = gatewayEntry?.liveToken(email, {
            credentialRef: gatewayEntry?.refName,
          });
          if (!gatewayToken) {
            delete out[name];
            omittedNames.push(name);
            continue;
          }
          out[name] = {
            ...out[name],
            headers: {
              ...(out[name].headers || {}),
              Authorization: `Bearer ${gatewayToken}`,
              "X-Authorization": `Bearer ${token}`,
            },
          };
          injectedNames.push(name);
          continue;
        }
        out[name] = {
          ...out[name],
          headers: { ...(out[name].headers || {}), Authorization: `Bearer ${token}` },
        };
        injectedNames.push(name);
      }
      if (injectedNames.length) injected.push({ ref: entry.refName, names: injectedNames });
      if (omittedNames.length) omitted.push({ ref: entry.refName, names: omittedNames });
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
