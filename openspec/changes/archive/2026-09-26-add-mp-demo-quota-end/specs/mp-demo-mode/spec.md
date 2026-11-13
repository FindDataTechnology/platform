# mp-demo-mode Delta: coded quota signal + designed quota-end surface

## ADDED Requirements

### Requirement: The quota-end event is machine-readable

When a demo-scoped prompt is rejected by the per-cell message cap, the server
SHALL emit the limit reply as an error event carrying a stable code identifying
the demo per-cell shape, in addition to the human-readable message. The reply
SHALL start no model turn and SHALL close any in-flight turn state the client
holds for that prompt.

#### Scenario: a capped prompt carries the code

- **WHEN** a demo user's prompt is rejected by the per-cell cap
- **THEN** the client receives an error event whose code identifies the demo per-cell limit, and whose message is the human-readable limit reply

### Requirement: Demo budget is visible before it ends

While a demo-scoped session has remaining message budget, the client SHALL be
able to display the remaining count; the server SHALL report the remaining
per-cell budget to demo-scoped clients as prompts are consumed.

#### Scenario: the echo carries the remaining budget

- **WHEN** a demo user's prompt is accepted
- **THEN** the client can read the session's remaining message budget from the acceptance event

## MODIFIED Requirements

### Requirement: Demo sessions enforce a message cap with an upgrade path

A cell serving a demo identity SHALL count user prompts against a per-cell
cap. Once the cap is reached, further prompts SHALL be answered with a
friendly limit reply that invites binding a real account, and the client SHALL
surface a visible demo-mode notice distinguishing the experience from a full
account.

#### Scenario: the cap answers instead of the model

- **WHEN** a demo user sends a prompt after reaching the message cap
- **THEN** the reply explains the demo limit and offers to bind an account, and no further model turn runs

#### Scenario: the reviewer knows they are in a demo

- **WHEN** a demo user opens the chat page
- **THEN** a demo-mode notice is visible without dismissing any dialog or granting any authorization

#### Scenario: the quota end is a designed surface, not silence

- **WHEN** a demo user's prompt is rejected by the cap in the mini-program
- **THEN** the chat shows a persistent in-conversation card stating the quota is exhausted and offering the bind-account upgrade as its primary action, the rejected prompt's text is restored to the composer draft, and nothing about the state resembles a connection failure

#### Scenario: the demo line states the budget concretely

- **WHEN** a demo user's session has known remaining budget
- **THEN** the demo-mode notice displays the remaining count instead of an unquantified promise
