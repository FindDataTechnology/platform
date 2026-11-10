#!/usr/bin/env node
// ── Supply-store migration loader (add-supply-store-unification 3.1) ─────────
//
// One-shot row copy: registry admin API (legacy Mongo behind /api/servers,
// /api/skills) → 谦面 spine SQLite via the HTTP write gate, source="migration",
// then a row-count + per-field reconciliation against the spine projection.
//
//   node scripts/supply-store-migrate.mjs                # dry-run (default)
//   node scripts/supply-store-migrate.mjs --confirm --actor op@finddatatech.cloud
//
// Flags:
//   --confirm            actually write through the spine write gate
//   --actor <email>      acting identity, lands in the audit ledger
//                        (confirm mode required; env SUPPLY_MIGRATE_ACTOR)
//   --groups-file <path> registry-groups.json override; default resolves like
//                        the bridge (cwd copy wins, else repo-bundled file)
// Env:
//   MARKET_REGISTRY_URL / REGISTRY_URL   registry admin API base (bridge convention)
//   MARKET_REGISTRY_TOKEN                registry bearer token (bridge convention)
//   SUPPLY_STORE_BASE                    spine gateway base (write gate + projection)
//   SUPPLY_STORE_WRITE_TOKEN             spine write gate bearer
//   SUPPLY_STORE_PROJECTION_TOKEN        spine projection bearer
// Exit codes:
//   0  dry-run clean, or confirm with every write accepted and reconciliation
//      AGREE and no unknown fields
//   1  unknown field(s) present, write error(s), or reconciliation mismatch
//   2  usage error, connection failure, or truncated registry read
//
// Field discipline (spec hard requirement — supply-store spec "Migration
// catches a field mismatch"): every registry row is field-enumerated against
// the explicit maps below. Fields OUTSIDE the map are reported with the row
// named AND forwarded verbatim into the entry so the write gate rejects the
// row with 400 SUPPLY_UNKNOWN_FIELD — never trimmed, never stuffed.
//
// Contract deviations vs the task text, observed on repo evidence (kept
// deliberate; the dry-run exists to confirm them against production):
//   · The registry API exposes the Mongo `_id` value as `path`
//     (reconcile_mcp_registry.py: it.get("path") or it.get("_id")); spine id =
//     same value verbatim (leading slash included — the gate enforces it).
//   · Skill rows: the spine PK `name` is derived exactly like bridge mapSkill
//     (last path segment sanitized); the row's `name` field is the display
//     name and maps to display_name.
//   · `groups` is NOT taken from rows — the bridge has always sourced group
//     metadata from registry-groups.json ("Group metadata is absent from
//     listings"); the migrator computes it with bridge groupsFor semantics and
//     names every row the mapping does not cover (groups: []). This is the
//     正面修复 of the 11-05 fail-open defect: group metadata becomes native in
//     the spine instead of being re-derived per read.
//   · List rows are known to also carry registry-runtime fields the spine has
//     no column for (health_status, status, mcp_endpoint, registered_at, …).
//     Under the rule above such rows REJECT until the map is deliberately
//     extended — the dry-run names every offending field for that decision.
//   · visibility absent/null on a row is NOT silently upgraded to public: it
//     is written as null (fail-closed, the spine's unset = not public) and the
//     row is named in the report for human review.
//   · is_enabled absent on a row maps to true — the registry's incumbent
//     semantics (reconcile_mcp_registry.py: enabled = is_enabled is not False).

import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";

import {
  RegistryReadError,
  fetchAllRegistryPages,
  groupsFor,
  loadGroupsDoc,
  pathToName,
  registryToken,
  resolveRegistryBase,
  skillEntryName,
} from "./lib/supply-registry-read.mjs";

// ── enumerated field maps: registry wire field → spine entry field ───────────
// These are the ONLY fields the migrator knows how to carry. Extending them is
// a deliberate decision backed by the dry-run report, never a silent pass.

