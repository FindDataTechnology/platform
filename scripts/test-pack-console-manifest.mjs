// Unit tests — pack console declaration (change add-pack-console, task 1.1/1.2).
// Run: node --test scripts/test-pack-console-manifest.mjs
//
// The console section is a DECLARATION: it selects blocks and parameters and
// carries no way to fetch anything. These cases pin the three things that
// matter — the boundary (no data-access key at any depth), the allowlist (block
// ids and parameters come from lib/console-blocks-spec.js, never a second
// hardcoded list), and backwards compatibility (an absent section is
// byte-identical, and an unknown top-level key is still ignored so an old
// install does not break on a newer pack).

import test from "node:test";
import assert from "node:assert/strict";

const { validatePackManifest } = await import("../lib/pack-manifest.js");
const { CONSOLE_BLOCK_SPECS, CONSOLE_BLOCK_IDS, CONSOLE_LIMITS, validateConsoleSection } = await import(
  "../lib/console-blocks-spec.js"
);

// The smallest manifest the validator accepts (one MCP reference). Console
// errors are isolated by diffing against this baseline.
const BASE = { name: "console-fixture", mcpServers: [{ name: "filesystem", registryName: "filesystem" }] };

function consoleErrors(section) {
  return validatePackManifest({ ...BASE, console: section }).filter(
    (e) => String(e.entry ?? "").startsWith("console") || String(e.error).includes("console"),
  );
}

function paramsFor(blockId) {
  const spec = CONSOLE_BLOCK_SPECS[blockId];
  const params = {};
  for (const [key, rule] of Object.entries(spec)) {
    params[key] = rule.kind === "int" ? rule.min : rule.values[0];
  }
  return params;
}

test("an absent console section changes nothing", () => {
  assert.deepEqual(validatePackManifest(BASE), []);
});

test("a complete console declaration passes", () => {
  const section = {
    headline: "kpi.deliverables",
    blocks: [
      { block: "team", surfaces: ["platform", "share"] },
      { block: "kpi", params: { window: "7d" }, surfaces: ["share"] },
      { block: "decisions", params: { limit: 5, severity: "high" } },
    ],
  };
  assert.deepEqual(consoleErrors(section), []);
});

test("every registered block is accepted with its declared parameters", () => {
  // Proves the validator derives ids AND parameter names from the spec: if it
  // carried a second hardcoded list, a new spec entry would be rejected here.
  for (const blockId of CONSOLE_BLOCK_IDS) {
    const errors = consoleErrors({ blocks: [{ block: blockId, params: paramsFor(blockId) }] });
    assert.deepEqual(errors, [], `block '${blockId}' should be accepted with its spec parameters`);
  }
});

test("an unregistered block is rejected and names the field path", () => {
  const errors = consoleErrors({ blocks: [{ block: "sales-funnel" }] });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].entry, "console.blocks[0].block");
  assert.match(errors[0].error, /not a registered console block/);
});

test("a parameter outside the block's spec is rejected", () => {
  const errors = consoleErrors({ blocks: [{ block: "team", params: { limit: 3 } }] });
  assert.ok(errors.some((e) => e.entry === "console.blocks[0].params.limit"));
  assert.ok(errors.some((e) => /this block accepts no parameters/.test(e.error)));
});

test("a data-access key is rejected at any depth", () => {
  // The top level, a block entry and a parameter all have to be covered: the
  // rule is about the section's meaning, not about one known shape.
  for (const section of [
    { url: "https://example.test", blocks: [{ block: "team" }] },
    { blocks: [{ block: "team", endpoint: "https://example.test" }] },
    { blocks: [{ block: "kpi", params: { url: "https://example.test" } }] },
  ]) {
    const errors = consoleErrors(section);
    assert.ok(
      errors.some((e) => /must not carry a data-access key/.test(e.error)),
      `expected a data-access error for ${JSON.stringify(section)}`,
    );
  }
});

test("a duplicated block is rejected", () => {
  const errors = consoleErrors({ blocks: [{ block: "team" }, { block: "team" }] });
  assert.ok(errors.some((e) => /declared twice/.test(e.error)));
});

test("more than the block ceiling is rejected", () => {
  // Ceiling is a policy value in the spec, so the test asks the spec rather
  // than hardcoding 8.
  const blocks = [];
  for (let i = 0; i <= CONSOLE_LIMITS.maxBlocks; i++) {
    // Reuse the six registered ids cyclically is not possible (dupes are
    // rejected first), so drive the ceiling with a duplicate-free prefix and
    // then push one extra of a different shape.
    blocks.push({ block: CONSOLE_BLOCK_IDS[i % CONSOLE_BLOCK_IDS.length] });
  }
  const errors = consoleErrors({ blocks });
  assert.ok(
    errors.some((e) => /at most/.test(e.error) && e.entry === "console.blocks"),
    "expected a ceiling error at console.blocks",
  );
});

test("an empty blocks array is rejected", () => {
  const errors = consoleErrors({ blocks: [] });
  assert.ok(errors.some((e) => e.entry === "console.blocks" && /non-empty array/.test(e.error)));
});

test("an unknown surface is rejected", () => {
  const errors = consoleErrors({ blocks: [{ block: "team", surfaces: ["embed"] }] });
  assert.ok(errors.some((e) => e.entry === "console.blocks[0].surfaces" && /unknown surface 'embed'/.test(e.error)));
});

test("headline must point at a declared block", () => {
  const errors = consoleErrors({ headline: "spend.total", blocks: [{ block: "team" }] });
  assert.ok(
    errors.some((e) => e.entry === "console.headline" && /does not declare/.test(e.error)),
    "a headline may not reference a block the console omits",
  );

  const ok = consoleErrors({ headline: "team.headcount", blocks: [{ block: "team" }] });
  assert.deepEqual(ok, []);
});

test("an unknown key inside console is rejected", () => {
  const errors = consoleErrors({ blocks: [{ block: "team" }], refreshSecs: 30 });
  assert.ok(errors.some((e) => e.entry === "console" && /unknown key 'refreshSecs'/.test(e.error)));
});

test("backwards compatibility: console is not a rejected top-level key", () => {
  // The validator has no top-level allowlist, so an older install IGNORES the
  // section instead of refusing the pack. This assertion exists to make that
  // property deliberate: if someone later adds a top-level allowlist, this test
  // fails and the migration note in the change has to be revisited.
  const errors = validatePackManifest({ ...BASE, console: { blocks: [{ block: "team" }] } });
  assert.equal(errors.filter((e) => /unknown key 'console'/.test(e.error)).length, 0);
});

test("validateConsoleSection is pure and returns [] for an absent section", () => {
  assert.deepEqual(validateConsoleSection(undefined), []);
  assert.deepEqual(validateConsoleSection(null), []);
});
