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

/**
 * The depth to stamp on an OUTBOUND delegated turn (add-team-as-a2a-agent 1.1).
 *
 * `inbound` is the chain position of the request that CAUSED this turn, read
 * from `origin.fleet.depth` (absent = 0 = top level). The rule is arithmetic,
 * not judgement: a turn that arrived as a delegation continues the chain, so it
 * ships inbound + 1; a turn with no inbound stops being a delegation and ships
 * the lane's own baseline.
 *
 * The baseline differs by lane, and that difference is the whole point of the
 * `topLevel` parameter:
 *   - cron/manual a2a work is delegated traffic by definition → 1 (a header).
 *   - a human chat with a remote agent is NOT delegated traffic → 0 (no header
 *     at all; spec: agent-delegation-a2a, and `runA2aTurn` only sends the header
 *     for depth ≥ 1).
 *
 * Before this existed, cron shipped a hardcoded 1 and the chat lane shipped
 * nothing, so a second hop still looked like a first one and the bound could
 * never trip. Junk (NaN, negative, non-number) reads as "no inbound" rather than
 * poisoning the chain.
 */
export function outboundDelegationDepth(inbound, { topLevel = 1 } = {}) {
  const n = Number.isFinite(inbound) && inbound > 0 ? Math.floor(inbound) : 0;
  return n > 0 ? n + 1 : topLevel;
}

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
//
// Deadline ownership (fix-a2a-call-timeout D1/D2): the bound aborts OUR
// controller, never the caller's AbortSignal. An AbortSignal has no abort() —
// the old timer called `signal?.abort()`, which (a) was a silent no-op for
// every caller that passed no signal (the delegated lane hung forever) and
// (b) threw an uncaught TypeError from a timer callback when a signal WAS
// passed (no uncaughtException handler anywhere → process exit; the zhiyu
// agent lane, which passes a never-aborted controller, was one 300s answer
// away from that). A caller signal now only feeds cancellations IN.
// `timeoutMs` is the caller's budget when given — never overridden by the
// default, which only serves callers that pass neither a signal nor a budget.
export const DEFAULT_A2A_TIMEOUT_MS = 300_000;

export async function runA2aTurn(url, text, {
  contextId,
  depth = 0,
  gatewayToken,
  agentToken,
  onDelta,
  signal,
  timeoutMs = DEFAULT_A2A_TIMEOUT_MS,
  metadata = null, // optional A2A message.metadata (e.g. visitor_scope — add-zhiyu-room)
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

  const controller = new AbortController();
  let timedOut = false;
  // One-way: a caller abort cancels the call; our bound never aborts the
  // caller's controller.
  const onCallerAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) onCallerAbort();
    else signal.addEventListener("abort", onCallerAbort, { once: true });
  }
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "message/stream",
        params: {
          message: {
            role: "user",
            parts: [{ kind: "text", text }],
            context_id: contextId,
            ...(metadata && typeof metadata === "object" ? { metadata } : {}),
          },
        },
      }),
      signal: controller.signal,
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
  } catch (e) {
    // Our bound fired: attribute it. The message carries the word "timeout" on
    // purpose — classifyErrorKind (server/fleet-events.js) maps that pattern to
    // the existing `timeout` kind, so turn ledgers gain attribution with no new
    // error class. A caller-initiated abort keeps throwing the raw AbortError
    // (human-chat treats "user stopped" as a silent finish — that must not turn
    // into a timeout error).
    if (timedOut) {
      let host = url;
      try { host = new URL(url).host; } catch { /* keep the raw url */ }
      const err = new Error(`A2A call timeout after ${timeoutMs}ms — no complete response from ${host}`);
      err.code = "a2a_timeout";
      err.timeoutMs = timeoutMs;
      err.cause = e;
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onCallerAbort);
  }
}
