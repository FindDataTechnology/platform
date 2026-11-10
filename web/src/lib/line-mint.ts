// line-mint.ts — browser entry for the server-mediated line mint
// (add-line-credential-refs, design D2 revised).
//
// The mint is a full-page authorization-code round trip driven by the SERVER:
//
//   /api/lines/:line/mint/start → Logto (prompt=none — silent while the shared
//   Logto session lives; one interactive consent ever) → Logto redirects to
//   /api/lines/:line/mint/callback on THIS origin → the server exchanges the
//   code for the ID token (PKCE, no client secret) → /settings/mcp.
//
// The first cut minted in a browser popup and polled the popup's location for
// the code. That can never work: reading a cross-origin popup's location.href
// always throws SecurityError, and wire's auth/config endpoint carries no CORS
// headers. Nothing here reads cross-origin state or touches tokens.

export type MintLine = "wire-customer" | "lex";

// Full-page navigation: the settings dialog deep-link (/settings/mcp) is where
// the callback lands, so the panel is back on screen when the round trip ends.
export function startLineMint(line: MintLine): void {
  window.location.assign(`/api/lines/${line}/mint/start`);
}

// The callback redirects here with ?lineError=<line> when a mint fails; the
// panel turns it into one readable line and the URL is cleaned.
export function takeLineMintError(): string {
  try {
    const url = new URL(window.location.href);
    const line = url.searchParams.get("lineError");
    if (!line) return "";
    url.searchParams.delete("lineError");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    return line;
  } catch {
    return "";
  }
}
