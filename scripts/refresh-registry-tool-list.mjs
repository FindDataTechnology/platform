#!/usr/bin/env node
// ── Refresh one registry entry's tool_list snapshot (add-mcp-tool-scoping) ───
//
// The publish gate treats the registry entry's `tool_list` as its truth. When
// a server's tool surface changed after registration (or the snapshot was never
// refreshed), a legitimate declaration can read as missing — and with the live
// probe unavailable (the billing gate answers 503 fail-closed on the public
// MCP route), the gate can only say "unresolved". This script is the next step
// that message points at: re-read the tool names from the server and write them
// back into the entry.
//
// Two read paths, in order of preference:
//   1. --registry-refresh (DEFAULT) — the registry's own
//      `POST /api/refresh/<path>` re-fetches the tool surface server-side and
//      rewrites the entry's tool_list itself. It needs no upstream credential
//      and is not blocked by the billing gate, so it is the first thing to try
//      (verified 2026-10-11 on three 已上牌 entries: healthy, counts intact).
//   2. --upstream <url> / --from-json <file> — re-read the names ourselves
//      (runtime tools/list, or an already-captured result) and PATCH them in.
//      Use when the registry refresh does not pick up a change; the upstream
//      usually wants its own credential, not the registry token (401).
//
// The write goes through the console-session PATCH channel (JSON Merge Patch),
// which needs an admin session cookie and a CSRF token; reuse the token file
// the pack-builder flow already uses, or pass --csrf/--cookie explicitly.
//
//   node scripts/refresh-registry-tool-list.mjs --path /law-bench --upstream http://cheap6.mesh.finddata.cn:30840/mcp
//   node scripts/refresh-registry-tool-list.mjs --path /law-bench --from-json /tmp/tools.json --dry-run
//
// Exit code: 0 success / 1 failure (nothing written on failure).

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { probeMcpToolNames } from "../lib/publish-tool-gate.js";

const REGISTRY = process.env.REGISTRY_URL || "https://mcp.finddatatech.cloud";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

const entryPath = arg("path");
if (!entryPath) {
  console.error("✗ --path /<registry-entry-path> is required");
  process.exit(1);
}
const dryRun = has("dry-run");

const cookie = process.env.REGISTRY_COOKIE || arg("cookie");
const csrf = process.env.REGISTRY_CSRF || arg("csrf");

// ── 1a. the registry's own refresh (default path) ────────────────────────────
// Server-side re-fetch: no upstream credential, no billing gate. When it
// succeeds the entry is already updated, so there is nothing to PATCH.
if (!has("upstream") && !arg("from-json")) {
  if (dryRun) {
    console.log(`[refresh] dry run — would POST ${REGISTRY}/api/refresh${entryPath}`);
    process.exit(0);
  }
  if (!cookie || !csrf) {
    console.error(
      `✗ registry refresh needs an admin console session.\n` +
        `  Set REGISTRY_COOKIE (session cookie from a logged-in console tab) and REGISTRY_CSRF (from GET ${REGISTRY}/api/auth/csrf-token).\n` +
        `  Alternatively pass --upstream/--from-json to re-read and PATCH the names yourself.`,
    );
    process.exit(1);
  }
  const r = await fetch(`${REGISTRY.replace(/\/+$/, "")}/api/refresh${entryPath}`, {
    method: "POST",
    headers: { "X-CSRF-Token": csrf, Cookie: cookie, "Content-Type": "application/json" },
  });
  const body = await r.text();
  if (!r.ok) {
    console.error(`✗ refresh failed: HTTP ${r.status} ${body.slice(0, 200)}`);
    process.exit(1);
  }
  let doc = null;
  try { doc = JSON.parse(body); } catch { /* non-JSON body: report raw */ }
  console.log(
    `[refresh] ${entryPath}: ${doc?.message ?? body.slice(0, 120)}` +
      (doc?.num_tools != null ? ` — ${doc.num_tools} tool(s), status ${doc.status ?? "?"}` : ""),
  );
  process.exit(0);
}

// ── 1b. read the tool names ourselves, then PATCH them in ────────────────────
let names = null;
const fromJson = arg("from-json");
if (fromJson) {
  const doc = JSON.parse(readFileSync(fromJson, "utf8"));
  const tools = Array.isArray(doc) ? doc : doc?.result?.tools ?? doc?.tools;
  if (!Array.isArray(tools)) throw new Error(`${fromJson}: no tools array found`);
  names = tools.map((t) => t?.name).filter((n) => typeof n === "string");
  console.log(`[refresh] read ${names.length} tool name(s) from ${fromJson}`);
} else {
  const endpoint = arg("upstream") || `${REGISTRY.replace(/\/+$/, "")}${entryPath}/mcp`;
  const bearer = process.env.REGISTRY_BEARER || (
    (() => {
      try {
        const f = join(homedir(), ".config/finddata/gateway-token.json");
        return JSON.parse(readFileSync(f, "utf8"))?.tokens?.access_token || null;
      } catch { return null; }
    })()
  );
  names = await probeMcpToolNames(endpoint, {
    headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
    timeoutMs: Number(process.env.PROBE_TIMEOUT_MS || 10_000),
  });
  if (!names) {
    const why = probeMcpToolNames.lastError?.message || "unknown";
    const hints = /BILLING_UNAVAILABLE/.test(why)
      ? "the public route is behind the billing gate — retry with --upstream <ledger 上游 URL> from a host that can reach it"
      : /401|403|not authorized/.test(why)
        ? "this endpoint wants its own credential, not the registry token — capture the list on a host that has it"
        : "check reachability and credentials";
    console.error(`✗ could not read tools/list from ${endpoint}: ${why}\n  → ${hints}`);
    process.exit(1);
  }
  console.log(`[refresh] probed ${names.length} tool name(s) from ${endpoint}`);
}

// ── 2. write them back into the entry ────────────────────────────────────────
if (!cookie || !csrf) {
  console.error(
    `✗ an admin console session is required to PATCH the entry.\n` +
      `  Set REGISTRY_COOKIE (copy the session cookie from a logged-in console tab) and REGISTRY_CSRF (from GET ${REGISTRY}/api/auth/csrf-token).\n` +
      `  Names are ready to paste manually otherwise: ${names.join(", ")}`,
  );
  process.exit(1);
}

if (dryRun) {
  console.log(`[refresh] dry run — would PATCH ${entryPath} with ${names.length} tool name(s)`);
  console.log(names.join(", "));
  process.exit(0);
}

const res = await fetch(`${REGISTRY.replace(/\/+$/, "")}/api/servers${entryPath}`, {
  method: "PATCH",
  headers: {
    "Content-Type": "application/json",
    "X-CSRF-Token": csrf,
    Cookie: cookie,
  },
  // Registry entries store tool_list as tool OBJECTS (name/description/schema),
  // not name strings — writing bare strings would corrupt the snapshot shape
  // every other consumer (console UI, semantic search) reads.
  body: JSON.stringify({ tool_list: names.map((n) => ({ name: n })), num_tools: names.length }),
});
if (!res.ok) {
  console.error(`✗ PATCH failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  process.exit(1);
}
console.log(`[refresh] ${entryPath}: tool_list refreshed to ${names.length} name(s)`);
