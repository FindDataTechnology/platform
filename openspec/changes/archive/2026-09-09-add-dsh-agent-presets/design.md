# Design — add-dsh-agent-presets

## Context

dsh's preset machinery splits across two packages:

- `@deepseek-ai/dsh-agent-presets` — the roster service (`ctx.agentPresets`):
  discovery (`list`/`resolve`), the standing-mount `mount(agentCtx, id)`,
  settings namespace `agent-presets` (`default`), shipped roots +
  `<dshHome>/.agent-presets` user root.
- `@deepseek-ai/dsh-host-apiproxy` — the ONLY stock caller of `mount()`; it
  owns the `agentPreset.*` RPCs and its own session/model/history stack.

The platform uses neither the apiproxy nor the roster: its profile bundles
`dsh-base` + one `sdk-jsonrpc-server` row, and
`@deepseek-ai/dsh-sdk-jsonrpc-server` contains no preset handling. Migrating to
the apiproxy would mean re-adopting its sessions/models/history/fork/export
stack — a migration the size of `migrate-pi-to-dsh` — for one feature.

## D1 — A local bridge plugin subclasses the SDK JSON-RPC server

The SDK server exports the `HarnessSdkJsonRpcServer` class as a named export.
The generated profile gets a third `--patch` overlay (same generator mechanism
as `mcp.patch.yml` / `skills.patch.yml`) inserting:

```yaml
- insert:
    - id: agent-presets
      name: '@deepseek-ai/dsh-agent-presets'
      config:
        default: standard
        roots:
          - path: <resolved shipped preset root>
            trust: system
    # Same row id as dsh-profile-template's cordis.patch.yml — later --patch
    # layers replace the whole row, so this subclassed server supersedes the
    # stock sdk-jsonrpc-server row.
    - id: sdk-jsonrpc-server
      name: ./platform-preset-bridge.js
```

The bridge file (authored in this repo, copied into the generated profile):

```js
import { HarnessSdkJsonRpcServer } from "@deepseek-ai/dsh-sdk-jsonrpc-server";

class PlatformSdkServer extends HarnessSdkJsonRpcServer {
  async initialize(params) {
    this.agentPresetId = params.agentPreset ?? null;
    return super.initialize(params);
  }
  async createSession(sessionId) {
    const rec = await super.createSession(sessionId); // guarded maps/locks stay in parent
    // mount() belongs in unpublished setup; the SDK server exposes no setup
    // hook, so the bridge mounts against the freshly created, still-blank agent
    // BEFORE session/prompt followup() can run (lazy creation is awaited in
    // prompt()). A failed mount disposes the agent and rethrows, so a broken
    // preset surfaces as a session-creation error rather than a half-composed
    // agent.
    ...
  }
  async handleRequest(method, params) {
    if (method === "presets/list") return this.ctx.get("agentPresets")?.list() ?? [];
    return super.handleRequest(method, params);
  }
}
```

**Implementation note (patch shape correction).** The patch engine
(`cordis-plugin-include` `applyEntryPatches`) does not support what the
original sketch assumed: a non-insert patch treats `name` as a MISMATCH GUARD
(never an override — the field is destructured out of the applied overrides),
and inserting a second row with the id `sdk-jsonrpc-server` fails the whole
boot with `duplicate loader entry id` (the loader's `update()` rejects
duplicate ids in the composed list). The shipped `presets.patch.yml` therefore
disables the stock row (`{ id: sdk-jsonrpc-server, disabled: true }`) and
inserts the bridge under a fresh row id `platform-sdk-server` — the loader
skips init for disabled rows, so the stock server never constructs. The dsh
CLI (rc.2) additionally auto-appends the shipped preset root as a `system`
root whenever an `agent-presets` row is composed, which redundantly agrees
with the root the generator writes. Also learned during implementation: the
SDK server plugin's `apply` hard-codes `new HarnessSdkJsonRpcServer(...)`, so
the bridge exports its own `apply` (copy of the stock wiring around
`PlatformSdkServer`) rather than relying on class subclassing alone; and
`dsh-sdk-protocol` is a PRIVATE dependency of `dsh-sdk-jsonrpc-server`, so the
bridge resolves the transport through the SDK server package's real location
(`createRequire(import.meta.resolve(...))`), since the profile node_modules
walk reaches the server package but not its private deps.

Two ways to call the roster were considered. The reference path is the
`CreateAgentOptions.setup(agentCtx)` hook (apiproxy's `composeAgent`): it runs
before publication and a rejection rolls creation back. The stock SDK server
passes no `setup`, so the bridge either (a) replaces `createSession` to call
`this.ctx.agents.create(...)` itself with a `setup` hook — duplicating ~8 lines
of the parent — or (b) mounts after `super.createSession()`. **Decision: (a)**,
duplicating the small `agents.create` call, because pre-publication failure
rollback is the documented contract and (b) publishes a session whose
capabilities are half-installed. The bridge overrides `createSession` (called
through `this.` by the parent's own `getOrCreateSession`, so the
creation-lock/cache machinery is reused unchanged).

The roster returns `AgentPreset { id, trust, path, broken? }`; display
`name`/`description` come from each preset's `preset.yml` (the roster parses
it; verify the exact JSON shape during implementation against
`dsh-agent-presets/lib/types/preset.d.ts` and adapt the bridge serializer).

