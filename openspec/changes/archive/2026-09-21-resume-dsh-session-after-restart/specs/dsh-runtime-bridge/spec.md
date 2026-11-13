## ADDED Requirements

### Requirement: Session continuity across dsh child restarts

The bridge SDK server SHALL keep a session usable after the dsh child process
restarts (config-change restart or crash auto-restart): when a prompt targets a
session id whose persisted log exists, the bridge SHALL resume that session
from its stored log instead of creating a fresh live session under the same id.
The decision SHALL be made before any session object is created; the platform
MUST NOT rely on catching a creation error, because creation with an empty
seed can succeed and only fail later at the first persisted append.

#### Scenario: prompt after a model-switch restart continues the session

- **WHEN** a turn has run on session `S` (its log is persisted), the child is
  restarted by a model or workspace switch, and the user prompts `S` again
- **THEN** the bridge SHALL load `S`'s persisted log, and the turn SHALL NOT
  fail with an id-collision error

#### Scenario: context survives the restart

- **WHEN** a turn tells the agent a fact, the child restarts, and the next
  prompt on the same session asks for that fact
- **THEN** the answer SHALL reflect the pre-restart conversation

#### Scenario: switching to an older conversation after a restart

- **WHEN** the child has restarted and a client switches to a previously
  persisted session and prompts it
- **THEN** the bridge SHALL resume that session's log and admit the turn

#### Scenario: torn final turn does not block resume

- **WHEN** the child is killed mid-turn, leaving the session log without a
  closing turn event, and the restarted child resumes that session
- **THEN** resume SHALL succeed and the next turn SHALL run; the incomplete
  tail SHALL not corrupt the session

#### Scenario: unpersisted session ids still create fresh

- **WHEN** a prompt targets a session id with no persisted log (a brand-new
  conversation)
- **THEN** the bridge SHALL create the session exactly as before, with no
  resume attempt

#### Scenario: resume failure is surfaced, never silent

- **WHEN** the persisted log cannot be resumed (unreadable or incompatible)
- **THEN** the prompting client SHALL receive an error message naming the
  session, and the turn SHALL NOT end with empty output and no explanation

## MODIFIED Requirements

### Requirement: The bridge mounts the selected preset before session publication

The bridge SDK server SHALL accept an `agentPreset` parameter on `initialize`
and SHALL, when lazily creating OR resuming a session's agent, call
`agentPresets.mount(agentCtx, id)` from the unpublished-agent `setup` hook so
a broken or unknown preset fails session creation or resume before the agent
is published. It SHALL add a `presets/list` JSON-RPC method returning the
roster service's rows. When no preset is named it SHALL leave session creation
to the roster default configured on the plugin.

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

#### Scenario: resumed sessions carry the preset mount too

- **WHEN** the bridge resumes a persisted session and a preset is selected
- **THEN** the resumed agent SHALL be composed under that preset's standing
  mount via the same pre-publication setup hook as a created session
