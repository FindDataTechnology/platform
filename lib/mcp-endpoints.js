// mcp-endpoints.js — per-owner MCP endpoint overrides
// (openspec: add-user-supplied-credentials, L3 / design D3).
//
// The rule that makes this safe to ship: a server may only be re-pointed if its
// own manifest says so (`endpointOverridable: true`). Anything else keeps the
// registered URL, so the registry's "registered == connected" judgement stays
// true for every server that did not opt in — which is most of them.
//
// Write-time we run the SSRF gate; use-time the profile builder selects the URL
// and the client path re-checks (design D5 — DNS can change in between).

import * as db from "../db.js";
import { encryptCredential } from "./credential-crypto.js";
import { assertSafeUrl } from "./url-safety.js";

export class EndpointError extends Error {
  constructor(message, { kind = "invalid" } = {}) {
    super(message);
    this.name = "EndpointError";
    this.kind = kind;
  }
}

/**
 * @param {object} serverConfig  the resolved MCP server entry (from mcp.json / DB)
 * @returns {boolean} whether a user may re-point this server
 */
export function isEndpointOverridable(serverConfig) {
  // Default-closed on purpose: absence of the declaration means "no".
  return serverConfig?.endpointOverridable === true;
}

/**
 * Set (or clear) one owner's endpoint for one server.
 *
 * @param {object} q
 * @param {string} q.owner
 * @param {string} q.serverName
 * @param {object} q.serverConfig     the server's manifest entry (capability source)
 * @param {string|null} q.url         null/"" clears the override
 * @param {object} [q.allowUpstreamHosts]  optional host allowlist (per-deployment)
 */
export async function setOwnerEndpoint({ owner, serverName, serverConfig, url, allowHttp = false, cryptoOpts }) {
  if (!owner) throw new EndpointError("an owner is required", { kind: "auth" });
  if (!serverName) throw new EndpointError("serverName is required");
  if (!isEndpointOverridable(serverConfig)) {
    throw new EndpointError(
      `server "${serverName}" does not allow a custom endpoint`,
      { kind: "not-overridable" },
    );
  }

  const trimmed = url == null ? "" : String(url).trim();
  if (!trimmed) {
    db.deleteServerCredentialOverride(owner, serverName, "url");
    return { configured: false };
  }

  // Fail closed: an unsafe destination never reaches storage, so it can never
  // reach a request either.
  const { url: safe } = await assertSafeUrl(trimmed, { allowHttp });
  const envelope = await encryptCredential(safe.toString(), cryptoOpts);
  db.setServerCredentialOverride(owner, serverName, "url", envelope);
  return { configured: true, url: safe.toString() };
}

/** Read one owner's override (plaintext URL) or null. */
export async function getOwnerEndpoint({ owner, serverName, cryptoOpts }) {
  if (!owner || !serverName) return null;
  try {
    const { resolveCredentialField } = await import("./credential-resolve.js");
    // The shared cascade, server layer. Going through it (instead of reading
    // the row directly) is what makes "one resolver" true rather than aspirational.
    const { value } = await resolveCredentialField({
      owner, scope: "mcp:default", field: "url", server: serverName, cryptoOpts,
    });
    return value ?? null;
  } catch {
    // An undecryptable row must not be trusted; treat it as absent so the
    // server falls back to its registered URL rather than connecting nowhere.
    return null;
  }
}

/**
 * API projection: the URL IS the endpoint (not a secret), plus whether this
 * server even allows overriding. `owner` is deliberately absent — the caller
 * already resolved this for that owner.
 */
export function projectEndpoint({ serverName, url, overridable }) {
  return {
    server: serverName,
    overridable: Boolean(overridable),
    configured: Boolean(url),
    url: url ?? null,
  };
}