// Consumed keys (mapped or derived) per species; anything else on a row is
// unknown and forwarded verbatim so the write gate names it.
const MCP_CONSUMED = new Set([
  "path", "_id", "id", "mcp_endpoint", "sse_endpoint",
  // mapped: identity/display aliases and provider shape
  "server_name", "mcp_server_name", "display_name", "is_active", "provider",
  // deliberately dropped (runtime/execution-plane state, not registration):
  // auth material stays registry-side (facade forwards writes; the spine
  // never carries credentials), nginx/transport plumbing is serving-plane.
  "supported_transports", "auth_scheme", "auth_header_name", "auth_credential_encrypted",
  "backend_oauth", "credential_updated_at", "egress_auth_mode", "identity_forwarding",
  "is_proxied", "append_mcp_path", "headers", "custom_header_names",
  "custom_header_overridable_names", "custom_headers_encrypted", "custom_headers_updated_at",
  "oauth_client_id", "auth_provider", "transport", "proxy_target_url",
  // lifecycle timestamps & registry-internal bookkeeping (spine stamps its own)
  "registered_at", "registered_by", "updated_at", "version", "is_active",
  "mcp_server_version", "mcp_server_version_previous", "mcp_server_version_updated_at",
  "source_created_at", "source_updated_at", "_identity_url_normalized", "source",
  // display/projection remnants consumed via metadata promotion elsewhere
  "allowed_groups", "status", "external_tags", "surface_report_token_hash",
  "surface_source", "last_surface_report_at", "record_kind", "ard_source_url",
  "health_status", "last_checked_iso", "versions", "default_version",
  "sync_metadata", "security_scan", "local_runtime", "ans_metadata", "num_stars",
  "rating_details",
]);
const MCP_SPINE_FIELDS = new Set([
  "display_name", "description", "proxy_pass_url", "num_tools", "tool_list",
  "tags", "license", "provider_organization", "deployment", "metadata",
  "visibility", "is_enabled",
]);
const SKILL_CONSUMED = new Set(["path", "_id", "name"]);
const SKILL_SPINE_FIELDS = new Set([
  "description", "repository_url", "author", "version", "tags", "license",
  "metadata", "visibility", "is_enabled",
]);

// Spine-added provenance columns: present on projection rows (written by the
// gate at write time), not part of the migrated payload. Declared skip set for
// reconciliation — never a silent trim.
const SPINE_ONLY_FIELDS = ["created_at", "updated_at", "updated_by"];

const MCP_COMPARE_FIELDS = [
  "id", "display_name", "description", "proxy_pass_url", "num_tools", "tool_list",
  "tags", "license", "provider_organization", "deployment", "metadata",
  "visibility", "groups", "is_enabled",
];
const SKILL_COMPARE_FIELDS = [
  "name", "display_name", "description", "repository_url", "author", "version",
  "tags", "license", "metadata", "visibility", "groups", "is_enabled",
];

class UsageError extends Error {}
class ConnectionError extends Error {}

function parseArgs(argv) {
  const out = { confirm: false, actor: null, groupsFile: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--confirm") out.confirm = true;
    else if (a === "--actor") out.actor = argv[++i] ?? null;
    else if (a === "--groups-file") out.groupsFile = argv[++i] ?? null;
    else if (a === "--registry-dump") out.registryDump = argv[++i] ?? null;
    else throw new UsageError(`unknown argument "${a}"`);
  }
  return out;
}

// ── row mapping ───────────────────────────────────────────────────────────────

function firstString(...vals) {
  for (const v of vals) {
    if (typeof v === "string" && v) return v;
  }
  return null;
}

function unknownFieldsOf(doc, consumed, spineFields) {
  const unknown = [];
  for (const k of Object.keys(doc)) {
    if (!consumed.has(k) && !spineFields.has(k)) unknown.push(k);
  }
  return unknown;
}

