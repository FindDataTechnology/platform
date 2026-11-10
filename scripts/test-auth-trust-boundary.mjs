// Trust-boundary ledger check (extend-auth-trust-boundary-ledger /
// enumerate-auth-bridges-in-ledger).
//
// `auth` R7 enumerates every door an identity can come through. Three of those
// lists are machine-checkable against the implementation, and this file is the
// check that keeps them honest — the audit's root complaint was that the
// boundaries existed only in code comments, where nothing fails when the two
// sides drift:
//
//   1. the auth-exempt prefix table must equal `AUTH_EXEMPT_PREFIXES`;
//   2. no route may compare a caller-supplied shared secret with `!==`
//      (the constant-time rule; `pack-usage` was the one offender);
//   3. the internal-bridge table must equal `INTERNAL_BRIDGES` — the list R7
//      demanded and the spec did not have, so ten identity-stamping doors sat
//      in comments only.
//
// The identity-door table is prose by nature; this check only asserts it is
// present and populated, so a landing that deletes it fails here instead of
// silently shrinking the ledger.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const SPEC = join(ROOT, "openspec/specs/auth/spec.md");

const { AUTH_EXEMPT_PREFIXES, INTERNAL_BRIDGES } = await import("../server/auth.js");

// Rows of the "Auth-exempt prefixes" table: the first backticked token in the
// first cell, comma-split so one row may document a pair (`/api/mp/login`,
// `/api/mp/login-bindcode`).
function documentedPrefixes(spec) {
  const start = spec.indexOf("**Auth-exempt prefixes.**");
  assert.notEqual(start, -1, "spec is missing the auth-exempt prefix ledger");
  const end = spec.indexOf("**Identity doors.**", start);
  assert.notEqual(end, -1, "spec is missing the identity-door ledger");
  const block = spec.slice(start, end);
  const found = [];
  for (const line of block.split("\n")) {
    if (!line.startsWith("| `/")) continue;
    const cell = line.split("|")[1] || "";
    for (const m of cell.matchAll(/`([^`]+)`/g)) found.push(m[1]);
  }
  return found.sort();
}

test("ledger: the spec's exempt-prefix table equals AUTH_EXEMPT_PREFIXES", () => {
  const spec = readFileSync(SPEC, "utf8");
  assert.deepEqual(
    [...AUTH_EXEMPT_PREFIXES].sort(),
    documentedPrefixes(spec),
    "auth.js AUTH_EXEMPT_PREFIXES and the spec's table have diverged — update both in one landing",
  );
});

test("ledger: every exempt prefix states its own credential and fail posture", () => {
  const spec = readFileSync(SPEC, "utf8");
  const start = spec.indexOf("**Auth-exempt prefixes.**");
  const end = spec.indexOf("**Identity doors.**", start);
  const rows = spec
    .slice(start, end)
    .split("\n")
    .filter((l) => l.startsWith("| `/"));
  // A row may document a pair (mp login / app pairing), so rows <= prefixes;
  // test 1 already pins the prefix sets equal, this only pins per-row detail.
  assert.ok(rows.length > 0 && rows.length <= AUTH_EXEMPT_PREFIXES.length, `${rows.length} rows for ${AUTH_EXEMPT_PREFIXES.length} prefixes`);
  for (const row of rows) {
    const cells = row.split("|").map((c) => c.trim());
    // | prefix | credential | fail posture |  — "401" is a legitimate posture.
    assert.ok(cells[2] && cells[2].length >= 3, `missing credential cell: ${row}`);
    assert.ok(cells[3] && cells[3].length >= 3, `missing fail-posture cell: ${row}`);
  }
});

test("ledger: the identity-door table is present and populated", () => {
  const spec = readFileSync(SPEC, "utf8");
  const start = spec.indexOf("**Identity doors.**");
  assert.notEqual(start, -1);
  const block = spec.slice(start);
  const rows = block.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| Door"));
  assert.ok(rows.length >= 10, `identity-door table has ${rows.length} rows, expected >= 10`);
  for (const door of ["gateway secret", "session cookie", "Mini-program", "Cell-owner", "Auth disabled"]) {
    assert.ok(block.includes(door), `identity-door ledger lost the "${door}" row`);
  }
});

// ── the internal bridges (enumerate-auth-bridges-in-ledger) ─────────────────
//
// R7 requires every bridge the gate opens to be written down with the identity
// it stamps, its verb/path scope and the attribution that keeps a forged
// loopback caller from acting as a name it supplies. The requirement existed;
// the table did not. These two tests are what would have failed.

// | `identity` | verb/path scope | attribution |
function documentedBridges(spec) {
  const start = spec.indexOf("**Internal bridges.**");
  assert.notEqual(start, -1, "spec is missing the internal-bridge ledger");
  const end = spec.indexOf("**Auth-exempt prefixes.**", start);
  assert.notEqual(end, -1, "spec is missing the auth-exempt prefix ledger");
  return spec
    .slice(start, end)
    .split("\n")
    .filter((line) => line.startsWith("| `"))
    .map((row) => {
      const cells = row.split("|").map((c) => c.trim());
      assert.ok(cells[1] && cells[1].length >= 3, `missing bridge identity: ${row}`);
      assert.ok(cells[2] && cells[2].length >= 3, `missing scope cell: ${row}`);
      assert.ok(cells[3] && cells[3].length >= 3, `missing attribution cell: ${row}`);
      return { email: (cells[1].match(/`([^`]+)`/) || [])[1], scope: cells[2], note: cells[3] };
    });
}

test("ledger: the spec's internal-bridge table equals INTERNAL_BRIDGES", () => {
  const documented = documentedBridges(readFileSync(SPEC, "utf8"));
  assert.deepEqual(
    documented.map((b) => b.email).sort(),
    INTERNAL_BRIDGES.map((b) => b.email).sort(),
    "server/auth.js INTERNAL_BRIDGES and the spec's bridge table have diverged — update both in one landing",
  );
});

test("ledger: every bridge states a real path scope and a real attribution", () => {
  // A placeholder attribution is the failure mode that matters: a bridge whose
  // row says nothing about route-side attribution is the one where a forged
  // loopback caller gets to name the identity it acts as.
  for (const bridge of documentedBridges(readFileSync(SPEC, "utf8"))) {
    assert.match(bridge.scope, /\/api/, `bridge ${bridge.email} names no path scope: ${bridge.scope}`);
    assert.ok(bridge.note.length >= 10, `bridge ${bridge.email} has a placeholder attribution: ${bridge.note}`);
  }
});

test("ledger: no route compares a shared secret with an equality operator", () => {
  // Scope: the route modules that own a self-authenticating door. A secret
  // compared with === or !== leaks a byte-by-byte timing signal; the platform's
  // one implementation is secretMatches.
  const dir = join(ROOT, "server/routes");
  const offenders = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".js")) continue;
    const text = readFileSync(join(dir, file), "utf8");
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      // `x !== \`Bearer ${token}\`` / `=== \`Bearer ${...}\`` — the anti-pattern.
      if (/(!==|===)\s*`Bearer \$\{/.test(line)) offenders.push(`${file}:${i + 1} ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], `use secretMatches for shared-secret comparison:\n${offenders.join("\n")}`);
});
