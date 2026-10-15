// Host-side scoped-credential injection + patch file permissions
// (add-mcp-credential-hygiene §2).
//
// Drives the REAL writeMcpPatch against a temp DSH_HOME (paths resolve at
// import time, so env is set before the dynamic import — the established
// dsh-profile test pattern):
//   - a stdio server with envRefs [SEARCH_RELAY_TOKEN] written under
//     SEARCH_RELAY_SCOPED_MASTER must land the PER-CELL derived value in the
//     patch env, not the shared process.env value;
//   - without the master env the shared value lands (migration fallback);
//   - the patch file itself must be mode 0600, fresh AND over a legacy 0644.
//
// Run: node scripts/test-scoped-relay-host.mjs

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync, chmodSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";

const tmp = mkdtempSync(join(tmpdir(), "scoped-host-test-"));
process.env.DSH_HOME = join(tmp, "dsh-home");
process.env.MCP_CONFIG_PATH = join(tmp, "mcp.json");
// Keep the composition minimal: no DB, no preset focus — mcp.json only.
writeFileSync(
  process.env.MCP_CONFIG_PATH,
  JSON.stringify({
    mcpServers: {
      websearch: {
        command: "node",
        args: ["server/websearch-mcp.js"],
        envRefs: ["SEARCH_RELAY_TOKEN"],
      },
    },
  }),
);

const { scopeIdForEmail, deriveScopedToken } = await import("../lib/scoped-relay-token.js");
const { writeMcpPatch } = await import("../dsh-profile.js");
const PATCH = join(process.env.DSH_HOME, "profiles", "platform", "mcp.patch.yml");

function patchEnv() {
  const doc = yaml.load(readFileSync(PATCH, "utf8"));
  const entry = doc[0].insert.find((e) => e.config.serverName === "websearch");
  return entry.config.env ?? {};
}

test("scopeIdForEmail: stable, deterministic, PII-free shape", () => {
  const a = scopeIdForEmail("User@Example.com ");
  assert.match(a, /^cell-[0-9a-f]{12}$/);
  assert.equal(a, scopeIdForEmail("user@example.com"), "case/whitespace-insensitive");
  assert.notEqual(a, scopeIdForEmail("other@example.com"));
});

test("with SCOPED_MASTER: patch carries the per-cell derived token, not the shared one", async () => {
  process.env.SEARCH_RELAY_TOKEN = "shared-secret-do-not-leak";
  process.env.SEARCH_RELAY_SCOPED_MASTER = "host-unit-master";
  try {
    await writeMcpPatch({ ownerEmail: "demo@findmail.com" });
    const env = patchEnv();
    assert.match(env.SEARCH_RELAY_TOKEN, /^wsrc-cell-[0-9a-f]{12}-[0-9a-f]{24}$/);
    assert.equal(env.SEARCH_RELAY_TOKEN, deriveScopedToken("host-unit-master", scopeIdForEmail("demo@findmail.com")));
    assert.ok(!env.SEARCH_RELAY_TOKEN.includes("shared-secret"), "shared platform token must not ride along");
  } finally {
    delete process.env.SEARCH_RELAY_SCOPED_MASTER;
  }
});

test("explicit SEARCH_RELAY_SCOPE_ID wins over the email-derived scope", async () => {
  process.env.SEARCH_RELAY_SCOPED_MASTER = "host-unit-master";
  process.env.SEARCH_RELAY_SCOPE_ID = "custom-scope-1";
  try {
    await writeMcpPatch({ ownerEmail: "demo@findmail.com" });
    assert.equal(patchEnv().SEARCH_RELAY_TOKEN, deriveScopedToken("host-unit-master", "custom-scope-1"));
  } finally {
    delete process.env.SEARCH_RELAY_SCOPED_MASTER;
    delete process.env.SEARCH_RELAY_SCOPE_ID;
  }
});

test("without SCOPED_MASTER: shared value lands (migration fallback)", async () => {
  process.env.SEARCH_RELAY_TOKEN = "shared-secret-do-not-leak";
  await writeMcpPatch({ ownerEmail: "demo@findmail.com" });
  assert.equal(patchEnv().SEARCH_RELAY_TOKEN, "shared-secret-do-not-leak");
});

test("patch file mode is 0600 — fresh write AND over a legacy 0644", async () => {
  await writeMcpPatch({ ownerEmail: "demo@findmail.com" });
  assert.equal(statSync(PATCH).mode & 0o777, 0o600, "fresh patch must be owner-only");
  chmodSync(PATCH, 0o644); // simulate a pre-change patch
  await writeMcpPatch({ ownerEmail: "demo@findmail.com" });
  assert.equal(statSync(PATCH).mode & 0o777, 0o600, "rewrite must tighten a legacy 0644 patch");
});

test.after(() => {
  rmSync(tmp, { recursive: true, force: true });
});
