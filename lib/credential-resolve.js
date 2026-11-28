// credential-resolve.js — the single cascade that answers "which credential
// should this owner use for this MCP server / tool?" (openspec:
// add-user-supplied-credentials, design D1).
//
//   tool override  >  server override  >  user default  >  none
//
// Both lanes consume this: the LLM lane lands the result in the provider's
// baseURL/apiKey, the MCP lane in the entry's url/headers/env. Keeping one
// resolver is the point — the two lanes historically each grew their own copy
// and drifted.
//
// "None" is a real answer, never a fallback to somebody else's credential: a
// caller that gets null must OMIT the capability, not borrow one.

import * as db from "../db.js";
import { decryptCredential } from "./credential-crypto.js";

/**
 * Resolve one field for one owner.
 *
 * @param {object} q
 * @param {string|null} q.owner     identity email; null = machine owner (no per-user layer)
 * @param {"llm:default"|"mcp:default"} q.scope  user-default bucket
 * @param {string} q.field          'url' | 'api_key' | 'header:<NAME>'
 * @param {string} [q.server]       MCP server name (or LLM provider id) for the server layer
 * @param {string} [q.tool]         tool name for the top layer
 * @param {object} [q.cryptoOpts]   injected for tests (see credential-crypto)
 * @returns {Promise<{value: string|null, layer: "tool"|"server"|"user"|"none"}>}
 */
export async function resolveCredentialField({ owner, scope, field, server, tool, cryptoOpts }) {
  if (!owner) return { value: null, layer: "none" };
  if (!field) throw new Error("resolveCredentialField: field is required");
  // `field` is a storage key, not a fixed enum: the LLM lane namespaces its rows
  // as `provider:<id>:<field>` so one table holds many providers. Callers pass
  // the key they will use; the cascade does not interpret it.

  const order = [];
  if (server && tool) order.push(["tool", () => db.getToolCredentialOverride(owner, server, tool, field)]);
  if (server) order.push(["server", () => db.getServerCredentialOverride(owner, server, field)]);
  order.push(["user", () => db.getUserCredential(owner, scope, field)]);

  for (const [layer, read] of order) {
    let row;
    try {
      row = read();
    } catch {
      // A missing table (cell predating v130) must degrade to "no credential
      // here", not crash the profile write that every turn depends on.
      continue;
    }
    if (row?.value_encrypted) {
      return { value: await decryptCredential(row.value_encrypted, cryptoOpts), layer };
    }
  }
  return { value: null, layer: "none" };
}

/**
 * Resolve a whole field-set at once (the common call shape).
 *
 * @returns {Promise<{values: Record<string,string>, layers: Record<string,"tool"|"server"|"user">}>}
 *   Only fields that actually resolved appear in either map.
 */
export async function resolveCredentialSet({ owner, scope, fields, server, tool, cryptoOpts }) {
  const values = {};
  const layers = {};
  for (const field of fields) {
    const { value, layer } = await resolveCredentialField({
      owner, scope, field, server, tool, cryptoOpts,
    });
    if (value != null) {
      values[field] = value;
      layers[field] = layer;
    }
  }
  return { values, layers };
}

/** Whitelist projection for API responses: metadata only, never the value. */
export function projectCredentialRow(row) {
  if (!row) return null;
  return {
    field: row.field,
    configured: Boolean(row.value_encrypted),
    updatedAt: row.updated_at ?? null,
  };
}
