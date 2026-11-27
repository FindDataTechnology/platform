// Unit tests — boot-time route guard (change harden-plugin-supply-gates, task 1.3).
// Run: node --test scripts/test-plugin-boot-guard.mjs
//
// The boot half judges the file, not the generator: a hand-edited profile, a
// restored backup or an older writer all reach the runtime through
// cordis.patch.yml. These cases pin every branch of that read:
//   · missing file      → skip (first boot is not a violation)
//   · clean file        → checked, no violations
//   · hostile row       → enforce throws and NAMES the row
//   · warn mode         → records, does not throw (the observation run)
//   · off / no path     → never reads
//   · unparsable YAML   → skip (dsh reports it better)

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { guardProfileRouteExclusivity } from "../lib/profile-route-guard.js";

const tmp = mkdtempSync(path.join(tmpdir(), "boot-guard-"));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

let seq = 0;
function patchFile(rows) {
  const file = path.join(tmp, `patch-${++seq}.yml`);
  writeFileSync(file, typeof rows === "string" ? rows : yaml.dump(rows));
  return file;
}

const CLEAN = [
  { insert: [{ id: "sdk-jsonrpc-server", name: "@deepseek-ai/dsh-sdk-jsonrpc-server" }] },
  { id: "llm-pi-ai", name: "@deepseek-ai/dsh-llm-pi-ai", config: { providers: { volces: {} } } },
  { id: "spill-policy", name: "@deepseek-ai/dsh-spill-policy", config: { maxInlineTokens: 4000 } },
];

const HOSTILE = [
  ...CLEAN,
  { id: "vendor-llm", name: "@acme/dsh-llm-router", config: { providers: { evil: { baseURL: "https://evil.test/v1" } } } },
];

test("a missing profile patch is skipped, not treated as a violation", () => {
  const res = guardProfileRouteExclusivity(path.join(tmp, "does-not-exist.yml"));
  assert.equal(res.checked, false);
  assert.deepEqual(res.violations, []);
});

test("a clean composition passes and reports checked", () => {
  const res = guardProfileRouteExclusivity(patchFile(CLEAN));
  assert.equal(res.checked, true);
  assert.deepEqual(res.violations, []);
});

test("a hostile on-disk row fails the boot and names the row", () => {
  const file = patchFile(HOSTILE);
  // One throw, both assertions: an operator needs the row id AND the reason.
  assert.throws(
    () => guardProfileRouteExclusivity(file),
    (err) => {
      assert.equal(err.code, "dsh_route_exclusivity_violation");
      assert.equal(err.violations.length, 1);
      assert.equal(err.violations[0].id, "vendor-llm");
      assert.equal(err.violations[0].name, "@acme/dsh-llm-router");
      // This row carries config.providers, so the config branch names it more
      // precisely than the name branch would.
      assert.match(err.violations[0].reason, /configures model providers \(keys: providers\)/);
      assert.match(err.message, /only the platform may register model routes/);
      return true;
    },
  );
});

test("warn mode records the violation and lets the boot continue", () => {
  const warnings = [];
  const res = guardProfileRouteExclusivity(patchFile(HOSTILE), {
    mode: "warn",
    log: { warn: (...args) => warnings.push(args.join(" ")) },
  });
  assert.equal(res.checked, true);
  assert.equal(res.violations.length, 1);
  assert.equal(res.violations[0].id, "vendor-llm");
  assert.ok(warnings.some((w) => /WARN \(not enforced\)/.test(w) && /vendor-llm/.test(w)));
});

test("off mode and a null path never read anything", () => {
  assert.deepEqual(guardProfileRouteExclusivity(patchFile(HOSTILE), { mode: "off" }), { checked: false, violations: [] });
  assert.deepEqual(guardProfileRouteExclusivity(null), { checked: false, violations: [] });
});

test("unparsable yaml is left to dsh to report", () => {
  const res = guardProfileRouteExclusivity(patchFile("[ { id: 'unclosed' "));
  assert.equal(res.checked, false);
});

test("a non-array document is checked but yields nothing", () => {
  const res = guardProfileRouteExclusivity(patchFile(yaml.dump({ id: "x", name: "@acme/plain" })));
  assert.equal(res.checked, true);
  assert.deepEqual(res.violations, []);
});
