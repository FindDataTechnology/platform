// ── Facet — MCP Registry server.json projection (add-marketplace-projection-fanout)
//
// The distribution funnel's top of the free-public lane: project the facet's
// publicly visible MCP servers into the official MCP Registry format
// (schema 2025-12-11) so `mcp-publisher` can publish them to the community
// registry. Discoverable by anyone, zero-key connect, no paid channel.
//
// Scope discipline (spec deltas: ecosystem-access + pack-marketplace):
//   - admission is the MCP catalog's ONE visibility rule, imported from
//     mcp-catalog.js — this file must never restate it (design C2). With
//     viewer = null that rule reduces to "no required groups = public";
//   - `remotes[]` points at the keyless endpoint and carries NO `headers`
//     block at all (design C4). The catalog's configTemplate.headers is a
//     literal `Bearer <your_token>` placeholder; writing it would install
//     broken on a client with no credential, because the keyless endpoint
//     authorizes through OAuth discovery;
//   - credential gate: refuse rather than sanitize. The serialized output is
//     scanned with the same CREDENTIAL_RE the repository exporter uses; a hit
//     throws PROJECT_REJECTED and the whole batch is refused (last-good stays
//     intact). A match means an upstream publish-gate defect, not something
//     to strip quietly;
//   - read-only with respect to registry state; cache ≤ 1h so publish,
//     unpublish and visibility changes land within one refresh cycle.

import { CREDENTIAL_RE } from "./credential-pattern.js";
import { visibleTo } from "./mcp-catalog.js";

export const SERVER_JSON_SCHEMA =
  "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json";
export const NAMESPACE = "io.github.FindDataTechnology";

// The registry's server entries carry no version semantics (mapServer emits
// name/displayName/description/configTemplate/groups and nothing version-like).
// The official schema requires `version`, so this is a flat placeholder rather
// than a fabricated semver — inventing "1.0.0" or borrowing a pack version
// would claim a meaning that does not exist. Documented in
// docs/ecosystem/mcp-registry-publishing.md.
export const PLACEHOLDER_VERSION = "0.0.1";

// Funnel hook (design D6): the tail of the human-facing description only. No
// manifest structural field carries marketing copy — structure is machine
// contract, prose is for people.
export const FUNNEL_COPY = "想 7×24 常驻 → 萬星";

// The registry rejects a description longer than 100 characters with a 422
// (`{"errors":[{"message":"expected length <= 100","location":"body.description"}]}`)
// — found the hard way on the first real publish (2026-10-31): 8 of 14 servers
// were refused while the 6 short-description ones went through. So the whole
// description (base text + funnel tail) shares one 100-char budget: the tail
// gets reserved first, and whatever is left is the base text's allowance.
export const MAX_DESCRIPTION = 100;

// Code-point length, not UTF-16 length: a Chinese character is one character to
// the registry even though it is one code unit, while an emoji is one character
// but two code units. Counting code points is the only measure that matches
// what the server actually validates.
const charLength = (s) => Array.from(s).length;

// Truncate on code-point boundaries so a surrogate pair is never split, ending
// with an ellipsis so the reader can see the text was cut rather than read a
// sentence that stops mid-thought with no marker.
function truncateChars(s, max) {
  const chars = Array.from(s);
  if (chars.length <= max) return s;
  if (max <= 1) return "…".slice(0, max);
  return `${chars.slice(0, max - 1).join("")}…`;
}

// Base text + funnel tail, fitted into the registry's 100-character budget.
export function composeDescription(description) {
  const tail = ` — ${FUNNEL_COPY}`;
  const budget = MAX_DESCRIPTION - charLength(tail);
  return `${truncateChars(description, budget)}${tail}`;
}

const CACHE = "public, max-age=3600";

export class McpRegistryError extends Error {
  constructor(message, { code = "PROJECT_REJECTED", detail = null } = {}) {
    super(message);
    this.name = "McpRegistryError";
    this.code = code;
    this.detail = detail;
  }
}

// Reverse-DNS name pattern the registry enforces: exactly one `/`, and both
// halves restricted to a conservative charset.
const NAME_RE = /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/;

// The registry lists servers for the WHOLE internet, so a remote URL must be
// publicly resolvable over https. Registry entries carry a mix of endpoints:
// the public gateway (`https://mcp.finddatatech.cloud/<server>/mcp`) and
// cluster-internal ones (`http://cheap6.mesh.finddata.cn:31893/mcp`, plain dsh
// cell ports). Publishing an internal URL would (a) hand a stranger an address
// that cannot connect, and (b) leak internal hostnames and port layout into a
// permanent public directory. Neither is acceptable, and neither is fixable at
// publish time — so such an entry is not projectable at all.
//
// Deliberately narrow: only https, and only hostnames that are neither
// loopback/RFC1918 nor our own cluster naming (mesh.*, bare cheapN nodes).
const PUBLIC_URL_RE = /^https:\/\/[^/\s]+/;
const PRIVATE_IP_RE =
  /^(127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|0\.0\.0\.0)$/;

