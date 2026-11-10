// scripts/test-connect-guidance-scope.mjs — add-connector-bindings 6.3
//
// The failure classifier must keep three cases apart, and never attach both
// pointers to one event:
//
//   范围不足    action_not_allowed / connection_not_allowed → scope pointer
//   真凭据失效  401 / unauthorized → credential pointer
//   无判定      anything else → no pointer at all
//
// The scope pointer carries the failing action id (from the payload) and, when
// the caller supplied a scope-explain answer, the (provider, operationType)
// pair. The classifier itself never invents those two — the connector's
// rejection payload does not carry them (open-connector-mt src/mcp.ts
// errorPayload: `{ok:false,error:{code,message}}`).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A baseline mcp.json with one connector row (the retired global ref) and one
// registry row — the two credential refs a tool call can resolve to.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-scope-"));
const mcpPath = path.join(dir, "mcp.json");
fs.writeFileSync(
  mcpPath,
  JSON.stringify({
    mcpServers: {
      // The retired single-token ref: no panel of its own (KNOWN_CONNECT_PANELS
      // never listed it), so a credential failure on it falls back to registry —
      // pre-existing behaviour this change does not re-open.
      connector: { url: "https://connector.example/mcp", credentialRef: "connector" },
      // What dsh-profile actually injects after D4: one row per binding.
      "connector:A:kingdee": {
        url: "https://connector.example/mcp",
        credentialRef: "connector-binding",
        slot: "pack-a:kingdee",
      },
      "fd-open-data": { url: "https://data.example/mcp", credentialRef: "registry" },
      "no-cred": { url: "https://public.example/mcp" },
    },
  }),
);
process.env.MCP_CONFIG_PATH = mcpPath;

const { toolFailureHint } = await import("../server/connect-guidance.js");

// The exact payload shape the connector returns for a scope rejection.
function scopePayload(code, actionId) {
  return JSON.stringify(
    { ok: false, error: { code, message: `${actionId} is not included in the local action allowlist.` } },
    null,
    2,
  );
}

test("范围不足：action_not_allowed 挂 scope 指针，不挂凭据指针 (6.3)", () => {
  const hint = toolFailureHint(
    "mcp__connector:A:kingdee__execute_action",
    scopePayload("action_not_allowed", "kingdee.invoice.create"),
  );
  assert.ok(hint, "a scope rejection must classify");
  assert.equal(hint.kind, "scope");
  assert.equal(hint.panel, "connector-bindings");
  assert.equal(hint.scope.actionId, "kingdee.invoice.create");
  // No catalog answer was supplied: the fields stay null instead of guessing.
  assert.equal(hint.scope.provider, null);
  assert.equal(hint.scope.operationType, null);
  // Mutual exclusion: a credential pointer must not ride the same event.
  assert.ok(!("credential" in hint) && hint.kind !== "credential");
});

test("范围不足：connection_not_allowed 同类，actionId 缺失也不猜", () => {
  const hint = toolFailureHint(
    "mcp__connector:B:wms__list_connections",
    JSON.stringify({ ok: false, error: { code: "connection_not_allowed", message: "connection is outside the granted scope" } }),
  );
  assert.equal(hint.kind, "scope");
  assert.equal(hint.scope.actionId, null);
  assert.equal(hint.scope.provider, null);
});

test("范围不足：调用方给过 scope-explain 答案时补 provider + 读/写", () => {
  const hint = toolFailureHint(
    "mcp__connector:A:kingdee__execute_action",
    scopePayload("action_not_allowed", "kingdee.invoice.create"),
    { scope: { provider: "kingdee", operationType: "write" } },
  );
  assert.deepEqual(hint.scope, { actionId: "kingdee.invoice.create", provider: "kingdee", operationType: "write" });
});

test("_blocked 是部署策略不是可授权范围：不给授权指针 (6.3 边界)", () => {
  const hint = toolFailureHint(
    "mcp__connector:A:kingdee__execute_action",
    JSON.stringify({ ok: false, error: { code: "action_blocked", message: "blocked by deployment policy" } }),
  );
  assert.equal(hint, null, "no user action can lift a deployment block — pointing at a grant card would lie");
});

test("真凭据失效仍走凭据分类，不误报为范围不足 (6.3)", () => {
  const hint = toolFailureHint("mcp__connector:A:kingdee__execute_action", "401 Unauthorized: invalid token");
  assert.ok(hint);
  assert.equal(hint.panel, "connector-bindings");
  assert.ok(!("kind" in hint), "credential classification stays the legacy shape");
  assert.ok(!("scope" in hint), "no scope pointer on a credential failure");
});

test("registry 行 401 仍指 registry 面板（既有行为不回归）", () => {
  const hint = toolFailureHint("mcp__fd-open-data__search", "401 Unauthorized");
  assert.deepEqual(hint, { panel: "registry" });
});

test("无判定：网络超时/普通错误不挂任何指针", () => {
  assert.equal(toolFailureHint("mcp__connector:A:kingdee__execute_action", "ETIMEDOUT after 30s"), null);
  assert.equal(toolFailureHint("mcp__no-cred__ping", "401 Unauthorized"), null, "a server without a ref has nothing to connect");
  assert.equal(toolFailureHint("not-a-tool-name", "401 Unauthorized"), null);
});

test("两类指针互斥：同一事件只有一种分类", () => {
  for (const text of [scopePayload("action_not_allowed", "x.y.z"), "401 Unauthorized", "ETIMEDOUT"]) {
    const hint = toolFailureHint("mcp__connector:A:kingdee__execute_action", text);
    if (!hint) continue;
    const hasScope = hint.kind === "scope";
    const hasCredential = !hasScope && typeof hint.panel === "string";
    assert.ok(hasScope || hasCredential, "every hint is exactly one class");
    assert.ok(!(hasScope && "kind" in hint && hint.kind === "credential"));
  }
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
