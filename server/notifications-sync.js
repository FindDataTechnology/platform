// ── Cell → gateway read-state sync (sync-broadcast-read-both-ways) ──────────
//
// A broadcast has a row in this cell's `notifications` AND a row in the
// gateway's zhiyu store. Reading it here must settle it there — the same rule
// the gateway already applies in the other direction.
//
// Fire-and-forget by design, for the same reason as the reverse path: the
// user's own read has already been written when this runs, and a gateway that
// is slow, restarting, or unreachable must never undo or delay it. The
// degradation is "zhiyu still shows it unread, read it there too" — visible and
// explainable — never "your read did not take".
//
// Inert wherever the gateway base url or the shared secret is absent (dev,
// desktop, single-tenant). That is the pre-change behaviour, not a failure.

const SYNC_TIMEOUT_MS = 5_000;

const gatewayBase = (env = process.env) =>
  String(env.GATEWAY_INTERNAL_URL || `http://127.0.0.1:${env.GATEWAY_PORT || 3080}`).replace(/\/+$/, "");

/**
 * Tell the gateway that one broadcast was read for one recipient.
 *
 * Resolves with the gateway's answer, or throws. Callers use `void ... .catch`
 * — this never rejects into a request handler.
 */
export async function syncBroadcastReadToGateway({ email, broadcastId, env = process.env, fetchImpl = fetch }) {
  const secret = String(env.CELL_GATEWAY_SECRET || "");
  if (!secret) throw new Error("no CELL_GATEWAY_SECRET configured");
  const recipient = String(email ?? "").trim().toLowerCase();
  if (!recipient || !broadcastId) throw new Error("recipient and broadcastId are required");
  const res = await fetchImpl(`${gatewayBase(env)}/api/zhiyu/notifications/read-by-broadcast`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-cloud-gateway-secret": secret },
    body: JSON.stringify({ recipient, broadcastId }),
    signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`gateway answered ${res.status}`);
  return res.json().catch(() => ({}));
}

/** True when this deployment can sync at all — callers may skip the work. */
export function broadcastSyncConfigured(env = process.env) {
  return Boolean(String(env.CELL_GATEWAY_SECRET || ""));
}
