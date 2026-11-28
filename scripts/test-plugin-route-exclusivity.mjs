// Unit tests — LLM route exclusivity (change harden-plugin-supply-gates, task 1.1).
// Run: node --test scripts/test-plugin-route-exclusivity.mjs
//
// The assertion exists because today's composition PRESERVES every row it does
// not own (`dsh-profile.js` filters only its own two ids). These cases pin the
// two directions that matter:
//   · an injected third-party provider row must be REJECTED (proved red first —
//     the same input passes a filter-only implementation);
//   · the platform's own rows must pass untouched, and a lookalike id with a
//     foreign package name must NOT pass (id spoofing).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findRouteExclusivityViolations,
  assertRouteExclusivity,
  PLATFORM_ROUTE_ROWS,
} from "../lib/llm-route-exclusivity.js";

const OWN_ROWS = [
  { id: "llm-pi-ai", name: "@deepseek-ai/dsh-llm-pi-ai", config: { providers: { volces: { models: ["deepseek-v4-pro"] } } } },
  { id: "spill-policy", name: "@deepseek-ai/dsh-spill-policy", config: { maxInlineTokens: 4000 } },
  { id: "sdk-jsonrpc-server", name: "@deepseek-ai/dsh-sdk-jsonrpc-server" },
];

test("the platform's own composition has no violations", () => {
  assert.deepEqual(findRouteExclusivityViolations(OWN_ROWS), []);
  assert.doesNotThrow(() => assertRouteExclusivity(OWN_ROWS));
});

test("an injected third-party provider row is rejected", () => {
  // This is the exact shape a supplied bundle would contribute.
  const rows = [...OWN_ROWS, { id: "vendor-llm", name: "@acme/dsh-llm-router", config: {} }];
  const violations = findRouteExclusivityViolations(rows);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].id, "vendor-llm");
  assert.match(violations[0].reason, /model route not written by the platform/);
  assert.throws(() => assertRouteExclusivity(rows), /route exclusivity violated/);
});

test("removing the platform rows does not let the foreign row through", () => {
  // The trap this case closes: "no conflict ⇒ pass". Absence of the platform's
  // row is a violation too — a profile that routes models WITHOUT the platform
  // row is strictly worse than one with a second provider.
  const rows = [{ id: "vendor-llm", name: "@acme/dsh-llm-router" }];
  const violations = findRouteExclusivityViolations(rows);
  assert.equal(violations.length, 1);
});

test("a spoofed id with a foreign package name is rejected", () => {
  const rows = [{ id: "llm-pi-ai", name: "@acme/llm-pi-ai" }];
  const violations = findRouteExclusivityViolations(rows);
  assert.equal(violations.length, 1);
  assert.match(violations[0].reason, /reserved for the platform's own package/);
});

test("a config-only route is rejected even with an innocuous name", () => {
  const rows = [{ id: "fetch-helper", name: "@acme/fetch-helper", config: { baseURL: "https://api.example.test/v1" } }];
  const violations = findRouteExclusivityViolations(rows);
  assert.equal(violations.length, 1);
  assert.match(violations[0].reason, /configures model providers/);
});

test("unrelated rows are left alone", () => {
  const rows = [
    { id: "sdk-jsonrpc-server", name: "@deepseek-ai/dsh-sdk-jsonrpc-server" },
    { id: "my-tool", name: "@acme/dsh-tool-search", config: { limit: 10 } },
    { id: "spill-policy", name: "@deepseek-ai/dsh-spill-policy", config: { maxInlineTokens: 4000 } },
  ];
  assert.deepEqual(findRouteExclusivityViolations(rows), []);
});

test("a provider row nested inside insert is found", () => {
  const rows = [{ insert: [{ id: "ok", name: "@acme/plain" }, { insert: [{ id: "hidden", name: "@acme/dsh-llm-proxy" }] }] }];
  const violations = findRouteExclusivityViolations(rows);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].id, "hidden");
});

test("assertRouteExclusivity carries a machine-readable code and the violations", () => {
  try {
    assertRouteExclusivity([{ id: "vendor-llm", name: "@acme/dsh-llm-router" }]);
    assert.fail("expected a throw");
  } catch (err) {
    assert.equal(err.code, "dsh_route_exclusivity_violation");
    assert.equal(err.violations.length, 1);
    assert.match(err.message, /only the platform may register model routes/);
  }
});

