// Unit tests — credential surface check (change harden-plugin-supply-gates,
// tasks 3.1 / 3.2).
// Run: node --test scripts/test-plugin-credential-surface.mjs
//
// Two directions, both required:
//   · a declaration carrying platform credential material is REFUSED with the
//     file, the field path and the key named (so the fix is one edit, not a log
//     hunt);
//   · the real repository's own declarations are clean — a gate that is red on
//     main is a gate nobody keeps.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  PLATFORM_CREDENTIAL_KEYS,
  scanForCredentialKeys,
  scanFiles,
  defaultTargets,
} from "../scripts/check-bundle-credentials.mjs";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

test("a credential key nested anywhere is found with its path", () => {
  const doc = {
    name: "p",
    bundles: [{ name: "@acme/x", env: { FACET_INTERNAL_TOKEN: "secret" } }],
    list: [{ deeper: [{ PACK_USAGE_TOKEN: "t" }] }],
  };
  const hits = scanForCredentialKeys(doc);
  assert.deepEqual(
    hits.map((h) => h.path).sort(),
    ["bundles[0].env.FACET_INTERNAL_TOKEN", "list[0].deeper[0].PACK_USAGE_TOKEN"],
  );
  assert.deepEqual(hits.map((h) => h.key).sort(), ["FACET_INTERNAL_TOKEN", "PACK_USAGE_TOKEN"]);
});

test("the documented user-provider form is matched by prefix", () => {
  const hits = scanForCredentialKeys({ refs: { LLM_PROVIDER_KEY_ACME: "k" } });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].key, "LLM_PROVIDER_KEY");
});

test("legitimate adjacent names are not flagged", () => {
  // A bot token belongs to the operator's bot row; a generic TOKEN env does not
  // exist in the credential set. Flagging these would make the gate noisy.
  assert.deepEqual(scanForCredentialKeys({ bot: { token: "x" }, name: "TOKEN" }), []);
  assert.deepEqual(scanForCredentialKeys({ note: "no keys here" }), []);
});

test("every declared key is really checked (no dead list entries)", () => {
  const hits = scanForCredentialKeys(Object.fromEntries(PLATFORM_CREDENTIAL_KEYS.map((k) => [k, "v"])));
  assert.equal(hits.length, PLATFORM_CREDENTIAL_KEYS.length);
});

test("the real repository's declarations are clean", () => {
  const targets = defaultTargets(REPO);
  assert.ok(targets.length >= 3, "expected the profile template declarations to be in scope");
  assert.deepEqual(scanFiles(targets), []);
});

test("the CLI fails with a named hit on a hostile declaration", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cred-scan-"));
  try {
    const hostile = path.join(dir, "cordis.patch.yml");
    writeFileSync(hostile, "- id: evil\n  config:\n    env:\n      SUB2API_ADMIN_KEY: leak\n");
    const res = spawnSync(process.execPath, [path.join(REPO, "scripts/check-bundle-credentials.mjs"), "--root", dir, "--file", hostile], {
      encoding: "utf8",
    });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /SUB2API_ADMIN_KEY/);
    assert.match(res.stderr, /config\.env\.SUB2API_ADMIN_KEY/);
    assert.match(res.stderr, /runbook S6/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the CLI exits 0 and reports the scan size when clean", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cred-clean-"));
  try {
    mkdirSync(path.join(dir, "dsh-profile-template"), { recursive: true });
    writeFileSync(path.join(dir, "dsh-profile-template", "cordis.patch.yml"), "- insert:\n    - id: sdk-jsonrpc-server\n");
    const res = spawnSync(process.execPath, [path.join(REPO, "scripts/check-bundle-credentials.mjs"), "--root", dir], {
      encoding: "utf8",
    });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /clean — 1 declaration\(s\) scanned/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
