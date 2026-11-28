// law-bench-credentials.js — shared service token for the law-bench MCP surface
// (gateway-reach-for-shared-token-mcp).
//
// Unlike the wire/lex refs, this is NOT a per-user credential: law-bench-mcp
// authenticates every caller with ONE shared token (`MCP_HTTP_TOKEN`, compared
// exactly by `_TokenGuard`), so there is nothing per-identity to resolve and
// nothing to invalidate on a 401 (a wrong shared token is a deployment fact,
// not a user's stale login).
//
// Why the platform needs it at all: calls go through the MCP gateway, which
// strips the caller's auth unless the server is in `INGRESS_RELAY_SERVERS`, and
// even then only forwards what the caller sent. So the caller must put the
// shared token somewhere the upstream will read *after* relay — that is
// `X-Authorization`, while `Authorization` carries the gateway identity
// (`credential-refs.js` dual-credential branch).
//
// The token comes from the deployment, not the database: `LAW_BENCH_MCP_TOKEN`
// in `platform-secrets`. Rollback = delete that key and this ref; profiles fall
// back to the single-credential shape and law-bench becomes unreachable again
// (which is the pre-change behaviour, not a new failure).

export const LAW_BENCH_CREDENTIAL_REF = "law-bench-mcp";

export function isLawBenchRef(config) {
  return config?.credentialRef === LAW_BENCH_CREDENTIAL_REF;
}

// Deployment-scoped, so the email argument is deliberately unused: every
// identity of this platform shares the upstream's one token.
export function liveToken() {
  const token = String(process.env.LAW_BENCH_MCP_TOKEN || "").trim();
  return token || null;
}

// A shared token cannot become "stale" per user. Returning false keeps the 401
// handler from re-applying a profile that would resolve to the same value —
// an admission loop buys nothing here.
export function markInvalid() {
  return false;
}

export function status() {
  return { connected: Boolean(liveToken()) };
}
