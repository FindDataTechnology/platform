// tool-credentials.js — tool-level credential overrides
// (openspec: add-user-supplied-credentials, L4 / design D4).
//
// The honest constraint, stated once: MCP's connection granularity is ONE
// server = ONE set of headers/env. A tool-level override can therefore only
// take effect where the SERVER itself accepts more than one credential — which
// is why the server must declare `credentialScopes: [..., "tool"]` and, for
// env-based servers, name which env var a given tool's value should land in.
//
// Anything less than that declaration is refused rather than silently stored:
// a user who configures a per-tool key and sees no effect is the exact failure
// shape this repository keeps producing.

import * as db from "../db.js";
import { encryptCredential, decryptCredential } from "./credential-crypto.js";

export class ToolCredentialError extends Error {
  constructor(message, { kind = "invalid" } = {}) {
    super(message);
    this.name = "ToolCredentialError";
    this.kind = kind;
  }
}

/** Whether this server's manifest allows tool-level credentials at all. */
export function supportsToolCredentials(serverConfig) {
  const scopes = serverConfig?.credentialScopes;
  return Array.isArray(scopes) && scopes.includes("tool");
}

/** The env var a tool's credential should land in, or null when undeclared. */
export function toolCredentialEnvName(serverConfig, toolName) {
  const map = serverConfig?.toolCredentialEnv;
  if (!map || typeof map !== "object") return null;
  const v = map[toolName];
  return typeof v === "string" && v ? v : null;
}

/**
 * @returns {Promise<{values: Record<string,string>}>} envName → credential, for
 *   every tool this owner configured that the server knows how to route.
 */
export async function resolveToolCredentials({ owner, serverName, serverConfig, cryptoOpts }) {
  if (!owner || !serverName) return { values: {} };
  if (!supportsToolCredentials(serverConfig)) return { values: {} };

  let rows = [];
  try {
    rows = db.listToolCredentialOverrides(owner, serverName);
  } catch {
    return { values: {} }; // cell predating v130 → no tool layer, same as before
  }

  const values = {};
  for (const row of rows) {
    if (row.field !== "api_key") continue; // only the credential shape is routable today
    const envName = toolCredentialEnvName(serverConfig, row.tool_name);
    if (!envName) continue; // undeclared tool: never guess a destination
    try {
      values[envName] = await decryptCredential(row.value_encrypted, cryptoOpts);
    } catch {
      // Undecryptable → skip; the server keeps its server-level value.
      continue;
    }
  }
  return { values };
}

/**
 * Store one tool-level credential.
 *
 * Refused when the server does not declare tool capability, or when it
 * declares capability but names no env var for this tool — in both cases
 * storing it would produce a credential that resolves nowhere.
 */
export async function setToolCredential({ owner, serverName, serverConfig, toolName, apiKey, cryptoOpts }) {
  if (!owner) throw new ToolCredentialError("an owner is required", { kind: "auth" });
  if (!serverName || !toolName) throw new ToolCredentialError("serverName and toolName are required");
  if (!supportsToolCredentials(serverConfig)) {
    throw new ToolCredentialError(
      `server "${serverName}" does not support per-tool credentials`,
      { kind: "not-supported" },
    );
  }
  if (!toolCredentialEnvName(serverConfig, toolName)) {
    throw new ToolCredentialError(
      `server "${serverName}" declares no env destination for tool "${toolName}"`,
      { kind: "no-destination" },
    );
  }
  const trimmed = apiKey == null ? "" : String(apiKey).trim();
  if (!trimmed) {
    db.deleteToolCredentialOverride(owner, serverName, toolName, "api_key");
    return { configured: false };
  }
  db.setToolCredentialOverride(
    owner, serverName, toolName, "api_key",
    await encryptCredential(trimmed, cryptoOpts),
  );
  return { configured: true };
}

/** Metadata-only projection for the API (never the value). */
export function projectToolCredentials({ owner, serverName, serverConfig }) {
  const supported = supportsToolCredentials(serverConfig);
  let rows = [];
  if (owner && serverName) {
    try { rows = db.listToolCredentialOverrides(owner, serverName); } catch { rows = []; }
  }
  const tools = {};
  for (const row of rows) {
    tools[row.tool_name] = {
      field: row.field,
      configured: Boolean(row.value_encrypted),
      env: toolCredentialEnvName(serverConfig, row.tool_name),
    };
  }
  return { supported, tools };
}
