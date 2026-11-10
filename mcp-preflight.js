// MCP preflight health signal (add-mcp-credential-hygiene D5).
//
// At every MCP-patch composition moment (install, server edits, profile
// apply — all funnel through dsh-profile.js writeMcpPatch) the host probes
// each streamable-http server with the EXACT url+headers the patch carries,
// and records ok / auth-rejected / server-error / unreachable / unknown per
// server. This is the platform-side replacement for flipping
// failOnStartupError (which would let one flaky upstream kill the whole
// session — dsh-mcp-client's "throw" registration failure fires in plugin
// apply): the patch still writes, the tools still (don't) register
// silently, but the diagnosis endpoint says WHY.
//
// Contract (spec mcp-integration, preflight scenarios):
//   - probing NEVER blocks or fails the patch write (fire-and-forget),
//   - a probe that cannot run at all reports `unknown`, never ok/failed,
//   - each initialize session is explicitly DELETEd — daas-mcp's session
//     pool filled up with abandoned sessions once (2026-10-13 503); a
//     liveness probe must not become the next leak source.
//
// State: in-memory map + write-through JSON (atomicWriteJsonSync → 0600),
// loaded once at import so restarts keep timestamps. Secret-free by
// construction: server names, states, timestamps, HTTP status snippets.

import { join } from "node:path";
import { readJsonOr, atomicWriteJsonSync } from "./lib/persistence.js";
import { storeDir } from "./paths.js";

// State lands beside the other runtime stores (storeDir, not repoRoot): the
// image ships the app tree read-only under /app, so a repo-root write fails
// in every hosted deployment.
const STATE_FILE = process.env.MCP_PREFLIGHT_FILE || join(storeDir("data"), "mcp-preflight.json");
const PROBE_TIMEOUT_MS = Number(process.env.MCP_PREFLIGHT_TIMEOUT_MS) || 4000;

const PERSISTED = readJsonOr(STATE_FILE, { servers: {} }, { label: "mcp-preflight" });
const state = new Map(Object.entries(PERSISTED.servers || {}));

function persist() {
  try {
    atomicWriteJsonSync(STATE_FILE, { servers: Object.fromEntries(state) });
  } catch (e) {
    console.warn(`[mcp-preflight] state persist failed (continuing in-memory): ${e?.message || e}`);
  }
}

function setState(name, probeState, detail) {
  state.set(name, { state: probeState, checkedAt: new Date().toISOString(), detail: detail || "" });
}

// Probe ONE streamable-http server. Exported for tests (fetchImpl injection).
// Returns the recorded state entry.
export async function probeOne(serverName, { url, headers = {} }, { fetchImpl = fetch, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "platform-mcp-preflight", version: "1" },
    },
  });
  const rpcHeaders = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(headers || {}),
  };
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: rpcHeaders,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Terminate the session we just opened (best effort; stateless servers
    // return no mcp-session-id and skip this).
    const sessionId = res.headers?.get?.("mcp-session-id");
    if (sessionId) {
      void fetchImpl(url, {
        method: "DELETE",
        headers: { ...rpcHeaders, "mcp-session-id": sessionId },
        signal: AbortSignal.timeout(timeoutMs),
      }).catch(() => {});
    }
    if (res.ok) {
      let server = "";
      try {
        const payload = JSON.parse(await res.text());
        const si = payload?.result?.serverInfo;
        if (si) server = ` (${si.name ?? "?"}@${si.version ?? "?"})`;
      } catch { /* SSE/plain bodies — detail is advisory only */ }
      setState(serverName, "ok", `initialize 200${server}`.trim());
    } else if (res.status === 401 || res.status === 403) {
      setState(serverName, "auth-rejected", `initialize ${res.status}`);
    } else {
      setState(serverName, "server-error", `initialize ${res.status}`);
    }
  } catch (err) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError" || err?.name === "TypeError") {
      setState(serverName, "unreachable", String(err?.message || err?.name || err).slice(0, 120));
    } else {
      // The probe itself broke (unexpected exception shape) — per the spec
      // this is `unknown`, never a verdict on the server.
      setState(serverName, "unknown", String(err?.message || err).slice(0, 120));
    }
  }
  return state.get(serverName);
}

// Probe every streamable-http entry of a freshly composed patch. Called
// fire-and-forget from writeMcpPatch — never awaited on the write path.
export async function probeHttpServers(entries, opts = {}) {
  const httpEntries = (entries || []).filter((e) => e?.config?.transport === "streamable-http" && e?.config?.url);
  if (httpEntries.length === 0) return [];
  await Promise.allSettled(
    httpEntries.map((e) => probeOne(e.config.serverName, { url: e.config.url, headers: e.config.headers }, opts)),
  );
  persist();
  for (const e of httpEntries) {
    const s = state.get(e.config.serverName);
    if (s && s.state !== "ok") console.warn(`[mcp-preflight] ${e.config.serverName}: ${s.state} (${s.detail})`);
  }
  return httpEntries.map((e) => ({ name: e.config.serverName, ...state.get(e.config.serverName) }));
}

// Read side for /api/diagnostics/mcp.
export function getPreflightStatus() {
  return [...state.entries()]
    .map(([name, s]) => ({ name, ...s }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