## D2 — The shipped preset root must be resolved at profile-generation time

The four shipped presets live in the `dsh` CLI package's
`config/agent-presets/` (`standard`/`code`/`minimal`/`cordis`), not inside the
`dsh-agent-presets` plugin package. `dsh-profile.js` resolves the path when it
generates the patch (Node `createRequire(import.meta.url).resolve(
'@deepseek-ai/dsh/package.json')` against the profile's node_modules, then
`../config/agent-presets`) and writes the absolute path into the generated
config. If resolution fails the row is omitted with a warning: the roster is
then user-root only, which is the documented "deployment composes no presets"
posture rather than a boot failure (graceful degradation).

`includeUserRoot` stays at its default (`true`), so
`~/.dsh/.agent-presets` is scanned automatically — user-authored presets
appear in the picker with zero additional code.

## D3 — Selection rides `initialize` + restart; blank-session-only switching

Like model/workspace switches, there is no stock dsh RPC to change a running
session's preset. The selected id flows:

```
set_preset (WS)
  → persist preference "agent.preset" in the project DB prefs table
  → dshBridge.restart({ agentPreset: id })
  → fresh child initialize({ ..., agentPreset: id })
  → bridge mounts it when the next session is lazily created
  → broadcast current_preset
```

`dshBridge.restart` already accepts per-restart overrides (`provider`, `model`,
`cwd`, `mcpPatchPath`); `agentPreset` is another. The choice applies to the
**next** session only. Switching while a non-blank session is the current one
is handled in the UI exactly like dsh's own surfaces: the picker lives on the
welcome (blank) state; in an active session it renders as a read-only label.
The server additionally rejects `set_preset` while `isStreaming` (same guard as
`set_model`).

v1 sends the id on `initialize` (one mode for the freshly restarted child),
not per `session/prompt`. Rationale: after a restart the bridge creates exactly
one web session lazily; per-prompt routing would require SDK protocol
extensions the client package may strip. If multi-session-per-child mode
selection is wanted later, the bridge already owns `createSession` and can
read an extra `session/prompt` param then.

The default is `standard` (deployment composition config in the generated
patch), overridable by the persisted preference. We do NOT write the
`agent-presets.default` settings namespace in v1 — paas owns selection state
and restarts are how it takes effect; the settings namespace matters only to
in-process dsh clients, which paas is not.

## D4 — UI surfaces

```
ChatWelcome                    ChatHeader (active session)
+----------------------------+ +----------------------------------+
|  模型: DeepSeek Flash  v    | |  会话标题            [标准模式 v] |
|  模式: [标准模式 v]         | +----------------------------------+
|   ┌──────────────────────┐ |
|   │ 标准模式  (featured) │ |  picker = dropdown/popover,
|   │ PTC 模式             | |  roster rows: name + description,
|   │ 极简模式             | |  broken rows disabled with reason,
|   │ 创造模式             | |  user rows marked "自定义"
|   └──────────────────────┘ |
+----------------------------+
```

Names/descriptions: for the four shipped ids the web bundle owns localized
strings (the shipped `preset.yml` is zh-only; en needs its own bundle). For
unknown system and all user presets the roster's file-published name +
description render verbatim (the dsh web client's own rule).

Switching mode triggers a child restart → the existing `pendingConfig`
composer-blocking spinner already covers that window. After restart the user
is on the welcome state (a mode switch is a "next session" decision); the
existing session list remains and opening an old session resumes it under the
mode its header records — tracked in chat-history metadata (the preset id
returned at session creation; best-effort, blank = deployment default).

## D5 — WS contract additions

| Direction | Message | Payload |
|---|---|---|
| server→client | `presets` | `{ presets: [{id,name,description,trust,broken?}], current }` |
| server→client | `current_preset` | `{ id }` on connect / after switch |
| client→server | `list_presets` | — |
| client→server | `set_preset` | `{ id }` — streaming guard; unknown/broken id → `error` to sender only |

The roster fetch is a JSON-RPC call on the bridge; server.js caches it per
child generation and invalidates on (re)connect.

## Risks / spikes for implementation

1. Confirm the bridge file's imports resolve inside the generated profile
   (relative plugin path + the pinned `@deepseek-ai/dsh-agent-presets`
   dependency installed by the profile boot). Verify on `npm start` (Mac) —
   Docker parity comes from the same profile boot.
2. Confirm `agents.create` accepts the `setup` option in the installed dsh
   version (`dsh-agent/lib/types/index.d.ts` line ~117: `CreateAgentOptions.setup`).
3. First-boot composition change: after upgrade, sessions mount `standard`
   rather than the bare host composition. Smoke-test a prompt end-to-end for
   each of the four modes once via the WS probe before e2e.
4. `creator`/`cordis` mode can write runtime files — it is a shipped mode, so
   it stays selectable; no new risk beyond what the mode already is upstream.
