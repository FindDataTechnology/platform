// ── Runner-side mediated connector executor
// (add-served-agent-connector-access D2/D9) ─────────────────────────────────
//
// One instance per runner: the egress for every facade child's
// connector_bindings / connector_call calls. The child only names a binding and
// a tool; everything the call needs to reach the platform — the packs base URL,
// the service credential, which deployment this child is — lives HERE, in host
// configuration, and never enters the child environment.
//
// Two ops:
//   list  → the binding keys this deployment declared (the descriptor already
//           carries them; no round trip, so a model can always see its options)
//   call  → one mediated connector action, executed by the platform as whoever
//           is on the other end of the turn
//
// WHO the call runs as is deliberately not this module's decision: the platform
// owns the scope→actor registration (lib/visitor-actor-registry.js) and the
// connector preflight. This module forwards the turn's `scope` — read from
// `activeSessions` at call time, exactly as matters does — and passes the
// platform's answer back, with the refusal's `hint` intact so the visitor is
// told who must fix what.
//
// The answer is passed through a WHITELIST, not verbatim. Two reasons, both
// load-bearing:
//   1. the platform's success payload carries `actor` — the raw OIDC subject.
//      Forwarding it would hand the serving plane exactly the identifier C2
//      says never travels there; the child needs to know it ran AS A VISITOR,
//      not who that person is.
//   2. the payload also carries `result` (the raw MCP reply). The tool's output
//      schema is closed (`additionalProperties: false`), so an unknown key is a
//      schema violation, and the model only ever needs `text`.
//
// The audit line carries outcome and code only. Never the arguments: they are
// the visitor's business data (the matters relay's no-content law, mirrored).

const CALL_TIMEOUT_MS = 60_000;

/**
 * Exactly the keys the child's tool schema declares. Anything else the platform
 * says stays host-side — see the header for why `actor` and `result` must not
 * cross this line.
 */
export const CHILD_VISIBLE_KEYS = Object.freeze([
  "ok",
  "reason",
  "code",
  "message",
  "hint",
  "executedAs",
  "text",
  "httpStatus",
]);

export function toChildResult(payload) {
  if (!payload || typeof payload !== "object") return payload;
  const out = {};
  for (const key of CHILD_VISIBLE_KEYS) {
    if (payload[key] !== undefined) out[key] = payload[key];
  }
  return out;
}

export function createConnectorActions({ config, log = console, fetchImpl } = {}) {
  const audit = (agent, op, out) => {
    try {
      log.log(
        `[agent-runner] connector ${op} agent=${agent ?? "?"} ok=${out?.ok === true} code=${out?.code ?? out?.reason ?? "-"} as=${out?.executedAs ?? "-"}`,
      );
    } catch {
      /* a broken logger must never break the call */
    }
  };

  const call = async (httpPath, body) => {
    const base = String(config?.packsBaseUrl || "").replace(/\/+$/, "");
    const token = config?.registryToken || "";
    if (!base || !token) {
      return { ok: false, reason: "not-configured", message: "the connector plane is not configured on this runner" };
    }
    const doFetch = fetchImpl ?? fetch;
    try {
      const res = await doFetch(base + httpPath, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      const doc = await res.json().catch(() => null);
      // The mediation route answers a non-2xx WITH a full payload (code, hint,
      // executedAs). Pass it through untouched: the tool's render needs the
      // hint, and a monitor needs the code. Only a payload-less answer (a proxy
      // page, a gateway 401 on the runner credential itself) is normalized.
      if (doc && typeof doc === "object" && typeof doc.ok === "boolean") return doc;
      return {
        ok: false,
        reason: "platform",
        httpStatus: res.status,
        message: `the connector plane answered HTTP ${res.status}`,
      };
    } catch (e) {
      const timeout = e?.name === "TimeoutError" || e?.name === "AbortError";
      return {
        ok: false,
        reason: timeout ? "timeout" : "network",
        message: timeout ? "the connector plane did not answer in time" : e?.message || String(e),
      };
    }
  };

  return {
    /**
     * handle({ packId, agentId, agentPath, agent, bindings, op, args, scope })
     *
     * `scope` is the facade-supplied visitor scope for the ACTIVE turn, read by
     * the manager at call time. Absent = no visitor on this turn (an A2A caller
     * or a background run) and the platform falls back to the deployment
     * binding, saying so. Present but unregistered is the platform's fail-closed
     * arm — this module never decides that.
     */
    async handle({ packId, agentId, agentPath = null, agent = null, bindings = [], op, args = {}, scope = null } = {}) {
      if (!packId || !agentId) {
        return { ok: false, reason: "identity", message: "connector calls need a deployment identity" };
      }

      if (op === "list") {
        const keys = (Array.isArray(bindings) ? bindings : [])
          .map((row) => (typeof row?.key === "string" ? row.key.trim() : ""))
          .filter(Boolean);
        const out = { ok: true, bindings: keys.map((key) => ({ key })) };
        audit(agent, op, out);
        return out;
      }

      if (op !== "call") return { ok: false, reason: "unknown-op", message: `unknown connector op '${op}'` };

      const binding = typeof args?.binding === "string" ? args.binding.trim() : "";
      const tool = typeof args?.tool === "string" ? args.tool.trim() : "";
      if (!binding || !tool) {
        return { ok: false, reason: "invalid-request", message: "connector_call needs a binding and a tool" };
      }

      const enc = encodeURIComponent;
      const out = await call(`/api/packs/internal/connector-action/${enc(packId)}/${enc(agentId)}`, {
        ...(agentPath ? { agent_path: agentPath } : {}),
        ...(typeof scope === "string" && scope ? { scope } : {}),
        bindingKey: binding,
        tool,
        arguments: args?.arguments && typeof args.arguments === "object" ? args.arguments : {},
      });
      audit(agent, op, out);
      // Hold the line the whole change is about: the child learns HOW the call
      // ran, never WHO it ran as.
      return toChildResult(out);
    },
  };
}
