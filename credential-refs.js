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
import * as lawBenchCredentials from "./law-bench-credentials.js";
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
// 数据驱动的线凭据轨（converge-line-identity-and-keys D4）：默认关闭，
// 开启的那一行会以同形五件套并入 REFS，未开启时本表与改动前一致。
import * as federatedRef from "./federated-ref.js";
const WIRE_LINE_SERVERS = new Set(Object.values(WIRE_TOOL_RISK).map((w) => w.server));

const REFS = new Map(
  [
    {
      refName: registryCredentials.REGISTRY_CREDENTIAL_REF,
      isRef: registryCredentials.isRegistryRef,
      liveToken: registryCredentials.liveToken,
      markInvalid: registryCredentials.markStale,
      staleEvent: "registry_credential_stale",
      connected: (email) => registryCredentials.status(email).connected,
      missingReason: "connect the MCP market first — no live registry credential",
      panel: "registry",
    },
    {
      refName: connectorCredentials.CONNECTOR_CREDENTIAL_REF,
      isRef: connectorCredentials.isConnectorRef,
      liveToken: connectorCredentials.liveToken,
      markInvalid: connectorCredentials.markInvalid,
      staleEvent: "connector_credential_stale",
      // fix-connector-ref-attribution: 三处都必须由 connector **自己**回答。
      // 去重前它们一律落到 registry 缺省，于是被拒的 connector 安装给出的是
      // 「市场凭据」的理由、并把用户深链到市场卡片——而 UI 里那张 connector
      // 卡片（web/.../ConnectionsSection.tsx `ids={["connector"]}`）才是该去的地方。
      // 反向也错：有 connector PAT 但没 registry token 的用户会被误拒安装。
      connected: (email) => Boolean(connectorCredentials.liveToken(email)),
      missingReason: "connect a connector account first — no live connector credential",
      panel: "connector",
    },
    {
      refName: facetMarketCredentials.FACET_MARKET_CREDENTIAL_REF,
      isRef: facetMarketCredentials.isFacetMarketRef,
      liveToken: facetMarketCredentials.liveToken,
      markInvalid: facetMarketCredentials.markInvalid,
      staleEvent: "facet_market_credential_stale",
      connected: (email) => facetMarketCredentials.status(email).connected,
      missingReason: "pair the facet market first — no live market credential",
      panel: "facet-market",
    },
    {
      refName: paperTradingCredentials.PAPER_TRADING_CREDENTIAL_REF,
      isRef: paperTradingCredentials.isPaperTradingRef,
      liveToken: paperTradingCredentials.liveToken,
      markInvalid: paperTradingCredentials.markInvalid,
      staleEvent: "paper_trading_credential_stale",
      connected: (email) => paperTradingCredentials.status(email).connected,
      missingReason: "connect the paper-trading service first — no live paper-trading credential",
      panel: "paper-trading",
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
      panel: "line-wire-customer",
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
      panel: "line-lex",
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
      panel: "ciyuan-account",
    },
    {
      // add-crm-desk-pack-embed: the merchant's own Chatwoot token — cell patch
      // env (credentialEnv) and the gated send execution alike. Paste family.
      refName: chatwootCredentials.CHATWOOT_CREDENTIAL_REF,
      isRef: chatwootCredentials.isChatwootRef,
      liveToken: (email) => chatwootCredentials.liveToken(email),
      markInvalid: (email) => chatwootCredentials.markInvalid(email),
      staleEvent: "chatwoot_credential_stale",
      connected: (email) => chatwootCredentials.status(email).connected,
      missingReason: "connect your Chatwoot account first — no live Chatwoot credential",
      panel: "chatwoot",
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
      // 5.1 把面板从 KNOWN_CONNECT_PANELS 挪进本表；上游新增这条 ref 时表还没有
      // 它，合并时补上，否则它会静默落到 registry 卡片（与 connector 旧缺陷同型）。
      panel: "connector-bindings",
    },
    {
      // gateway-reach-for-shared-token-mcp: law-bench-mcp authenticates every
      // caller with ONE deployment-scoped token, so this ref resolves from env
      // rather than the user's store — and it only makes sense on a gateway URL,
      // where `resolveCredentials()` puts the gateway identity in Authorization
      // and this token in X-Authorization for the relay.
      refName: lawBenchCredentials.LAW_BENCH_CREDENTIAL_REF,
      isRef: lawBenchCredentials.isLawBenchRef,
      liveToken: () => lawBenchCredentials.liveToken(),
      markInvalid: () => lawBenchCredentials.markInvalid(),
      staleEvent: "law_bench_credential_stale",
      connected: () => lawBenchCredentials.status().connected,
      missingReason: "deployment is missing LAW_BENCH_MCP_TOKEN — no shared law-bench token",
    },
    // 已启用的联邦线（默认空数组；见 federated-ref.js 的两层开关）。
    ...federatedRef.entries(),
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
  // Shared-token upstreams need the same shape for a different reason: the
  // gateway strips the caller's auth, so the upstream's own token must travel
  // in X-Authorization or it arrives anonymous (gateway-reach-for-shared-token-mcp).
  lawBenchCredentials.LAW_BENCH_CREDENTIAL_REF,
]);

