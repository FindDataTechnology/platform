// The one place that bridges @platform/core into React Native. Nothing else
// may import core directly (design D3): pages consume the store and the hooks
// exposed here, so a future shell (web/other) only rewrites this file.
//
// core is deliberately transport-agnostic: configureHttp takes a transport,
// WsClient takes a socket factory. RN's global fetch and WebSocket plug in
// unchanged — the pairing token rides the Authorization header via
// tokenProvider, refreshed by the silent challenge exchange.

import { configureHttp } from "@platform/core";

let wired = false;

export interface PlatformWireOptions {
  baseUrl: string;
  // Minted Authorization header value (or null for anonymous phases like the
  // pre-pairing capability probe).
  authProvider: () => string | null;
}

// Idempotent: re-wiring on instance switch re-points http at the new base.
export function wireCore({ baseUrl, authProvider }: PlatformWireOptions): void {
  configureHttp({
    baseUrl,
    headers: () => {
      const auth = authProvider();
      const headers: Record<string, string> = {};
      if (auth) headers.authorization = auth;
      return headers;
    },
    transport: async (path, init) => {
      const res = await fetch(path, init);
      return {
        ok: res.ok,
        status: res.status,
        statusText: res.statusText,
        json: () => res.json(),
      };
    },
  });
  wired = true;
}

export function coreWired(): boolean {
  return wired;
}