export function isPubliclyReachable(url) {
  const u = String(url ?? "").trim();
  if (!u || !PUBLIC_URL_RE.test(u)) return false; // https only
  let host;
  try {
    host = new URL(u).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!host) return false;
  if (PRIVATE_IP_RE.test(host)) return false;
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (host.endsWith(".local") || host.endsWith(".internal")) return false;
  // Our cluster naming: mesh.<x>.finddata.cn endpoints and bare cheapN nodes
  // (with or without a suffix) are reachable only from inside the VPC.
  if (/(^|\.)mesh\.finddata\.cn$/.test(host)) return false;
  if (/^cheap\d+(\.|$)/.test(host)) return false;
  return true;
}

// One server entry → one registry document, or null when the entry cannot be
// projected (caller records the reason; a single bad entry never poisons the
// batch — spec scenario "A malformed entry does not poison the batch").
export function projectServerJson(entry) {
  const localName = String(entry?.name ?? "").trim();
  const description = String(entry?.description ?? "").trim();
  const url = String(entry?.configTemplate?.url ?? "").trim();
  if (!localName) return null;
  if (!description) return null; // schema requires it; an empty description is noise
  if (!url) return null;
  if (!isPubliclyReachable(url)) return null; // no internal hostnames in a public listing

  const name = `${NAMESPACE}/${localName}`;
  if (!NAME_RE.test(name) || name.split("/").length !== 2) return null;

  const doc = {
    $schema: SERVER_JSON_SCHEMA,
    name,
    description: composeDescription(description),
    version: PLACEHOLDER_VERSION,
    // No headers key, ever — see the file header.
    remotes: [{ type: "streamable-http", url }],
  };

  const displayName = String(entry?.displayName ?? "").trim();
  if (displayName && displayName !== localName) doc.title = displayName;
  // repository / websiteUrl deliberately absent: registry server entries carry
  // no repositoryUrl (only skill entries do) and there is no other honest
  // source. Omitting beats inventing.

  return doc;
}

// Why an entry was skipped, for the dry-run report. Kept separate from the
// projection so the projector stays a pure shape function.
export function skipReason(entry) {
  if (!String(entry?.name ?? "").trim()) return "missing name";
  if (!String(entry?.description ?? "").trim()) return "missing description";
  const url = String(entry?.configTemplate?.url ?? "").trim();
  if (!url) return "missing configTemplate.url";
  if (!isPubliclyReachable(url)) return "endpoint not publicly reachable (internal host or non-https)";
  const name = `${NAMESPACE}/${String(entry.name).trim()}`;
  if (!NAME_RE.test(name) || name.split("/").length !== 2) return `name fails reverse-DNS pattern: ${name}`;
  return null;
}

// Every projectable public server. `entriesFn` is the only seam (same shape as
// registerFacetMcpRoutes' entriesFn).
export function projectAllServers({ entriesFn }) {
  const entries = typeof entriesFn === "function" ? entriesFn() ?? [] : [];
  const servers = [];
  const skipped = [];
  for (const entry of entries) {
    // viewer = null (anonymous): with the shared rule this is exactly
    // "groups is empty", i.e. the public servers. Do not inline the predicate.
    if (!visibleTo(entry, null)) {
      skipped.push({ name: entry?.name ?? null, reason: "not publicly visible (requires groups)" });
      continue;
    }
    const reason = skipReason(entry);
    if (reason) {
      skipped.push({ name: entry?.name ?? null, reason });
      continue;
    }
    const doc = projectServerJson(entry);
    if (!doc) {
      skipped.push({ name: entry?.name ?? null, reason: "not projectable" });
      continue;
    }
    servers.push(doc);
  }

  // Credential gate over the WHOLE serialized product: refuse, do not sanitize.
  const serialized = JSON.stringify(servers);
  if (CREDENTIAL_RE.test(serialized)) {
    throw new McpRegistryError(
      "credential-shaped string found in the MCP Registry projection — refusing the whole batch",
      { code: "PROJECT_REJECTED" },
    );
  }

  return { servers, skipped };
}

export function registerMcpRegistryJson(app, { entriesFn }) {
  // Collection form: the publisher script consumes this one document and fans
  // it out into <name>/server.json trees.
  app.get("/api/mcp-registry.json", (_req, res) => {
    let result;
    try {
      result = projectAllServers({ entriesFn });
    } catch (err) {
      // Refusal is a loud 503, never a silent partial write: the previously
      // published output must stay intact (spec: refuses and writes nothing).
      return res.status(503).json({ error: err?.message || "projection refused", code: err?.code || "PROJECT_REJECTED" });
    }
    res.set("Cache-Control", CACHE);
    res.json({ servers: result.servers });
  });

  // Single-server form. An entry the projection cannot emit answers not-found,
  // the same "probing teaches nothing" posture as /api/mcp-catalog/:name.
  app.get("/api/mcp-registry/:name.json", (req, res) => {
    let result;
    try {
      result = projectAllServers({ entriesFn });
    } catch (err) {
      return res.status(503).json({ error: err?.message || "projection refused", code: err?.code || "PROJECT_REJECTED" });
    }
    const wanted = req.params.name;
    const doc = result.servers.find((s) => s.name === `${NAMESPACE}/${wanted}` || s.name === wanted);
    if (!doc) return res.status(404).json({ error: "Server not found" });
    res.set("Cache-Control", CACHE);
    res.json(doc);
  });
}