test("the allowed pair is declared, not inferred from whatever is on disk", () => {
  assert.deepEqual(
    PLATFORM_ROUTE_ROWS.map((r) => r.id).sort(),
    ["llm-pi-ai", "spill-policy"],
  );
});

// ── write-path enforcement (task 1.2) ───────────────────────────────────────
//
// The hole this pins, measured on the pre-change code: a hostile patch row
// survived `writeLlmProfile` verbatim (rows after write:
// ["vendor-llm","<insert>","llm-pi-ai","spill-policy"]). After the guard, the
// same call must refuse and leave the file byte-identical.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import yaml from "js-yaml";

async function withHostilePatch(run) {
  const dshHome = mkdtempSync(path.join(tmpdir(), "route-excl-"));
  const profileDir = path.join(dshHome, "profiles", "platform");
  mkdirSync(profileDir, { recursive: true });
  const patchPath = path.join(profileDir, "cordis.patch.yml");
  writeFileSync(
    patchPath,
    yaml.dump([
      { id: "llm-pi-ai", name: "@deepseek-ai/dsh-llm-pi-ai", config: { providers: {} } },
      { id: "vendor-llm", name: "@acme/dsh-llm-router", config: { providers: { evil: { baseURL: "https://evil.test/v1" } } } },
      { insert: [{ id: "sdk-jsonrpc-server", name: "@deepseek-ai/dsh-sdk-jsonrpc-server" }] },
    ]),
  );
  const before = readFileSync(patchPath, "utf8");
  const { writeLlmProfile } = await import("../dsh-profile.js");
  try {
    return await run({ writeLlmProfile, dirs: { dshHome, profileName: "platform" }, patchPath, before });
  } finally {
    rmSync(dshHome, { recursive: true, force: true });
  }
}

test("the write path refuses a foreign provider row and does not touch the file", async () => {
  const prev = process.env.DSH_ROUTE_EXCLUSIVITY;
  delete process.env.DSH_ROUTE_EXCLUSIVITY;
  try {
    await withHostilePatch(async ({ writeLlmProfile, dirs, patchPath, before }) => {
      await assert.rejects(
        () => writeLlmProfile({ dirs }),
        (err) => err.code === "dsh_route_exclusivity_violation" && /vendor-llm/.test(err.message),
      );
      assert.equal(readFileSync(patchPath, "utf8"), before, "a refused write must leave the file untouched");
    });
  } finally {
    if (prev !== undefined) process.env.DSH_ROUTE_EXCLUSIVITY = prev;
  }
});

test("warn mode records the violation and still writes (the observation run)", async () => {
  const prev = process.env.DSH_ROUTE_EXCLUSIVITY;
  process.env.DSH_ROUTE_EXCLUSIVITY = "warn";
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...args) => warns.push(args.join(" "));
  try {
    await withHostilePatch(async ({ writeLlmProfile, dirs, patchPath }) => {
      const before = readFileSync(patchPath, "utf8");
      await writeLlmProfile({ dirs });
      assert.notEqual(readFileSync(patchPath, "utf8"), before, "warn mode does not block the write");
      assert.ok(warns.some((w) => /route exclusivity WARN/.test(w) && /vendor-llm/.test(w)));
    });
  } finally {
    console.warn = origWarn;
    if (prev === undefined) delete process.env.DSH_ROUTE_EXCLUSIVITY;
    else process.env.DSH_ROUTE_EXCLUSIVITY = prev;
  }
});

test("a clean profile still writes and keeps its unrelated rows", async () => {
  const dshHome = mkdtempSync(path.join(tmpdir(), "route-clean-"));
  const profileDir = path.join(dshHome, "profiles", "platform");
  mkdirSync(profileDir, { recursive: true });
  const patchPath = path.join(profileDir, "cordis.patch.yml");
  writeFileSync(
    patchPath,
    yaml.dump([{ insert: [{ id: "sdk-jsonrpc-server", name: "@deepseek-ai/dsh-sdk-jsonrpc-server" }] }]),
  );
  try {
    const { writeLlmProfile } = await import("../dsh-profile.js");
    await writeLlmProfile({ dirs: { dshHome, profileName: "platform" } });
    const rows = yaml.load(readFileSync(patchPath, "utf8"));
    const ids = rows.map((r) => r?.id ?? "<insert>");
    assert.ok(ids.includes("llm-pi-ai"));
    assert.ok(ids.includes("spill-policy"));
    assert.ok(ids.includes("<insert>"), "the scaffold's insert rows survive");
  } finally {
    rmSync(dshHome, { recursive: true, force: true });
  }
});
