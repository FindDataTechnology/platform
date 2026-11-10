// registry-mint.ts
// The credentialed mint against the MCP registry (registry-sso-credentials).
//
// Runs in the BROWSER on the platform origin — the mint API authenticates with
// the registry's own session cookie (SameSite=None; Secure, set by the shared
// Logto sign-in), which only a browser can hold. Nothing here is persisted: the
// token goes straight to the backend, which stores it per user.
//
// Shape verified live against the deployed registry (2026-09-21):
//   GET  {registry}{csrfPath}   → { csrf_token: "<opaque>" }
//   POST {registry}{tokensPath} → { success, tokens: { access_token, refresh_token,
//                                    expires_in, refresh_token_expires_in,
//                                    token_type, scope }, … }
//   expires_in 604800 (168 h) when asked for expires_in_hours 168; the JWT's
//   exp matches exactly. The token is nested under `tokens` — the older
//   flat `access_token` is still accepted defensively.
//
// Because the registry's login page does not return to a platform-origin popup
// (its sign-in is its own app; no cross-origin return parameter is honored), the
// flow is: open the registry login in a popup for the user, and drive the mint
// from this page once the session appears — see `registrySessionLive`.

import type { RegistryConnection } from "@platform/core";

export interface RegistryMintConfig {
  registryUrl: string;
  csrfPath: string;
  tokensPath: string;
  csrfHeader: string;
  ttlHours: number;
}

export function mintConfigFrom(conn: RegistryConnection): RegistryMintConfig {
  return {
    registryUrl: conn.registryUrl,
    csrfPath: conn.mint.csrfPath,
    tokensPath: conn.mint.tokensPath,
    csrfHeader: conn.mint.csrfHeader,
    ttlHours: conn.mint.defaultTtlHours,
  };
}

// A CSRF fetch is a simple GET (no custom headers), so it never triggers a
// preflight — which makes it the cheapest probe for "is there a registry
// session in this browser?". 200 = signed in; 401 = not yet.
export async function registrySessionLive(cfg: RegistryMintConfig): Promise<boolean> {
  try {
    const res = await fetch(`${cfg.registryUrl}${cfg.csrfPath}`, {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function mintRegistryToken(cfg: RegistryMintConfig): Promise<string> {
  const csrfRes = await fetch(`${cfg.registryUrl}${cfg.csrfPath}`, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!csrfRes.ok) {
    throw new Error(`The registry session could not be verified (HTTP ${csrfRes.status})`);
  }
  const csrfDoc = await csrfRes.json().catch(() => ({}));
  const csrf = csrfDoc.csrf_token || csrfDoc.token || "";

  const mintRes = await fetch(`${cfg.registryUrl}${cfg.tokensPath}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", [cfg.csrfHeader]: csrf },
    body: JSON.stringify({ expires_in_hours: cfg.ttlHours }),
  });
  if (!mintRes.ok) {
    throw new Error(`The registry refused to issue a token (HTTP ${mintRes.status})`);
  }
  const doc = await mintRes.json().catch(() => ({}));
  const token =
    doc?.tokens?.access_token ||
    doc?.access_token ||
    doc?.token ||
    doc?.jwt_token ||
    doc?.data?.access_token ||
    "";
  if (!token) throw new Error("The registry returned no token");
  return token;
}
