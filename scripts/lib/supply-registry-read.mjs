// ── Registry read helpers for the supply-store migration pair ────────────────
// (add-supply-store-unification 3.1/3.4 — supply-store-migrate.mjs and
// supply-store-dual-read.mjs share ONE faithful port of registry-bridge's
// paginated read so both tools see the registry identically.)
//
// Contract notes (bridge + reconcile_mcp_registry.py 实测 precedent):
//   · env: MARKET_REGISTRY_URL || REGISTRY_URL base, MARKET_REGISTRY_TOKEN
//     bearer header (registry-bridge.js fetchJson — token optional, attached
//     only when set, exactly like the bridge).
//   · List endpoints are PAGINATED: default limit=20, envelope
//     {total_count, limit, offset, has_next}. Reads follow has_next to
//     exhaustion — production dropped 3 of 23 agent entries on a single-page
//     read once; the migrator must never repeat that.
//   · Server rows expose the Mongo `_id` value as `path` (reconcile precedent:
//     it.get("path") or it.get("_id")); skill rows carry path=/skills/<name>
//     with the row's `name` field being the DISPLAY name (bridge mapSkill).
//   · Group metadata is absent from listings by design (bridge header comment);
//     it comes from registry-groups.json via loadGroupsDoc/groupsFor.
//
// Differences from the bridge, both deliberate:
//   · 30s per-request timeout instead of 10s — migration is a bulk read over
//     full rows (161-tool tool_lists), not an interactive catalog tick.
//   · A truncated read (registry reports more than we retrieved) or an
//     offset-replaying registry THROWS instead of warn-and-continue: a
//     migration/dual-read that pretends a partial page is whole reconciles
//     against a lie. Fail-closed.

import { bundledJson } from "../../paths.js";
import { readJsonOr } from "../../lib/persistence.js";

export class RegistryReadError extends Error {
  constructor(message, { status = null, endpoint = null } = {}) {
    super(message);
    this.status = status;
    this.endpoint = endpoint;
  }
}

const FETCH_TIMEOUT_MS = 30_000;
const LIST_PAGE_LIMIT = 500; // requested page size; the registry may clamp it
const LIST_MAX_PAGES = 100; // runaway guard, same as the bridge

export function resolveRegistryBase(env = process.env) {
  const base = (env.MARKET_REGISTRY_URL || env.REGISTRY_URL || "").trim().replace(/\/+$/, "");
  if (!base) {
    throw new RegistryReadError("no registry base configured: set MARKET_REGISTRY_URL or REGISTRY_URL");
  }
  return base;
}

export function registryToken(env = process.env) {
  return (env.MARKET_REGISTRY_TOKEN || "").trim();
}

async function fetchRegistryJson({ fetchImpl = globalThis.fetch, base, token, endpoint }) {
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetchImpl(`${base}${endpoint}`, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new RegistryReadError(`registry ${base}${endpoint} unreachable: ${err.message}`, { endpoint });
  }
  if (!res.ok) {
    throw new RegistryReadError(`HTTP ${res.status} for ${endpoint}`, { status: res.status, endpoint });
  }
  return res.json();
}

function listItemsOf(doc, path) {
  if (Array.isArray(doc)) return doc;
  const key = path === "/api/servers" ? "servers" : "skills";
  return doc?.[key] ?? doc?.items ?? [];
}

// Read every page of a registry list endpoint. Returns {items, pages, reportedTotal}.
export async function fetchAllRegistryPages({ fetchImpl = globalThis.fetch, base, token, path }) {
  const items = [];
  let offset = 0;
  let reportedTotal = null;
  const seenFirstKeys = new Set();
  for (let page = 0; page < LIST_MAX_PAGES; page += 1) {
    const doc = await fetchRegistryJson({ fetchImpl, base, token, endpoint: `${path}?limit=${LIST_PAGE_LIMIT}&offset=${offset}` });
    const rows = listItemsOf(doc, path);
    // Offset-replay guard (bridge precedent): if this page's first entry was
    // already returned by an earlier page, the registry ignores offset —
    // stopping here beats piling up duplicate rows forever.
    const firstKey = rows.length ? (rows[0]?.path ?? rows[0]?.name ?? null) : null;
    if (page > 0 && firstKey !== null && seenFirstKeys.has(firstKey)) {
      throw new RegistryReadError(`${path}: registry ignores offset (page replay at offset ${offset})`, { endpoint: path });
    }
    if (firstKey !== null) seenFirstKeys.add(firstKey);
    items.push(...rows);
    const total = Number.isFinite(Number(doc?.total_count)) ? Number(doc.total_count) : null;
    if (total !== null) reportedTotal = total;
    // has_next is the contract; fall back to total_count for older registries.
    const hasNext =
      typeof doc?.has_next === "boolean"
        ? doc.has_next
        : total !== null
          ? items.length < total
          : rows.length >= LIST_PAGE_LIMIT;
    if (!hasNext) return { items, pages: page + 1, reportedTotal };
    if (rows.length === 0) break;
    const nextOffset = offset + rows.length;
    if (nextOffset <= offset) break;
    offset = nextOffset;
  }
  throw new RegistryReadError(
    `${path}: truncated read — retrieved ${items.length} of ${reportedTotal ?? "?"} entries (registry reports more)`,
    { endpoint: path },
  );
}

// Bridge-identical path sanitizer (registry-bridge.js pathToName).
export function pathToName(p) {
  return String(p || "").split("/").filter(Boolean).join("-");
}

// The registry skill's canonical name, exactly as bridge mapSkill derives it:
// last path segment sanitized. The row's `name` field is the display name.
export function skillEntryName(row) {
  const seg = String(row?.path ?? row?._id ?? row?.name ?? "").split("/").filter(Boolean).pop();
  return pathToName(seg);
}

// Bridge loadGroups/groupsFor semantics: optional {servers:{name:[groups]},
// skills:{…}, agents:{…}} mapping file; absent file or absent name ⇒ [].
// Resolution mirrors the bridge: cwd copy wins (deployment overlay), else the
// repo-bundled file; --groups-file overrides both.
export function loadGroupsDoc({ fileOverride = null } = {}) {
  const file = fileOverride || bundledJson("registry-groups.json");
  return readJsonOr(file, null, { label: "registry-groups" });
}

export function groupsFor(groupsDoc, kind, name) {
  const groups = groupsDoc?.[kind]?.[name];
  return Array.isArray(groups) ? groups : [];
}
