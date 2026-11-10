# mp-demo-sandbox Specification

## Purpose
An accountless demo sandbox that lets WeChat reviewers (and curious new users)
hold real chats against a dedicated, disposable platform instance, without any
login, any personal-authorization prompt, or any access to the production
deployment's data — sized to run as one small pod alongside the existing
single-process fd-prod deployment.

## Requirements

### Requirement: The sandbox quota-end event is machine-readable

When a sandbox connection's prompt is rejected by its per-connection cap, the
server SHALL emit the limit reply as an error event carrying a stable code
identifying the sandbox per-connection shape, in addition to the
human-readable message. The reply SHALL start no model turn.

#### Scenario: a capped prompt carries the code

- **WHEN** a sandbox client's prompt is rejected by the per-connection cap
- **THEN** the client receives an error event whose code identifies the sandbox limit, and whose message is the human-readable limit reply

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

### Requirement: The sandbox accepts no document uploads

With sandbox mode enabled, document upload SHALL be rejected with a friendly
error, so anonymous visitors cannot fill the ephemeral disk. Chat, agent
selection, and the welcome prompts remain fully usable.

#### Scenario: an upload attempt in the sandbox

- **WHEN** a sandbox client POSTs a document
- **THEN** the response explains that uploads are unavailable in the demo environment and no file is written

### Requirement: The sandbox wipes its conversation state periodically

A sandbox deployment SHALL clear chat sessions on a configurable interval:
start a fresh session, then delete every prior session, while never
interrupting a streaming turn. Because the sandbox's data volume is ephemeral,
pod recreation additionally erases everything.

#### Scenario: the wipe timer fires between turns

- **WHEN** the wipe interval elapses and no turn is streaming
- **THEN** prior sessions are deleted and subsequent clients see an empty session list

#### Scenario: a streaming turn defers the wipe

- **WHEN** the wipe interval elapses while a turn is streaming
- **THEN** the wipe is skipped and retried on the next interval

### Requirement: The demo pod is isolated from the account deployment

The demo pod SHALL run the same image as the platform but with its own empty
ephemeral data, no authentication mode, no account bindings, and no shared
volumes or secrets with the account deployment except the deployment-wide LLM
key. It SHALL NOT be scheduled onto the account deployment's node, and its
public entry SHALL be a dedicated hostname routed to the demo pod only.

#### Scenario: nothing of the owner's is reachable

- **WHEN** a client connects to the demo hostname
- **THEN** it reaches the demo pod's empty dataset, and no request path exists from it to the account deployment's data or sessions

#### Scenario: the demo pod never lands on the pinned node

- **WHEN** the demo pod is scheduled
- **THEN** it is placed on a node other than the account deployment's pinned node

### Requirement: The client enters and leaves the sandbox deliberately

An unbound user's first launch SHALL land in the sandbox automatically: when
the silent login probe returns `binding_required` and the client knows an
accountless sandbox origin (the production build's paired demo origin), the
client SHALL switch to that origin and connect without any login and without
requiring a tap. The switch SHALL be reversible and transparent: the
previous origin is remembered, and a persistent notice identifies the demo
environment.

Leaving the sandbox SHALL stay deliberate. The in-demo notice SHALL carry a
bind call-to-action （绑定账号解锁完整功能 ›）: activating it SHALL restore
the account origin, re-boot the runtime, and open the sign-in page with
scan-to-bind ready (see `miniprogram-auth`) — one user tap from demo to a
bound account. A plain exit affordance （退出演示） SHALL also remain for
users who want the browsable unbound state on the account origin instead of
binding. The production sign-in flow SHALL behave exactly as before.

#### Scenario: an unbound reviewer taps 先体验

- **WHEN** an unbound user taps the demo entry
- **THEN** the client connects to the demo origin and chat works with no login and no authorization popup

#### Scenario: an unbound first launch lands in the sandbox

- **WHEN** an unbound user opens the mini program on a production build that pairs a sandbox origin
- **THEN** the client connects to the sandbox origin and chat works with no login, no tap, and no authorization popup

#### Scenario: the bind CTA carries the user to scan-to-bind

- **WHEN** the user in the sandbox taps 绑定账号解锁完整功能
- **THEN** the client restores the account origin, re-boots, and lands on the sign-in page with the scan action ready

#### Scenario: leaving the demo

- **WHEN** the user taps the demo notice's exit affordance
- **THEN** the client restores the production origin, re-boots, and lands in the previous unbound-notice state
