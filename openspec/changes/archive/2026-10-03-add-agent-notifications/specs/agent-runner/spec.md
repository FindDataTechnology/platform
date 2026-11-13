# agent-runner Specification (delta)

## ADDED Requirements

### Requirement: Deployed children can notify bound channels through the bridge

The platform bridge row each deployed child composes SHALL expose a notification capability: the child may call `bot_notify(event, text[, channel])`, and the runner SHALL execute it with host authority — the platform relay token stays in runner configuration and SHALL never reach the child, whose environment is scrubbed. The deployment MAY bind one named notification channel per serving agent, set by the deployer at deploy time and recorded in the descriptor; a notify call on an unbound deployment SHALL be declined with a structured error naming the missing binding, never silently dropped. The runner SHALL forward accepted calls to the platform's bot relay route addressed to the bound channel (an explicit channel argument, when provided, SHALL name the same deployment-bound channel or be declined), enforce a per-agent notification rate bound, and return the relay's outcome or failure shape to the calling turn.

#### Scenario: A bound deployment delivers a notification

- **WHEN** a child whose deployment binds channel `ops-feishu` calls `bot_notify("ticket_done", "…")`
- **THEN** the runner posts the text to the platform relay addressed to `ops-feishu` with host-held credentials, and the turn receives the relay's success

#### Scenario: An unbound deployment is declined structurally

- **WHEN** a child whose deployment binds no channel calls `bot_notify`
- **THEN** the call is declined with a structured error naming the missing channel binding, and nothing is sent

#### Scenario: The relay token never reaches the child

- **WHEN** a deployed child's composition and environment are inspected
- **THEN** no relay credential is present — the token lives only in runner configuration

#### Scenario: Over-rate notifications are throttled per agent

- **WHEN** a child exceeds its per-agent notification rate bound
- **THEN** excess calls are declined with a rate error before any relay request, and the bound is per agent, not per runner

#### Scenario: Relay failures surface to the turn

- **WHEN** the platform relay refuses or fails a forwarded notification
- **THEN** the calling turn receives the relay's failure shape, and the runner keeps serving
