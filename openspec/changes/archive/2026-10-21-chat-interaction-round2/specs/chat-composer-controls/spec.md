## MODIFIED Requirements

### Requirement: Control strip reports runtime restarts

The strip SHALL indicate when a runtime restart is in progress, and the composer SHALL prevent sending until the runtime is healthy again. Effort and workspace changes restart the dsh runtime, because dsh fixes that configuration in the `initialize` handshake. Model changes follow the bridge's declared capability: when the bridge declares the `model/set` RPC, a model switch applies live without re-spawning the runtime and without entering the pending state or disabling the send button (consistent with `model-selection`); when the bridge does not declare it, a model change takes the legacy restart path with the pending window. An agent change SHALL NOT restart the dsh runtime — the server switches the active catalog agent in place and broadcasts `agent_changed` without re-spawning the child — and SHALL therefore NOT put the strip into the pending state or disable the send button.

#### Scenario: restart is visible on the strip

- **WHEN** a control emits a change that restarts the dsh runtime (effort or workspace)
- **THEN** that control SHALL display a pending state until the corresponding change broadcast is received
- **AND** the send button SHALL be disabled for the duration

#### Scenario: send is re-enabled after restart

- **WHEN** the server broadcasts the change confirming the restart completed
- **THEN** the pending state SHALL clear
- **AND** the send button SHALL be re-enabled subject to its existing conditions

#### Scenario: agent change does not enter the pending state

- **WHEN** the user selects a different agent and the server broadcasts `agent_changed`
- **THEN** the strip SHALL NOT display a pending state for the agent control
- **AND** the send button SHALL NOT be disabled on account of the agent change

#### Scenario: live model switch does not enter the pending state

- **WHEN** the bridge declares the `model/set` capability and the user selects a different model (including mid-stream)
- **THEN** the strip SHALL NOT display a pending state for the model control and the send button SHALL remain available
- **AND** the active-model broadcast SHALL update the strip's model display

#### Scenario: bridge without model/set keeps the restart path

- **WHEN** the bridge does not declare the `model/set` capability and the user selects a different model
- **THEN** the model change SHALL behave as a runtime restart — pending state on the model control and send disabled until the change broadcast
