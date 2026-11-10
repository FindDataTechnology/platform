// connector-mint.ts
// The credentialed mint against the 萬星 connector (add-connector-account-picker).
//
// Runs in the BROWSER on the platform origin — the cross-mint API authenticates
// with the connector's own OIDC session cookie (oomol_connect_tenant_session;
// SameSite=None when the deployment arms the cross-site switch), which only a
// browser can hold. Nothing here is persisted: the token goes straight to the
// backend, which stores it per user and later revokes it best-effort via the
// mint-returned PAT id.
//
// Endpoint shapes (connector side, open-connector-mt tenant-routes):
//   GET  {connector}/api/tenant/cross-mint/probe → 200 { email, displayName }
//                                                  | 401 (no session) | 403 (origin)
//   POST {connector}/api/tenant/cross-mint       → 200 { token, id, name } (oct_…)
//
// The probe is a simple GET (no custom headers) so it never triggers a
// preflight — the cheapest "is there a connector session in this browser?"
// check; its response still carries CORS headers when the origin is
// allowlisted, otherwise the browser blocks the read and we treat it as "no
// session".
//
// The login popup must open the connector's OIDC authorize URL (loginUrl from
// /api/tenant/config), never /me: the callback re-issues the session cookie,
// so a legacy SameSite=Lax cookie — which cross-site fetches can never carry —
// gets replaced by a fresh None cookie and the flow unblocks itself.

export interface ConnectorMintIdentity {
  email: string | null;
  displayName: string | null;
}

export interface ConnectorMintResult {
  token: string;
  patId: string;
  name: string;
}

// Zero-paste accounts are named after the connector login identity, so the
// same identity reconnects into the same slot (replace) while a second
// identity lands as a second account. email → displayName → 身份N.
export function suggestSlot(identity: ConnectorMintIdentity, existingSlots: string[] = []): string {
  const base = identity.email?.trim() || identity.displayName?.trim() || "";
  if (base) return base;
  let n = 1;
  let candidate = `身份${n}`;
  while (existingSlots.includes(candidate)) candidate = `身份${++n}`;
  return candidate;
}

export async function connectorSessionLive(connectorUrl: string): Promise<ConnectorMintIdentity | null> {
  try {
    const res = await fetch(`${connectorUrl}/api/tenant/cross-mint/probe`, {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const doc = (await res.json().catch(() => null)) as ConnectorMintIdentity | null;
    if (!doc || typeof doc !== "object") return null;
    return { email: doc.email ?? null, displayName: doc.displayName ?? null };
  } catch {
    return null;
  }
}

export async function mintConnectorToken(
  connectorUrl: string,
  slot: string,
): Promise<ConnectorMintResult> {
  const res = await fetch(`${connectorUrl}/api/tenant/cross-mint`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: `壹座 · ${slot}` }),
  });
  if (!res.ok) {
    throw new Error(`The connector refused to issue a token (HTTP ${res.status})`);
  }
  const doc = (await res.json().catch(() => ({}))) as { token?: string; id?: string; name?: string };
  if (!doc.token) throw new Error("The connector returned no token");
  return { token: doc.token, patId: doc.id ?? "", name: doc.name ?? `壹座 · ${slot}` };
}

// ── add-connector-context: the "Learn more" target ──────────────────────────
// The official product page, written for the credential panel so the user can
// read what the connector IS before clicking connect. The site ships the page
// in zh/en only; every other console language reads the en page. It follows the
// CONSOLE language (the user's explicit pick), not the browser's.
export function connectorLearnMoreUrl(lang: string): string {
  const base = "https://www.finddatatech.cloud";
  return lang.toLowerCase().startsWith("zh")
    ? `${base}/zh/products/wanxing-connector/`
    : `${base}/products/wanxing-connector/`;
}
