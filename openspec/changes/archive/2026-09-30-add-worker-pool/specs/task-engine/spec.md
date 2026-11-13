## MODIFIED Requirements

### Requirement: Executions run on execution slots
The engine SHALL dispatch executions to execution slots. A cell SHALL have exactly one interactive primary slot; the primary-slot policy SHALL be serial: an execution waits for any turn streaming in the cell rather than skipping or overlapping, simultaneous executions run one at a time in a deterministic order, and before prompting, the runtime is switched to the execution's target persona — waiting for any in-flight turn and runtime mutation, informing connected clients through the agent-change event, and leaving the runtime on that persona afterwards. When worker slots are available (see `worker-pool`), executions MAY be dispatched to a worker bound to the target persona instead — such executions run concurrently with each other and with the primary's interactive turn, never touch the primary runtime, and fire no agent-change event. Further slot kinds MAY be defined by other capabilities without changing the task model.

#### Scenario: Execution waits for a streaming turn
- **WHEN** an execution is due while a turn is streaming in any session of the cell
- **THEN** the execution SHALL wait for the turn to complete
- **AND** then run exactly once

#### Scenario: Simultaneous executions run sequentially
- **WHEN** multiple executions are due at the same time
- **THEN** they SHALL execute one at a time in a deterministic order
- **AND** SHALL NOT run concurrently

#### Scenario: Persona drift switches the runtime
- **WHEN** an execution of a task targeting persona P is due while the runtime is on persona Q
- **THEN** the runtime SHALL switch to P before the prompt is delivered
- **AND** after the execution the runtime SHALL remain on P
- **AND** connected clients SHALL receive the agent-change event naming P

#### Scenario: No switch when the persona already matches
- **WHEN** an execution is due while the runtime is already on the target persona
- **THEN** no runtime restart SHALL occur for persona reasons

#### Scenario: Worker dispatch bypasses the primary
- **WHEN** an execution is dispatched to a worker bound to its target persona
- **THEN** the primary runtime's persona and turn stream are untouched
- **AND** other dispatched executions may run concurrently with it
