// ── A2A client (add-agent-delegation-a2a D2) ────────────────────────────────
//
// The platform as A2A CLIENT, one reusable turn executor. Extracted from
// agent-session's streamA2aChat so two callers share one wire contract:
//   • human chat with a market agent (no depth header — depth 0);
//   • delegated a2a task execution (X-Delegation-Depth: 1; runner-side bound
//     refuses ≥3, breaking cross-request cycles — ADR-0013).
// Credentials follow the egress trust model: the deployment's registry
// service credential on X-Authorization (stripped by the gateway after
// /validate), the deployment's agent credential on Authorization end-to-end.
// SSE frames map onto { text, deltas } — callers own streaming presentation.

export const DELEGATION_DEPTH_BOUND = 3;

import * as registryCredentials from "../registry-credentials.js";

export function a2aCredentials() {
  const gatewayToken = process.env.AGENT_SERVING_REGISTRY_TOKEN || process.env.MARKET_REGISTRY_TOKEN || "";
  const agentToken = process.env.AGENT_SERVING_BACKEND_TOKEN || "";
  return { gatewayToken, agentToken };
}

// C-lite credential selection (add-agent-platform-ops D5, ADR-0013): on a
// HOSTED cell the owner's PERSONAL registry credential carries a2a traffic
// (per-user attribution; the connect flow assigns the invoke-only group). A
// local single-owner machine rides the deployment service credential. A
// hosted cell with no stored credential fails with connect guidance — never
// a silent substitution.
export function resolveGatewayCredential({ ownerEmail, cloudMode }) {
  const service = process.env.AGENT_SERVING_REGISTRY_TOKEN || process.env.MARKET_REGISTRY_TOKEN || "";
  if (!cloudMode || !ownerEmail) {
    return { gatewayToken: service, fallback: !cloudMode && !ownerEmail ? "service" : "service" };
  }
  const { liveToken } = registryCredentials;
  const personal = liveToken(ownerEmail);
  if (personal) return { gatewayToken: personal, fallback: null };
  const err = new Error(
    "connect the MCP market first — delegated and a2a calls need your personal registry credential (Settings → MCP 市场 → 连接)",
  );
  err.code = -32012;
  throw err;
}

// One message/stream turn against `url`. Returns { text } (the accumulated
// final). `onDelta` receives incremental text. Throws structured errors —
// callers surface them as turn failures; nothing here retries.
export async function runA2aTurn(url, text, {
  contextId,
  depth = 0,
  gatewayToken,
  agentToken,
  onDelta,
  signal,
  timeoutMs = 300_000,
} = {}) {
  if (!gatewayToken) {
    throw new Error("no registry service credential configured (MARKET_REGISTRY_TOKEN) — cannot call the A2A gateway");
  }
  if (!agentToken) {
    throw new Error("A2A agent credential not configured (AGENT_SERVING_BACKEND_TOKEN)");
  }
  const headers = {
    "Content-Type": "application/json",
    "X-Authorization": `Bearer ${gatewayToken}`,
    Authorization: `Bearer ${agentToken}`,
  };
  // Only DELEGATED traffic carries a depth (spec: agent-delegation-a2a) — a
  // human chat is depth 0 and sends no header.
  if (depth >= 1) headers["X-Delegation-Depth"] = String(depth);
  if (depth >= DELEGATION_DEPTH_BOUND) {
    throw new Error(`delegation depth bound (${DELEGATION_DEPTH_BOUND}) reached — refusing to chain further`);
  }

  const timeout = setTimeout(() => signal?.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "message/stream",
        params: { message: { role: "user", parts: [{ kind: "text", text }], context_id: contextId } },
      }),
      signal,
    });
    if (!r.ok) throw new Error(`A2A HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const ctype = r.headers.get("content-type") || "";
    if (!ctype.includes("text/event-stream")) {
      // A JSON body answers with a JSON-RPC error object (auth/agent failures).
      const doc = await r.json().catch(() => null);
      const msg = doc?.error?.message || `unexpected content-type ${ctype || "(none)"}`;
      throw new Error(`A2A: ${msg}`);
    }
    const decoder = new TextDecoder();
    let buf = "";
    let acc = "";
    let finalText = "";
    for await (const chunk of r.body) {
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      let event = null;
      for (const line of lines) {
        const l = line.trim();
        if (l.startsWith("event:")) {
          event = l.slice(6).trim();
          continue;
        }
        if (!l.startsWith("data:")) continue;
        let doc = null;
        try {
          doc = JSON.parse(l.slice(5).trim());
        } catch {
          continue;
        }
        if (event === "delta") {
          const parts = doc?.parts ?? [];
          const t = parts.map((p) => (typeof p?.text === "string" ? p.text : "")).join("");
          if (t) {
            const delta = t.startsWith(acc) ? t.slice(acc.length) : "";
            acc = t;
            if (delta) onDelta?.(delta);
          }
        } else if (event === "message") {
          const parts = doc?.parts ?? [];
          finalText = parts.map((p) => (typeof p?.text === "string" ? p.text : "")).join("");
        } else if (event === "error") {
          throw new Error(`A2A: ${doc?.message || doc?.error?.message || "stream error"}`);
        }
      }
    }
    return { text: finalText || acc };
  } finally {
    clearTimeout(timeout);
  }
}
