#!/usr/bin/env node
// ── Dual credential for gateway-hosted per-user servers ──────────────────────
//
// A server whose upstream authenticates the END USER (wire/lex Logto ID tokens,
// facet device tokens) cannot be called through the MCP gateway: the gateway
// strips the caller's Authorization, and the designed alternative — the egress
// vault — needs a secret store this deployment does not have (OpenBao was never
// deployed outside a loopback-only dev container).
//
// `relayCallerCredential: true` on the server config switches that row to the
// dual-credential shape the gateway now supports (auth-server's
// INGRESS_RELAY_SERVERS forwards X-Authorization upstream):
//
//   Authorization:   Bearer <the identity's gateway token>   (caller -> gateway)
//   X-Authorization: Bearer <the server's own credential>    (gateway -> upstream)
//
// What this file pins:
//   1. a gateway URL + the flag produces both headers;
//   2. the flag is IGNORED for a direct (non-gateway) URL — that server's own
//      token stays in Authorization, byte-identical to before;
//   3. no gateway credential ⇒ the server is OMITTED (fail closed), never sent
//      with a foreign token in Authorization;
//   4. rows without the flag are untouched.
//
//   node --test scripts/test-dual-credential.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dual-cred-"));
process.env.DB_PATH = path.join(TMP, "platform.db");
process.env.PLATFORM_DATA_DIR = TMP;
process.env.DSH_HOME = path.join(TMP, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const db = await import("../db.js");
await db.initDb();
const creds = await import("../credential-refs.js");
const registry = await import("../registry-credentials.js");
const line = await import("../line-credentials.js");

const EMAIL = "owner@example.test";

function seed(email) {
  db.setRegistryCredential({
    email: registry.ownerKey(email),
    token: "gateway-token",
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  line.store({ email, line: "wire-customer", token: "line-token" });
}

test("gateway url + flag => gateway token in Authorization, server token in X-Authorization", () => {
  seed(EMAIL);
  const servers = {
    "wire-build-mcp": {
      url: "https://mcp.finddatatech.cloud/wire-build-mcp/mcp",
      credentialRef: "wire-customer",
      relayCallerCredential: true,
    },
  };
  const { servers: out, omitted } = creds.resolveCredentials(servers, EMAIL);
  assert.deepEqual(omitted, []);
  const h = out["wire-build-mcp"].headers;
  assert.equal(h.Authorization, "Bearer gateway-token");
  assert.equal(h["X-Authorization"], "Bearer line-token");
});

test("the flag is ignored for a direct url (unchanged single-credential shape)", () => {
  seed(EMAIL);
  const servers = {
    direct: {
      url: "http://cheap6.mesh.finddata.cn:31898/mcp",
      credentialRef: "wire-customer",
      relayCallerCredential: true,
    },
  };
  const { servers: out } = creds.resolveCredentials(servers, EMAIL);
  assert.equal(out.direct.headers.Authorization, "Bearer line-token");
  assert.equal(out.direct.headers["X-Authorization"], undefined);
});

test("no gateway credential => the server is omitted, never sent with a foreign token", () => {
  // line token present, gateway credential absent
  db.upsertLineCredential?.(EMAIL, "wire-customer", "line-token", null);
  const servers = {
    "wire-build-mcp": {
      url: "https://mcp.finddatatech.cloud/wire-build-mcp/mcp",
      credentialRef: "wire-customer",
      relayCallerCredential: true,
    },
  };
  const { servers: out } = creds.resolveCredentials(servers, "nobody@example.test");
  assert.equal(out["wire-build-mcp"], undefined);
});

test("a line ref on a DIRECT url keeps the single-token shape", () => {
  // The flag/ref only switches the shape when the gateway is in the path; a
  // direct upstream has no gateway to authenticate to, so the server's own
  // token must stay in Authorization (byte-identical to before).
  seed(EMAIL);
  const servers = {
    plain: {
      url: "http://cheap6.mesh.finddata.cn:31898/mcp",
      credentialRef: "wire-customer",
    },
  };
  const { servers: out } = creds.resolveCredentials(servers, EMAIL);
  assert.equal(out.plain.headers.Authorization, "Bearer line-token");
  assert.equal(out.plain.headers["X-Authorization"], undefined);
});

test("a line ref on a gateway url needs no flag — the ref decides", () => {
  seed(EMAIL);
  line.store({ email: EMAIL, line: "lex", token: "lex-token" });
  const servers = {
    "wire-build-mcp": {
      url: "https://mcp.finddatatech.cloud/wire-build-mcp/mcp",
      credentialRef: "wire-customer",
    },
    "lex-ops": {
      url: "https://mcp.finddatatech.cloud/lex-ops-mcp/mcp",
      credentialRef: "lex",
    },
  };
  const { servers: out } = creds.resolveCredentials(servers, EMAIL);
  for (const n of ["wire-build-mcp", "lex-ops"]) {
    assert.equal(
      out[n]?.headers?.["X-Authorization"] !== undefined,
      true,
      n + " should relay (line ref + gateway url)",
    );
  }
});

test("the registry ref keeps the single-token shape even on the gateway", () => {
  seed(EMAIL);
  const servers = {
    "fd-open-data-mcp": {
      url: "https://mcp.finddatatech.cloud/fd-open-data-mcp/mcp",
      credentialRef: "registry",
    },
  };
  const { servers: out } = creds.resolveCredentials(servers, EMAIL);
  assert.equal(out["fd-open-data-mcp"].headers.Authorization, "Bearer gateway-token");
  assert.equal(out["fd-open-data-mcp"].headers["X-Authorization"], undefined);
});

test("isGatewayUrl only matches the gateway host", () => {
  assert.equal(creds.isGatewayUrl("https://mcp.finddatatech.cloud/x/mcp"), true);
  assert.equal(creds.isGatewayUrl("http://cheap6.mesh.finddata.cn:31898/mcp"), false);
  assert.equal(creds.isGatewayUrl(""), false);
  assert.equal(creds.isGatewayUrl(undefined), false);
});

// ── Shared-token upstream (gateway-reach-for-shared-token-mcp) ──────────────
//
// law-bench-mcp authenticates every caller with ONE deployment token, so it is
// not a per-user credential — but it needs the same dual shape through the
// gateway: the gateway strips the caller's auth, and the upstream reads only
// its own token. Without this the call arrives anonymous and 401s.

test("shared-token ref on the gateway => gateway identity + deployment token", () => {
  seed(EMAIL);
  const servers = {
    "law-bench": {
      url: "https://mcp.finddatatech.cloud/law-bench/mcp",
      credentialRef: "law-bench-mcp",
    },
  };
  process.env.LAW_BENCH_MCP_TOKEN = "shared-law-bench-token";
  const { servers: out, omitted } = creds.resolveCredentials(servers, EMAIL);
  assert.deepEqual(omitted, []);
  assert.equal(out["law-bench"].headers.Authorization, "Bearer gateway-token");
  assert.equal(out["law-bench"].headers["X-Authorization"], "Bearer shared-law-bench-token");
  delete process.env.LAW_BENCH_MCP_TOKEN;
});

test("shared-token ref without the deployment token => server omitted (fail closed)", () => {
  seed(EMAIL);
  delete process.env.LAW_BENCH_MCP_TOKEN;
  const servers = {
    "law-bench": {
      url: "https://mcp.finddatatech.cloud/law-bench/mcp",
      credentialRef: "law-bench-mcp",
    },
  };
  const { servers: out, omitted } = creds.resolveCredentials(servers, EMAIL);
  assert.equal(out["law-bench"], undefined);
  assert.deepEqual(omitted.map((o) => o.names).flat(), ["law-bench"]);
});

test("shared-token ref decides the shape by ref alone — no per-server flag needed", () => {
  // The deployment token is not tied to an email, so installing the server should
  // not require a "connect law-bench" step: the ref itself is the switch. (A
  // brand-new identity still needs the *gateway* credential — that is the
  // ordinary per-user login, not a law-bench one.)
  assert.equal(
    creds.needsRelayedCallerCredential(
      { url: "https://mcp.finddatatech.cloud/law-bench/mcp" },
      "law-bench-mcp",
    ),
    true,
  );
  assert.equal(
    creds.needsRelayedCallerCredential(
      { url: "http://cheap6.mesh.finddata.cn:31898/mcp" },
      "law-bench-mcp",
    ),
    false,
  );
});
