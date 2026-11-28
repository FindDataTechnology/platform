// Table-driven test for lib/config-apply.js (openspec: runtime-config-hot-apply, tasks 1.2).
//
// Every (dimension × declared-capability) cell is pinned so the ladder cannot
// drift silently: a live surface present ⇒ live; absent ⇒ the named restart;
// restart-only dimensions ignore capabilities; an unknown dimension restarts and
// says so instead of throwing.
//
// Run: node --test lib/config-apply.test.js

import assert from "node:assert/strict";
import { test } from "node:test";

const { decide, isLive, capabilitiesFor, LIVE_SURFACES, REASONS } = await import("./config-apply.js");

const ALL_LIVE = ["model/set", "preset/set", "persona-parkable", "tools/set", "plugins/set_enabled", "mcp-hotswap"];
const NONE = [];

test("模型/思考深度：有 model/set 走 live，无则命名重启", () => {
  assert.deepEqual(decide({ dimension: "model", capabilities: ["model/set"] }),
    { surface: LIVE_SURFACES.model, reason: REASONS.capabilityDeclared, live: true });
  assert.deepEqual(decide({ dimension: "effort", capabilities: ["model/set"] }),
    { surface: LIVE_SURFACES.model, reason: REASONS.capabilityDeclared, live: true });
  assert.deepEqual(decide({ dimension: "model", capabilities: NONE }),
    { surface: "restart:model", reason: REASONS.capabilityAbsent, live: false });
  assert.deepEqual(decide({ dimension: "effort", capabilities: NONE }),
    { surface: "restart:effort", reason: REASONS.capabilityAbsent, live: false });
});

test("人格/preset：仅在 persona-parkable（完整能力面可每会话组合）时停靠，否则命名重启", () => {
  // The cell declares `preset/set` (cron/delegation parks) but NOT
  // `persona-parkable` — a chat persona parked there inherits the boot persona's
  // skills (process-level patch), so it must restart, named.
  assert.deepEqual(decide({ dimension: "preset", capabilities: ["preset/set", "persona-parkable"] }),
    { surface: LIVE_SURFACES.preset, reason: REASONS.capabilityDeclared, live: true });
  assert.deepEqual(decide({ dimension: "preset", capabilities: ["preset/set"] }),
    { surface: "restart:preset", reason: REASONS.capabilityAbsent, live: false });
  assert.deepEqual(decide({ dimension: "preset", capabilities: NONE }),
    { surface: "restart:preset", reason: REASONS.capabilityAbsent, live: false });
});

test("MCP 集合变更：有 mcp-hotswap 走 live 热换，否则命名重启", () => {
  assert.deepEqual(decide({ dimension: "mcp-composition", capabilities: ["mcp-hotswap"] }),
    { surface: LIVE_SURFACES.mcpHotswap, reason: REASONS.capabilityDeclared, live: true });
  assert.deepEqual(decide({ dimension: "mcp-composition", capabilities: NONE }),
    { surface: "restart:mcp-composition", reason: REASONS.capabilityAbsent, live: false });
});

test("MCP 凭据值变更：HMR 不传 header 值 ⇒ 恒命名重启（有 hotswap 也重启）", () => {
  assert.deepEqual(decide({ dimension: "mcp-credential", capabilities: ALL_LIVE }),
    { surface: "restart:mcp-credential", reason: REASONS.restartOnly, live: false });
});

test("MCP 会话闸（已组合 server 的可用性）：有 tools/set 走 live", () => {
  assert.deepEqual(decide({ dimension: "mcp-availability", capabilities: ["tools/set"] }),
    { surface: LIVE_SURFACES.tools, reason: REASONS.capabilityDeclared, live: true });
  assert.deepEqual(decide({ dimension: "mcp-availability", capabilities: NONE }),
    { surface: "restart:mcp-availability", reason: REASONS.capabilityAbsent, live: false });
});

test("插件 bundle 层：有 plugins/set_enabled 走 live", () => {
  assert.deepEqual(decide({ dimension: "plugins", capabilities: ["plugins/set_enabled"] }),
    { surface: LIVE_SURFACES.plugins, reason: REASONS.capabilityDeclared, live: true });
  assert.deepEqual(decide({ dimension: "plugins", capabilities: NONE }),
    { surface: "restart:plugins", reason: REASONS.capabilityAbsent, live: false });
});

test("工作区 cwd：结构上恒重启（无 per-session cwd）", () => {
  assert.deepEqual(decide({ dimension: "workspace", capabilities: ALL_LIVE }),
    { surface: "restart:cwd", reason: REASONS.restartOnly, live: false });
});

test("skills：未验证热换 ⇒ 保守命名重启", () => {
  assert.deepEqual(decide({ dimension: "skills", capabilities: ALL_LIVE }),
    { surface: "restart:skills", reason: REASONS.restartOnly, live: false });
});

test("未知 dimension：不抛，命名重启并标 unknown", () => {
  assert.deepEqual(decide({ dimension: "quantum", capabilities: ALL_LIVE }),
    { surface: "restart:quantum", reason: REASONS.unknown, live: false });
  assert.deepEqual(decide({ capabilities: ALL_LIVE }),
    { surface: "restart:unknown", reason: REASONS.unknown, live: false });
});

test("capabilities 可传对象（name→truthy），空/坏形状视为未声明", () => {
  assert.equal(decide({ dimension: "preset", capabilities: { "persona-parkable": true } }).live, true);
  assert.equal(decide({ dimension: "preset", capabilities: { "persona-parkable": false } }).live, false);
  assert.equal(decide({ dimension: "preset", capabilities: { "preset/set": true } }).live, false);
  assert.equal(decide({ dimension: "preset", capabilities: null }).live, false);
  assert.equal(decide({ dimension: "preset", capabilities: "nonsense" }).live, false);
});

test("isLive 只认 live: 前缀", () => {
  assert.equal(isLive("live:model/set"), true);
  assert.equal(isLive("restart:cwd"), false);
  assert.equal(isLive(undefined), false);
});

test("capabilitiesFor：从 bridge 探测声明，persona-parkable/mcp-hotswap 是宿主属性且默认关", () => {
  const bridge = { hasLiveMethod: (m) => ["model/set", "preset/set", "tools/set"].includes(m) };
  // The cell: bridge declares preset/set, but the host adds neither host-level
  // capability → persona and MCP composition both restart, named.
  assert.deepEqual(capabilitiesFor(bridge), ["model/set", "preset/set", "tools/set"]);
  assert.equal(decide({ dimension: "preset", capabilities: capabilitiesFor(bridge) }).surface, "restart:preset");
  assert.equal(decide({ dimension: "mcp-composition", capabilities: capabilitiesFor(bridge) }).surface, "restart:mcp-composition");
  // Host declarations flip the ladder.
  assert.equal(decide({ dimension: "preset", capabilities: capabilitiesFor(bridge, { personaParkable: true }) }).live, true);
  assert.equal(decide({ dimension: "mcp-composition", capabilities: capabilitiesFor(bridge, { mcpHotswap: true }) }).live, true);
  // No bridge at all → nothing declared.
  assert.deepEqual(capabilitiesFor(null), []);
});
