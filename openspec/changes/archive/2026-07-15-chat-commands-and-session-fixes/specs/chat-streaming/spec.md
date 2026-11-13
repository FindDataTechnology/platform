## ADDED Requirements

### Requirement: A failed or aborted turn resets streaming state and emits done
The server SHALL ensure that every agent turn ends with the streaming state reset and a `done` event broadcast to clients, regardless of whether the turn succeeded or failed. If `session.prompt()` rejects (e.g. a model API error) before the SDK emits `agent_end`, the server SHALL reset the streaming flag and broadcast `done` after broadcasting any `error`, so that the UI re-enables input and the model selector, model-switching and new-session creation are not permanently blocked, and the session list refreshes. The server SHALL NOT broadcast `done` more than once per turn.

#### Scenario: failed turn re-enables the UI
- **WHEN** an agent turn fails with an error before completion
- **THEN** the server SHALL broadcast an `error` followed by `done`
- **AND** the streaming flag SHALL be reset to false
- **AND** the model selector and input SHALL be re-enabled

#### Scenario: done is not duplicated
- **WHEN** the SDK emits `agent_end` after the server already broadcast `done` for a failed turn
- **THEN** the server SHALL NOT broadcast `done` a second time
