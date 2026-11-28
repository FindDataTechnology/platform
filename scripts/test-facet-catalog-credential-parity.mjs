// Unit tests — market-source credential parity on the extensions route
// (fix-facet-catalog-credential-parity).
//
// The bug this pins: `/api/extensions/mcp` decided "is this a market entry?" by
// `entry?.origin === "registry"`. Every entry in the facet projection carries
// `origin: "facet-catalog"`, so those installs fell through to the plaintext
// branch and stored the operator's pasted Authorization verbatim (measured
// 2026-11-22: a `mcp-registry-admin` JWT readable back through the same API).
//
// Two things must hold, and they are tested at the level they live:
//   1. the predicate — `isMarketInstallableEntry` must accept BOTH channels;
//   2. the read face — `redactMcpCredential` must mask inline headers and
//      label the shape, without rewriting the stored row.
//
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { isMarketInstallableEntry } from "../registry-bridge.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── 1. The predicate: both channels are market entries ────────────────────────

test("isMarketInstallableEntry accepts the legacy registry feed", () => {
  assert.equal(isMarketInstallableEntry({ origin: "registry" }), true);
});

test("isMarketInstallableEntry accepts the facet projection", () => {
  // The regression: this used to be judged by hand as NOT a market entry.
  assert.equal(isMarketInstallableEntry({ origin: "facet-catalog" }), true);
});

test("isMarketInstallableEntry rejects non-market origins", () => {
  for (const origin of ["bundled", "local", "", null, undefined]) {
    assert.equal(isMarketInstallableEntry({ origin }), false, `origin=${origin}`);
  }
  assert.equal(isMarketInstallableEntry(null), false);
});

// ── 2. The route must use the shared predicate, not a hand-rolled comparison ──

test("extensions route routes market installs through the credential branch", () => {
  const src = readFileSync(join(ROOT, "server/routes/extensions.js"), "utf8");
  assert.match(
    src,
    /if \(isMarketInstallableEntry\(entry\)\)/,
    "the install route must judge market membership with the shared predicate",
  );
  assert.doesNotMatch(
    src,
    /entry\?\.origin === "registry"/,
    "the hand-rolled single-channel check is the bug — it must not come back",
  );
});

test("extensions route refuses with credential-required instead of storing a placeholder", () => {
  const src = readFileSync(join(ROOT, "server/routes/extensions.js"), "utf8");
  // The refusal shape the UI already renders (same as the pack install path).
  assert.match(src, /code: "credential-required"/);
  // And the template's placeholder headers must be dropped, not persisted.
  assert.match(src, /headers: _placeholderHeaders/);
});

// ── 3. Read-face redaction ────────────────────────────────────────────────────
//
// `redactMcpCredential` is module-private (it is a presentation rule, not an API).
// Lift it by source for the test: the route file is buildless plain JS, so a
// narrow eval of the helper keeps the test honest without exporting internals.

function loadRedactor() {
  const src = readFileSync(join(ROOT, "server/routes/extensions.js"), "utf8");
  const start = src.indexOf("const AUTH_HEADER_KEYS");
  const end = src.indexOf("\n}\n", src.indexOf("function redactMcpCredential")) + 3;
  assert.ok(start > -1 && end > start, "redaction helper not found in the route file");
  const body = src.slice(start, end);
  // eslint-disable-next-line no-new-func
  return new Function(`${body}; return redactMcpCredential;`)();
}

test("inline Authorization is masked on the read face", () => {
  const redact = loadRedactor();
  const out = redact({
    name: "fd-quant",
    config: { url: "https://x/mcp", headers: { Authorization: "Bearer eyJhbGciOi.SECRET" } },
  });
  assert.equal(out.config.headers.Authorization, "Bearer …");
  assert.ok(!JSON.stringify(out).includes("SECRET"), "no token bytes may survive redaction");
  assert.equal(out.credentialShape, "inline");
});

test("header casing does not defeat the mask", () => {
  const redact = loadRedactor();
  for (const key of ["authorization", "AUTHORIZATION", "X-Authorization"]) {
    const out = redact({ name: "x", config: { headers: { [key]: "Bearer secret" } } });
    assert.equal(out.config.headers[key], "Bearer …", `key=${key}`);
  }
});

test("configJson is dropped — it is the same row in raw form", () => {
  // The e2e probe caught this: masking `config` alone left the token verbatim
  // in the sibling `configJson` column. It is not in the wire type and no
  // client reads it, so the read face drops it outright.
  const redact = loadRedactor();
  const row = {
    name: "legacy",
    config: { url: "https://x.test/mcp", headers: { Authorization: "Bearer eyJhbGci.SECRET" } },
    configJson: JSON.stringify({ url: "https://x.test/mcp", headers: { Authorization: "Bearer eyJhbGci.SECRET" } }),
  };
  const out = redact(row);
  assert.equal(out.configJson, undefined, "configJson must not survive the read face");
  assert.equal(out.config.headers.Authorization, "Bearer …");
  assert.ok(!JSON.stringify(out).includes("SECRET"), "no token bytes may survive redaction");
  // Everything else on the row is preserved.
  assert.equal(out.config.url, "https://x.test/mcp");
  assert.equal(out.name, "legacy");
});

test("reference-shaped rows are labelled and left untouched", () => {
  const redact = loadRedactor();
  const row = { name: "fd-zhengxin", config: { url: "https://x/mcp", credentialRef: "registry" } };
  const out = redact(row);
  assert.equal(out.credentialShape, "ref");
  assert.deepEqual(out.config, row.config);
});

test("rows with neither shape say so", () => {
  const redact = loadRedactor();
  const out = redact({ name: "actions", config: { command: "node", args: ["server.js"] } });
  assert.equal(out.credentialShape, "none");
});

test("a row without config passes through unchanged", () => {
  const redact = loadRedactor();
  const row = { name: "weird" };
  assert.deepEqual(redact(row), row);
});
