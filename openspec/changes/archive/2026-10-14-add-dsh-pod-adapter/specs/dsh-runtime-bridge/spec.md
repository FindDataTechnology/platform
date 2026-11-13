# dsh-runtime-bridge 变更（add-dsh-pod-adapter）

## ADDED Requirements

### Requirement: Per-session preset selection parks until the session exists

The platform bridge SHALL accept `preset/set {sessionId, presetId}` as a live JSON-RPC method: the selection is PARKED for the named session id and applies when that session is (lazily) created — the creation-time mount resolves the parked preset first, then the initialize-time `agentPreset`, then the registry default — and the session header (`meta.agentPreset`) SHALL name the preset actually mounted. `preset/set` on a session that already has a live agent SHALL be refused with an explicit structured error stating that persona is creation-time composition (start a new session), never silently ignored. A parked preset id that cannot be resolved at creation SHALL fail session creation loudly before any agent is published (the factory rolls the whole creation back) — the same contract the initialize-time preset already follows. `platform/capabilities` SHALL report `preset/set` so hosts can gate pod-mode serving on it and degrade to solo against an older child.

#### Scenario: A parked preset applies at creation

- **WHEN** the host calls `preset/set {sessionId: "s1", presetId: "packs-demo-writer"}` before the first prompt of "s1"
- **THEN** "s1"'s agent composes with that preset's persona, and the session header's `meta.agentPreset` names it

#### Scenario: A live session's preset is refused explicitly

- **WHEN** the host calls `preset/set` for a session that already has a live agent
- **THEN** the call fails with a structured error naming the creation-time-composition rule, and the session keeps its mounted preset

#### Scenario: An unknown preset fails session creation loudly

- **WHEN** a parked (or initialize-time) preset id is not in the roster when the session is created
- **THEN** session creation fails before the agent is published, no half-composed agent serves, and no residue leaks into later sessions

#### Scenario: Capabilities report the method

- **WHEN** the host probes `platform/capabilities`
- **THEN** the reported method set includes `preset/set` alongside `model/set` and `session/cancel`