function mapMcpRow(doc, groupsDoc) {
  const unknownFields = unknownFieldsOf(doc, MCP_CONSUMED, MCP_SPINE_FIELDS);
  const rawId = firstString(doc.path, doc._id);
  const idSource = typeof doc.path === "string" && doc.path
    ? "path"
    : typeof doc._id === "string" && doc._id ? "_id" : null;
  const name = pathToName(rawId ?? "");
  const entry = {
    id: rawId, // leading-slash / presence enforcement is the write gate's (SUPPLY_BAD_ENTRY)
    display_name: doc.display_name ?? doc.server_name ?? doc.mcp_server_name ?? name,
    description: doc.description ?? null,
    proxy_pass_url: doc.proxy_pass_url ?? null,
    num_tools: doc.num_tools ?? null,
    tool_list: doc.tool_list ?? null,
    tags: doc.tags ?? null,
    license: doc.license ?? null,
    provider_organization: doc.provider_organization ?? doc.provider?.organization ?? null,
    deployment: doc.deployment ?? null,
    metadata: doc.metadata ?? null, // whole-object passthrough: annotations / surface / credential_ref ride inside
    visibility: doc.visibility ?? null, // absent ⇒ null (fail-closed), never upgraded to public
    groups: groupsFor(groupsDoc, "servers", name),
    is_enabled: doc.is_enabled ?? (doc.is_active === undefined ? true : doc.is_active),
  };
  // Client-visible endpoint overrides (add-supply-store-unification ruling):
  // registry carries mcp_endpoint / sse_endpoint at document top level; the
  // spine keeps them INSIDE metadata (the registry's mapping layer promotes
  // them back to top level on read — same whitelist semantics both sides).
  // Deliberate map extension, not a silent trim: existing metadata keys win,
  // promoted fields only fill gaps; the report notes each promoted row.
  const promoted = {};
  if (typeof doc.mcp_endpoint === "string" && doc.mcp_endpoint) promoted.mcp_endpoint = doc.mcp_endpoint;
  if (typeof doc.sse_endpoint === "string" && doc.sse_endpoint) promoted.sse_endpoint = doc.sse_endpoint;
  if (Object.keys(promoted).length > 0) {
    entry.metadata = { ...promoted, ...(doc.metadata ?? {}) };
  }
  // Unknown fields ride verbatim — the write gate rejects the row with
  // 400 SUPPLY_UNKNOWN_FIELD and the report carries its answer as-is.
  for (const k of unknownFields) entry[k] = doc[k];
  return { entry, unknownFields, idSource, key: rawId ?? "(no id)", mappedGroups: Array.isArray(groupsDoc?.servers?.[name]) };
}

function mapSkillRow(doc, groupsDoc) {
  const unknownFields = unknownFieldsOf(doc, SKILL_CONSUMED, SKILL_SPINE_FIELDS);
  const name = skillEntryName(doc);
  const keySource = typeof doc.path === "string" && doc.path
    ? "path"
    : typeof doc._id === "string" && doc._id
      ? "_id"
      : doc.name != null ? "name" : null;
  const entry = {
    name: name || null, // presence enforcement is the write gate's (SUPPLY_BAD_ENTRY)
    display_name: doc.name || name || null, // registry skill `name` is the display name (mapSkill)
    description: doc.description ?? null,
    repository_url: doc.repository_url ?? null,
    author: doc.author ?? null,
    version: doc.version ?? null,
    tags: doc.tags ?? null,
    license: doc.license ?? null,
    metadata: doc.metadata ?? null,
    visibility: doc.visibility ?? null,
    groups: groupsFor(groupsDoc, "skills", name),
    is_enabled: doc.is_enabled === undefined ? true : doc.is_enabled,
  };
  for (const k of unknownFields) entry[k] = doc[k];
  return { entry, unknownFields, keySource, key: name || "(no name)", mappedGroups: Array.isArray(groupsDoc?.skills?.[name]) };
}

// ── spine HTTP faces ──────────────────────────────────────────────────────────

