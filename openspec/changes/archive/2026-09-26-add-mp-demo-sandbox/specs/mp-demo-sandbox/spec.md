## Purpose

An accountless demo sandbox that lets WeChat reviewers (and curious new users)
hold real chats against a dedicated, disposable platform instance, without any
login, any personal-authorization prompt, or any access to the production
deployment's data — sized to run as one small pod alongside the existing
single-process fd-prod deployment.

## ADDED Requirements

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

An unbound user SHALL see a "先体验" affordance next to the sign-in entry.
Activating it SHALL switch the client to the demo origin and connect without
any login; while on the demo origin the client SHALL show a persistent demo
notice with an exit affordance that restores the production origin and re-boots
the runtime. The production sign-in flow SHALL behave exactly as before.

#### Scenario: an unbound reviewer taps 先体验

- **WHEN** an unbound user taps the demo entry
- **THEN** the client connects to the demo origin and chat works with no login and no authorization popup

#### Scenario: leaving the demo

- **WHEN** the user taps the demo notice's exit affordance
- **THEN** the client restores the production origin, re-boots, and lands in the previous unbound-notice state
