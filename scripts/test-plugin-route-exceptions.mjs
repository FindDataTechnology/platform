// Unit tests — route-exception allowlist (change harden-plugin-supply-gates,
// task 4.3).
// Run: node --test scripts/test-plugin-route-exceptions.mjs
//
// An exception mechanism is the softest part of a gate, so its failure modes are
// pinned one by one:
//   · a valid entry excepts by PACKAGE NAME and says who approved it;
//   · an expired entry stops granting and is reported (not silently ignored);
//   · a malformed entry grants nothing (no "missing expiry ⇒ forever");
//   · an id is not an identity — renaming the row must not outrun the gate;
//   · an unreadable exceptions FILE grants nothing (fail closed, unlike a gate
//     that quietly skips its evidence).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { applyRouteExceptions, findRouteExclusivityViolations } from "../lib/llm-route-exclusivity.js";
import { loadRouteExceptions, DEFAULT_ROUTE_EXCEPTIONS_FILE } from "../lib/route-exceptions.js";
import { guardProfileRouteExclusivity } from "../lib/profile-route-guard.js";

const tmp = mkdtempSync(path.join(tmpdir(), "route-exceptions-"));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

function entry(over = {}, base = NOW) {
  return { name: "@acme/dsh-llm-router", reason: "vendor pilot", approvedBy: "ops@acme", expiresAt: base + DAY, ...over };
}

const HOSTILE_ROWS = [
  { insert: [{ id: "sdk-jsonrpc-server", name: "@deepseek-ai/dsh-sdk-jsonrpc-server" }] },
  { id: "vendor-llm", name: "@acme/dsh-llm-router", config: { providers: { evil: {} } } },
];

function silentLog() {
  const lines = [];
  return { lines, warn: (m) => lines.push(String(m)) };
}

test("a valid entry excepts the bundle and leaves nothing violating", () => {
  const violations = findRouteExclusivityViolations(HOSTILE_ROWS);
  const res = applyRouteExceptions(violations, [entry()], { now: NOW });
  assert.deepEqual(res.violations, []);
  assert.equal(res.allowed.length, 1);
  assert.equal(res.allowed[0].exception.name, "@acme/dsh-llm-router");
  assert.deepEqual(res.expired, []);
});

test("an expired entry stops granting and is reported", () => {
  const violations = findRouteExclusivityViolations(HOSTILE_ROWS);
  const res = applyRouteExceptions(violations, [entry({ expiresAt: NOW - 1 })], { now: NOW });
  assert.equal(res.violations.length, 1);
  assert.deepEqual(res.allowed, []);
  assert.equal(res.expired.length, 1);
  assert.equal(res.expired[0].name, "@acme/dsh-llm-router");
});

test("an entry with no expiry, approver or reason grants nothing", () => {
  const violations = findRouteExclusivityViolations(HOSTILE_ROWS);
  for (const broken of [
    entry({ expiresAt: undefined }),
    entry({ approvedBy: "  " }),
    entry({ reason: "" }),
    entry({ name: undefined }),
    entry({ expiresAt: "2027-01-01" }), // a string is not an instant we trust
  ]) {
    const res = applyRouteExceptions(violations, [broken], { now: NOW });
    assert.equal(res.violations.length, 1, `entry should not grant: ${JSON.stringify(broken)}`);
  }
});

test("an exception is matched by package name, not by row id", () => {
  const violations = findRouteExclusivityViolations(HOSTILE_ROWS);
  // Same row id, different package: the exception must not carry over.
  const res = applyRouteExceptions(violations, [entry({ name: "vendor-llm" })], { now: NOW });
  assert.equal(res.violations.length, 1);
  assert.equal(res.allowed.length, 0);
});

test("exceptions do not touch the platform's own rows", () => {
  const violations = findRouteExclusivityViolations(HOSTILE_ROWS);
  const res = applyRouteExceptions(violations, [entry({ name: "@deepseek-ai/dsh-llm-pi-ai" })], { now: NOW });
  assert.equal(res.violations.length, 1);
});

test("the loader treats an absent file as no exceptions, not an error", () => {
  const res = loadRouteExceptions(path.join(tmp, "nope.json"));
  assert.deepEqual(res.exceptions, []);
  assert.deepEqual(res.errors, []);
});

test("the loader reports an unparsable file and grants nothing", () => {
  const file = path.join(tmp, "broken.json");
  writeFileSync(file, "{ not json");
  const res = loadRouteExceptions(file);
  assert.deepEqual(res.exceptions, []);
  assert.equal(res.errors.length, 1);
  assert.match(res.errors[0], /unreadable or unparsable/);
});

test("the loader reports malformed entries and keeps the file path in the message", () => {
  const file = path.join(tmp, "partial.json");
  writeFileSync(file, JSON.stringify({ exceptions: [entry(), { name: "@acme/x" }] }));
  const res = loadRouteExceptions(file);
  assert.equal(res.exceptions.length, 2);
  assert.ok(res.errors.length >= 3, "each missing field is named");
  assert.ok(res.errors.every((e) => e.includes("partial.json")));
});

test("the repository's own exceptions file is empty and well-formed", () => {
  const res = loadRouteExceptions(DEFAULT_ROUTE_EXCEPTIONS_FILE);
  assert.deepEqual(res.errors, []);
  assert.deepEqual(res.exceptions, []);
});

test("the boot guard applies a live exception instead of throwing, and says so", () => {
  const patch = path.join(tmp, "patch-excepted.yml");
  writeFileSync(patch, yaml.dump(HOSTILE_ROWS));
  const log = silentLog();
  // The guard uses the real clock — an exception that "expires in 2027" is live.
  const res = guardProfileRouteExclusivity(patch, { exceptions: [entry({}, Date.now())], log });
  assert.equal(res.checked, true);
  assert.deepEqual(res.violations, []);
  assert.ok(log.lines.some((l) => /EXCEPTED '@acme\/dsh-llm-router'/.test(l)), log.lines.join("\n"));
});

test("the boot guard still throws on an expired exception", () => {
  const patch = path.join(tmp, "patch-expired.yml");
  writeFileSync(patch, yaml.dump(HOSTILE_ROWS));
  const log = silentLog();
  assert.throws(
    () => guardProfileRouteExclusivity(patch, { exceptions: [entry({ expiresAt: Date.now() - DAY })], log }),
    (err) => err.code === "dsh_route_exclusivity_violation" && err.violations.length === 1,
  );
  assert.ok(log.lines.some((l) => /EXPIRED exception/.test(l)), log.lines.join("\n"));
});

test("the boot guard reads the exceptions file it is pointed at", () => {
  const patch = path.join(tmp, "patch-fromfile.yml");
  writeFileSync(patch, yaml.dump(HOSTILE_ROWS));
  const file = path.join(tmp, "live.json");
  writeFileSync(file, JSON.stringify({ exceptions: [entry({}, Date.now())] }));
  const res = guardProfileRouteExclusivity(patch, { exceptionsFile: file, log: silentLog() });
  assert.deepEqual(res.violations, []);
});

test("the boot guard fails closed when the exceptions file is malformed", () => {
  const patch = path.join(tmp, "patch-badexceptions.yml");
  writeFileSync(patch, yaml.dump(HOSTILE_ROWS));
  const file = path.join(tmp, "bad.json");
  writeFileSync(file, "[[[");
  const log = silentLog();
  assert.throws(
    () => guardProfileRouteExclusivity(patch, { exceptionsFile: file, log }),
    (err) => err.code === "dsh_route_exclusivity_violation",
  );
  assert.ok(log.lines.some((l) => /exception file:/.test(l)), log.lines.join("\n"));
});