async function spineWrite({ base, token, endpoint, body, fetchImpl }) {
  let res;
  try {
    res = await fetchImpl(`${base}${endpoint}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    throw new ConnectionError(`spine ${base}${endpoint} unreachable: ${err.message}`);
  }
  // Gate errors pass through verbatim: status + code + message land in the
  // report exactly as the write gate answered (401/400/404 + code), no swallowing.
  let data = null;
  let errorText = null;
  let code = null;
  const raw = await res.text();
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    errorText = raw.slice(0, 300);
  }
  if (!res.ok) {
    code = data?.code ?? null;
    errorText = errorText ?? data?.error ?? `HTTP ${res.status}`;
  }
  return { ok: res.ok, status: res.status, code, error: errorText, data };
}

async function pullProjection({ base, token, fetchImpl }) {
  let res;
  try {
    res = await fetchImpl(`${base}/api/supply-store/projection`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    throw new ConnectionError(`spine projection ${base} unreachable: ${err.message}`);
  }
  if (!res.ok) {
    const raw = await res.text();
    let code = null;
    try { code = JSON.parse(raw)?.code ?? null; } catch { /* non-JSON error body */ }
    throw new ConnectionError(`spine projection HTTP ${res.status}${code ? ` ${code}` : ""}`);
  }
  return res.json();
}

// ── reconciliation: row count + per-field content, both species ───────────────

function normEnabled(v) {
  return v === 1 || v === true;
}

function normField(v) {
  return v === undefined ? null : v;
}

function fieldEqual(field, spineValue, entryValue) {
  if (field === "is_enabled") return normEnabled(spineValue) === normEnabled(entryValue);
  return isDeepStrictEqual(normField(spineValue), normField(entryValue));
}

function reconcileSpecies({ label, projRows, written, keyOfEntry, keyOfRow, fields, problems }) {
  const rowByKey = new Map();
  for (const row of projRows) rowByKey.set(keyOfRow(row), row);
  const writtenKeys = new Set(written.map((w) => keyOfEntry(w.entry)));
  for (const [key] of rowByKey) {
    if (!writtenKeys.has(key)) {
      problems.push({ label, key, field: null, spine: "(row present)", entry: "(not written by this run)" });
    }
  }
  for (const w of written) {
    const key = keyOfEntry(w.entry);
    const row = rowByKey.get(key);
    if (!row) {
      problems.push({ label, key, field: null, spine: "(row missing)", entry: "(written)" });
      continue;
    }
    // Spine-side shape check: the projection row may carry exactly the compared
    // fields plus the declared SPINE_ONLY_FIELDS. Anything else (a spine column
    // added after this tool was written) is NAMED, never silently skipped.
    const unaccounted = Object.keys(row).filter((k) => !fields.includes(k) && !SPINE_ONLY_FIELDS.includes(k));
    for (const k of unaccounted) {
      problems.push({ label, key, field: `(spine field "${k}" outside the reconciliation contract)`, spine: row[k], entry: "(no entry counterpart)" });
    }
    for (const f of fields) {
      if (!fieldEqual(f, row[f], w.entry[f])) {
        problems.push({ label, key, field: f, spine: row[f], entry: w.entry[f] });
      }
    }
  }
}

function show(v) {
  return JSON.stringify(v === undefined ? null : v);
}

// ── report ────────────────────────────────────────────────────────────────────

function planLine(row) {
  const bits = [`idSource=${row.idSource ?? row.keySource ?? "-"}`];
  bits.push(row.visibilityMissing ? "visibility=MISSING→null(fail-closed)" : `visibility=${show(row.entry.visibility)}`);
  bits.push(`groups=${show(row.entry.groups)}${row.mappedGroups ? "" : " (unmapped)"}`);
  if (row.unknownFields.length > 0) bits.push(`unknown-field(s): ${row.unknownFields.join(", ")} → will be rejected`);
  if (!row.entry.id && !row.entry.name) bits.push("no primary key → will be rejected");
  return bits.join(" ");
}

function rowLine(row) {
  if (row.outcome) return `  ${row.outcome}  ${row.key}  ${row.detail}`;
  return `  PLAN  ${row.key}  ${planLine(row)}`;
}

function pushRows({ lines, label, rows }) {
  lines.push(`── ${label} (${rows.length}) ──`);
  for (const row of rows) lines.push(rowLine(row));
}

function summaryLists({ mcpRows, skillRows }) {
  const lines = [];
  const all = [...mcpRows, ...skillRows];
  const unknownRows = all.filter((r) => r.unknownFields.length > 0);
  const visRows = all.filter((r) => r.visibilityMissing);
  const unmapped = all.filter((r) => !r.mappedGroups);
  lines.push("── summary ──");
  lines.push(
    `  servers: ${mcpRows.length} row(s) — ${mcpRows.filter((r) => r.unknownFields.length === 0 && (r.entry.id || r.entry.name)).length} ready, ` +
      `${mcpRows.filter((r) => r.unknownFields.length > 0).length} with unknown fields, ` +
      `${mcpRows.filter((r) => r.visibilityMissing).length} visibility-missing, ` +
      `${mcpRows.filter((r) => !r.mappedGroups).length} groups-unmapped`,
  );
  lines.push(
    `  skills: ${skillRows.length} row(s) — ${skillRows.filter((r) => r.unknownFields.length === 0 && (r.entry.id || r.entry.name)).length} ready, ` +
      `${skillRows.filter((r) => r.unknownFields.length > 0).length} with unknown fields, ` +
      `${skillRows.filter((r) => r.visibilityMissing).length} visibility-missing, ` +
      `${skillRows.filter((r) => !r.mappedGroups).length} groups-unmapped`,
  );
  lines.push(
    unknownRows.length
      ? `  unknown fields (${unknownRows.length} row(s)): ${unknownRows.map((r) => `${r.key}: ${r.unknownFields.join(", ")}`).join("; ")}`
      : "  unknown fields: none",
  );
  lines.push(
    visRows.length
      ? `  visibility missing → written as null, fail-closed, review (${visRows.length}): ${visRows.map((r) => r.key).join(", ")}`
      : "  visibility missing: none",
  );
  lines.push(
    unmapped.length
      ? `  groups unmapped → [] (${unmapped.length}): ${unmapped.map((r) => r.key).join(", ")}`
      : "  groups unmapped: none",
  );
  return lines;
}

// ── main ──────────────────────────────────────────────────────────────────────

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const fetchImpl = globalThis.fetch;

  const registryBase = resolveRegistryBase();
  const registryTok = registryToken();
  const spineBase = (process.env.SUPPLY_STORE_BASE || "").trim().replace(/\/+$/, "");
  if (!spineBase) throw new UsageError("SUPPLY_STORE_BASE is required (spine gateway base)");
  const writeToken = (process.env.SUPPLY_STORE_WRITE_TOKEN || "").trim();
  const projectionToken = (process.env.SUPPLY_STORE_PROJECTION_TOKEN || "").trim();
  if (!writeToken) throw new UsageError("SUPPLY_STORE_WRITE_TOKEN is required");
  if (!projectionToken) throw new UsageError("SUPPLY_STORE_PROJECTION_TOKEN is required");

  const mode = args.confirm ? "confirm" : "dry-run";
  const actor = args.actor || (process.env.SUPPLY_MIGRATE_ACTOR || "").trim() || null;
  if (args.confirm && !actor) {
    throw new UsageError("--actor <email> (or env SUPPLY_MIGRATE_ACTOR) is required in --confirm mode — every spine write must name the acting identity");
  }

  const groupsDoc = loadGroupsDoc({ fileOverride: args.groupsFile });

  // Full pull, both species, paginated to exhaustion (bridge fetchAllPages port).
  // --registry-dump <file>: read rows from a pre-cutover Mongo dump (JSON
  // array) instead of the live API — after the replica flip the API serves
  // only what the facade has already re-fed, so the dump is the pre-cutover
  // truth the migration exists to carry over.
  let serversRead, skillsRead;
  if (args.registryDump) {
    const dump = JSON.parse(fs.readFileSync(args.registryDump, "utf8"));
    const servers = dump.filter((d) => !d.record_kind || d.record_kind === "mcp_server");
    const skills = dump.filter((d) => d.record_kind === "skill");
    serversRead = { items: servers, pages: 1 };
    skillsRead = { items: skills, pages: 1 };
  } else {
    [serversRead, skillsRead] = await Promise.all([
      fetchAllRegistryPages({ fetchImpl, base: registryBase, token: registryTok, path: "/api/servers" }),
      fetchAllRegistryPages({ fetchImpl, base: registryBase, token: registryTok, path: "/api/skills" }),
    ]);
  }

  const mcpRows = serversRead.items.map((doc) => ({ ...mapMcpRow(doc, groupsDoc), visibilityMissing: doc.visibility == null }));
  const skillRows = skillsRead.items.map((doc) => ({ ...mapSkillRow(doc, groupsDoc), visibilityMissing: doc.visibility == null }));

  const lines = [
    `[supply-store-migrate] mode=${mode} registry=${registryBase} spine=${spineBase} actor=${actor ?? "-"}`,
    `registry read: servers ${serversRead.items.length} rows (${serversRead.pages} page(s)), skills ${skillsRead.items.length} rows (${skillsRead.pages} page(s))`,
  ];

  let exitCode = 0;

  if (!args.confirm) {
    pushRows({ lines, label: "servers", rows: mcpRows });
    pushRows({ lines, label: "skills", rows: skillRows });
    lines.push(...summaryLists({ mcpRows, skillRows }));
    if (mcpRows.some((r) => r.unknownFields.length > 0) || skillRows.some((r) => r.unknownFields.length > 0)) {
      exitCode = 1; // unknown fields are a hard stop per spec — nothing writes until the map is corrected
    }
  } else {
    // Confirm: write every mapped row through the gate (unknown-field rows ride
    // verbatim and are expected to be rejected — the gate's answer is recorded).
    const writeRows = async (rows, endpoint) => {
      const written = [];
      for (const row of rows) {
        const res = await spineWrite({
          base: spineBase,
          token: writeToken,
          endpoint,
          body: { actor, source: "migration", entry: row.entry },
          fetchImpl,
        });
        if (res.ok) {
          row.outcome = "WRITE";
          row.detail = "ok";
          written.push(row);
        } else {
          row.outcome = "REJECT";
          row.detail = row.unknownFields.length > 0
            ? `unknown-field(s): ${row.unknownFields.join(", ")} — HTTP ${res.status}${res.code ? ` ${res.code}` : ""}: ${res.error}`
            : `HTTP ${res.status}${res.code ? ` ${res.code}` : ""}: ${res.error}`;
        }
      }
      return written;
    };
    const writtenMcp = await writeRows(mcpRows, "/api/supply-store/mcp-servers/upsert");
    const writtenSkills = await writeRows(skillRows, "/api/supply-store/skills/upsert");

    // Row lines render AFTER the writes so they carry the real outcomes.
    pushRows({ lines, label: "servers", rows: mcpRows });
    pushRows({ lines, label: "skills", rows: skillRows });

    const writeFailures = [...mcpRows, ...skillRows].filter((r) => r.outcome === "REJECT");

    lines.push(...summaryLists({ mcpRows, skillRows }));

    // Post-write reconciliation against the read-only projection: row counts
    // plus every field, JSON fields deep-compared (isDeepStrictEqual).
    const projection = await pullProjection({ base: spineBase, token: projectionToken, fetchImpl });
    const problems = [];
    reconcileSpecies({
      label: "mcp_servers",
      projRows: projection.mcpServers ?? [],
      written: writtenMcp,
      keyOfEntry: (e) => e.id,
      keyOfRow: (r) => r.id,
      fields: MCP_COMPARE_FIELDS,
      problems,
    });
    reconcileSpecies({
      label: "skills",
      projRows: projection.skills ?? [],
      written: writtenSkills,
      keyOfEntry: (e) => e.name,
      keyOfRow: (r) => r.name,
      fields: SKILL_COMPARE_FIELDS,
      problems,
    });

    lines.push("── reconciliation ──");
    for (const p of problems) {
      lines.push(
        p.field
          ? `  DRIFT ${p.label} ${p.key} ${p.field}: spine=${show(p.spine)} entry=${show(p.entry)}`
          : `  DRIFT ${p.label} ${p.key}: spine=${p.spine} / entry=${p.entry}`,
      );
    }
    const total = writtenMcp.length + writtenSkills.length;
    const agree = total - problems.length;
    if (problems.length === 0) {
      lines.push(`  row-level reconciliation: ${agree}/${total} AGREE`);
    } else {
      lines.push(`  row-level reconciliation: ${agree}/${total} — MISMATCH`);
    }

    if (writeFailures.length > 0 || problems.length > 0) exitCode = 1;
  }

  console.log(lines.join("\n"));
  return exitCode;
}

try {
  process.exit(await run());
} catch (err) {
  if (err instanceof UsageError) {
    console.error(`[supply-store-migrate] usage: ${err.message}`);
    process.exit(2);
  }
  if (err instanceof RegistryReadError || err instanceof ConnectionError) {
    console.error(`[supply-store-migrate] connection: ${err.message}`);
    process.exit(2);
  }
  console.error(`[supply-store-migrate] fatal: ${err?.stack ?? err}`);
  process.exit(2);
}
