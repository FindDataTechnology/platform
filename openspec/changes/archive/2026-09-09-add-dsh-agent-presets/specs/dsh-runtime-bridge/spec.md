## ADDED Requirements

### Requirement: The generated dsh profile composes the agent-preset roster and bridge

On profile generation, the server SHALL write a patch overlay inserting (1)
the `@deepseek-ai/dsh-agent-presets` roster plugin configured with the shipped
preset root resolved from the installed `@deepseek-ai/dsh` package and
`default: standard`, and (2) a local bridge plugin that subclasses
`HarnessSdkJsonRpcServer` — row id `sdk-jsonrpc-server`, replacing the stock
row — so both load into the spawned dsh child. The template's `package.json`
SHALL pin `@deepseek-ai/dsh-agent-presets` at the same release-candidate
version as the other dsh peer dependencies. When the shipped preset root
cannot be resolved, the generator SHALL skip those rows with a warning
(graceful degradation: chat still works, preset picker stays empty) rather
than fail profile generation.

#### Scenario: profile contains the roster + bridge rows
- **WHEN** the server generates the platform dsh profile at boot
- **THEN** the generated patch SHALL contain an `agent-presets` row and a
  `sdk-jsonrpc-server` row whose plugin resolves to the local bridge file
- **AND** the bridge file exists in the generated profile directory

#### Scenario: shipped root unresolvable
- **WHEN** the `@deepseek-ai/dsh` package's `config/agent-presets` directory
  cannot be resolved at generation time
- **THEN** the server SHALL log a warning and boot normally with an empty
  roster

### Requirement: The bridge mounts the selected preset before session publication

The bridge SDK server SHALL accept an `agentPreset` parameter on `initialize`
and SHALL, when lazily creating a session's agent, call
`agentPresets.mount(agentCtx, id)` from the unpublished-agent `setup` hook so
a broken or unknown preset fails session creation before the agent is
published. It SHALL add a `presets/list` JSON-RPC method returning the roster
service's rows. When no preset is named it SHALL leave session creation to the
roster default configured on the plugin.

#### Scenario: selected mode is mounted on the next session
- **WHEN** the server initializes the bridge with `agentPreset: "minimal"` and
  the first prompt lazily creates the session
- **THEN** the created agent SHALL be composed under the `minimal` standing
  mount before its first prompt is admitted

#### Scenario: broken preset fails session creation
- **WHEN** `initialize` names a preset the roster marks broken
- **THEN** the first prompt SHALL surface a session-creation error naming the
  preset and no half-composed agent SHALL remain published

#### Scenario: roster query
- **WHEN** a `presets/list` JSON-RPC request arrives
- **THEN** the bridge SHALL answer with every roster row (id, display name,
  description, trust, broken state) or an empty list when no roster is
  composed

### Requirement: Restart carries the selected preset

`dshBridge.restart` SHALL accept an `agentPreset` option that is sent to the
fresh child's `initialize` handshake, alongside the existing provider/model
and workspace arguments.

#### Scenario: mode switch restarts with preset
- **WHEN** the server restarts the bridge with `{ agentPreset: "code" }`
- **THEN** the spawned child SHALL be initialized with
  `agentPreset: "code"` and subsequent new sessions run PTC mode
