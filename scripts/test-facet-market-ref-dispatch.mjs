// Unit tests — pack-store credential-ref dispatch (add-facet-market-credentials D4).
// Run: node --test scripts/test-facet-market-ref-dispatch.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Isolation env BEFORE importing anything that binds the db.
const tmpRoot = mkdtempSync(path.join(tmpdir(), "fm-ref-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");

const db = await import("../db.js");
await db.initDb();
const { credentialRefForEntry, credentialConnected, credentialMissingReason, connectPathForRef } = await import("../pack-store.js");
const fm = await import("../facet-market-credentials.js");
const lineCredentials = await import("../line-credentials.js");

test.after(() => rmSync(tmpRoot, { recursive: true, force: true }));

const EMAIL = "dispatcher@test.example";

test("absent declaration defaults to the registry credential", () => {
  assert.equal(credentialRefForEntry({ credentialRef: null }), "registry");
  assert.equal(credentialRefForEntry({}), "registry");
  assert.equal(credentialRefForEntry(null), "registry");
});

test("a declaring entry carries its line's ref", () => {
  assert.equal(credentialRefForEntry({ credentialRef: "facet-market" }), "facet-market");
});

test("facet-market requires pairing (not registry connection)", () => {
  // unpaired: facet-market disconnected even though the check is ref-aware
  assert.equal(credentialConnected("facet-market", EMAIL), false);
});

test("paired facet-market counts as connected", async () => {
  const fetchImpl = async () => ({
    status: 200, ok: true,
    json: async () => ({
      ok: true,
      token: "h.c.s", // placeholder shape — pair only stores the cache
      email: "facet-user@test.example",
    }),
  });
  // Note: pair parses exp from the token's payload; a malformed one yields
  // null expiry, which still counts as connected (stale=false).
  const status = await fm.pair(EMAIL, "998877", { fetchImpl });
  assert.equal(status.connected, true);
  assert.equal(credentialConnected("facet-market", EMAIL), true);
  // registry credential remains a separate check (not connected here)
  assert.equal(credentialConnected("registry", EMAIL), false);
});

// ── Line refs are judged by their own credential, never the registry's
// (fix-wire-install-gate: the fall-through refused wire-line installs for
// customers whose registry was never connected, with a misleading "connect
// the MCP market first" reason). ────────────────────────────────────────────

test("wire-customer: connected by its own line credential, not the registry's", () => {
  const email = "wire-lane@test.example";
  // No credential of any kind: refused, and the reason names the wire line.
  assert.equal(credentialConnected("wire-customer", email), false);
  assert.match(credentialMissingReason("wire-customer"), /wire line/i);
  assert.equal(connectPathForRef("wire-customer"), "/settings/connections?panel=line-wire-customer");

  // A live wire-customer credential alone (registry stays unconnected) passes.
  const st = lineCredentials.store({ email, line: "wire-customer", token: "wtok" });
  assert.equal(st.connected, true);
  assert.equal(credentialConnected("wire-customer", email), true);
  assert.equal(credentialConnected("registry", email), false);

  // Disconnect flips the gate back off.
  lineCredentials.disconnect(email, "wire-customer");
  assert.equal(credentialConnected("wire-customer", email), false);
});

test("lex: same shape as wire-customer", () => {
  const email = "lex-lane@test.example";
  assert.equal(credentialConnected("lex", email), false);
  assert.match(credentialMissingReason("lex"), /lex line/i);
  assert.equal(connectPathForRef("lex"), "/settings/connections?panel=line-lex");
  assert.equal(lineCredentials.store({ email, line: "lex", token: "ltok" }).connected, true);
  assert.equal(credentialConnected("lex", email), true);
  lineCredentials.disconnect(email, "lex");
  assert.equal(credentialConnected("lex", email), false);
});

test("wanxing-caller: judged by its own resolver (pasted key fallback)", () => {
  const email = "wx-lane@test.example";
  assert.equal(credentialConnected("wanxing-caller", email), false);
  assert.match(credentialMissingReason("wanxing-caller"), /caller key/i);
  // The pasted-key fallback is the ciyuan resolver's second leg; a row there
  // flips the gate without any ciyuan account binding.
  lineCredentials.store({ email, line: "wanxing-caller", token: "sk-test" });
  assert.equal(credentialConnected("wanxing-caller", email), true);
  lineCredentials.disconnect(email, "wanxing-caller");
  assert.equal(credentialConnected("wanxing-caller", email), false);
});

test("registry credential satisfies the registry gate but not the line gates", async () => {
  const email = "cross-lane@test.example";
  const rc = await import("../registry-credentials.js");
  rc.store({ email, token: "wgk-test" });
  assert.equal(credentialConnected("registry", email), true);
  assert.equal(credentialConnected("wire-customer", email), false);
  assert.equal(credentialConnected("lex", email), false);
});

test("legacy refs keep their exact refusal reasons (zero change)", () => {
  assert.equal(
    credentialMissingReason("registry"),
    "connect the MCP market first — no live registry credential",
  );
  assert.equal(
    credentialMissingReason("facet-market"),
    "pair the facet market first — no live market credential",
  );
  assert.equal(
    credentialMissingReason("paper-trading"),
    "connect the paper-trading service first — no live paper-trading credential",
  );
});