export function needsRelayedCallerCredential(config, refName) {
  if (!isGatewayUrl(config?.url)) return false;
  if (config?.relayCallerCredential === true) return true;   // explicit opt-in wins
  return RELAY_REF_NAMES.has(refName);
}
// 以下三个查询一律**只读表**（change converge-line-identity-and-keys 5.1）：
// 一条线的面板 id / 缺凭据话术 / 是否已连接都是它自己那一行的字段，不再有
// 名字分叉的 if 链。新增一条线=加一行，不加分支。
// 缺字段的条目保持既有落点（registry），这是行为兼容，不是设计意图。

export function credentialConnected(refName, email) {
  // fix-wire-install-gate D1: 由该 ref 自己的 resolver 判定——线 ref 落到
  // registry 检查会把「装得上」误判成「缺错凭据」（2026-10-24 wire-tester2）。
  const entry = REFS.get(refName);
  if (typeof entry?.connected === "function") return entry.connected(email);
  return registryCredentials.status(email).connected;
}

// Human-readable "what to connect" for a refused install, per ref (the 409
// body's reason; the UI turns it into the connect-card pointer).
export function credentialMissingReason(refName) {
  const entry = REFS.get(refName);
  if (typeof entry?.missingReason === "string") return entry.missingReason;
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
  return REFS.get(refName)?.panel ?? "registry";
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

// 配置自身是否已经带鉴权（线自有轨）。D5 的降级只在**这条为真**时才保留
// 该 server：保留一个没有凭据的条目等于让调用方发出裸请求，比省略更糟。
function hasOwnAuth(config) {
  const headers = config?.headers || {};
  for (const [name, value] of Object.entries(headers)) {
    if (/^x?-?authorization$/i.test(name) && String(value || "").trim()) return true;
  }
  const env = config?.env || {};
  for (const [name, value] of Object.entries(env)) {
    if (/(TOKEN|API_KEY|AUTH)/i.test(name) && typeof value === "string" && value.trim()) return true;
  }
  return Boolean(config?.credentialEnv);
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
  // D5：平台凭据不可用但线自有轨仍在 → 保留该 server 并显式记账，而不是删掉。
  const degraded = [];
  try {
    for (const entry of REFS.values()) {
      const rows = Object.entries(servers).filter(([, config]) => entry.isRef(config));
      if (rows.length === 0) continue;
      const injectedNames = [];
      const omittedNames = [];
      // D5：平台凭据不可用但线自有轨仍在——保留该 server 并显式记账。
      const degradedNames = [];
      for (const [name, config] of rows) {
        const token = entry.liveToken(email, config);
        if (!token) {
          // D5（本 change 唯一的 BEHAVIOUR CHANGE）：平台通道不可用但该线自有
          // 轨的凭据已经在这份配置里（例如 cell env 注入的 wdk_/PAT），删掉这个
          // server 等于把"平台挂=子线功能消失"焊死。保留它、不注入平台 token、
          // 记一条降级；**只有配置自身带凭据时才保留**——保留一个没有凭据的条目
          // 等于让调用方发裸请求，比省略更糟。
          if (entry.hasOwnTrack && hasOwnAuth(out[name])) {
            degradedNames.push(name);
            continue;
          }
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
      if (degradedNames.length) {
        degraded.push({
          ref: entry.refName,
          names: degradedNames,
          reason: "no live platform credential; line own auth retained",
        });
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
    return { servers: out, omitted, injected, degraded, error: e?.message || String(e) };
  }
  return { servers: out, omitted, injected, degraded };
}
