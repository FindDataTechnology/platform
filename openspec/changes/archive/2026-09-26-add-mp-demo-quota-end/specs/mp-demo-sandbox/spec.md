# mp-demo-sandbox Delta: coded quota signal + reconnect-recovery end state

## ADDED Requirements

### Requirement: The sandbox quota-end event is machine-readable

When a sandbox connection's prompt is rejected by its per-connection cap, the
server SHALL emit the limit reply as an error event carrying a stable code
identifying the sandbox per-connection shape, in addition to the
human-readable message. The reply SHALL start no model turn.

#### Scenario: a capped prompt carries the code

- **WHEN** a sandbox client's prompt is rejected by the per-connection cap
- **THEN** the client receives an error event whose code identifies the sandbox limit, and whose message is the human-readable limit reply

## MODIFIED Requirements

### Requirement: Sandbox mode caps every connection's prompts

A deployment running with sandbox mode enabled SHALL apply the demo prompt
budget to EVERY client connection — each WebSocket connection SHALL be allowed
its own bounded number of user prompts; beyond the cap the connection SHALL
receive a friendly limit reply inviting a reconnect, and no further model turn
SHALL run for that connection. The deployment-wide per-cell budget (gateway
shape) remains untouched.

#### Scenario: a reviewer exhausts the per-connection cap

- **WHEN** a sandbox client sends more prompts than the cap in one connection
- **THEN** the prompt after the cap is answered with the sandbox limit reply and starts no model turn

#### Scenario: a reconnect gets a fresh budget

- **WHEN** a capped-out client disconnects and reconnects
- **THEN** the new connection starts with a full budget

#### Scenario: the sandbox quota end offers reconnect as recovery

- **WHEN** a sandbox client's prompt is rejected by the per-connection cap in the mini-program
- **THEN** the chat shows a persistent in-conversation card stating this connection's quota is exhausted and offering an explicit reconnect action as its primary action (a reconnect restores the budget), the rejected prompt's text is restored to the composer draft, and the card disappears once a new connection with fresh budget accepts a prompt
