// Session-share REST clients (openspec: add-session-share).
//
// Create/list/revoke are authenticated (the gateway resolves the caller);
// getSharedSession is the public read — token is the only credential, so it
// rides httpPublic and carries no Authorization header.

import type { ChatMessage } from "../types/ws";
import { http, httpPublic } from "./http";

async function jsonOrThrow<T>(resPromise: ReturnType<typeof http>): Promise<T> {
  const res = await resPromise;
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { error?: string } | null;
      if (j?.error) msg = j.error;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

export interface ShareInfo {
  token: string;
  sessionId: string;
  title: string;
  createdAt: number;
  expiresAt?: number | null;
}

export async function createShare(sessionId: string): Promise<{ token: string; url: string }> {
  return jsonOrThrow(
    http("/api/share", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId }),
    }),
  );
}

export async function listShares(): Promise<ShareInfo[]> {
  const j = await jsonOrThrow<{ shares: ShareInfo[] }>(http("/api/share"));
  return j.shares ?? [];
}

export async function revokeShare(token: string): Promise<void> {
  const res = await http(`/api/share/${encodeURIComponent(token)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

// The one unauthenticated call in the shared client set: 404 here means the
// share is gone (revoked/expired/deleted/never existed — deliberately
// indistinguishable), which callers render as "no longer available".
export async function getSharedSession(
  token: string,
): Promise<{ title: string; messages: ChatMessage[] }> {
  const res = await httpPublic(`/api/share/${encodeURIComponent(token)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = (await res.json()) as { title?: string; messages?: ChatMessage[] };
  return { title: j.title ?? "", messages: j.messages ?? [] };
}
