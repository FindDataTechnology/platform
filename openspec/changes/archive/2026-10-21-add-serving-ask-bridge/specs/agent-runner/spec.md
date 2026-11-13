# agent-runner Specification (delta)

## ADDED Requirements

### Requirement: In-flight asks ride the serving stream

A served agent's `ask_user_question` tool SHALL have an answerer: the runtime home of every served child SHALL carry the user-questions provider, composed after every other overlay, so the tool resolves through the serving lane instead of failing for want of a provider. An ask raised during a turn SHALL be forwarded only to a `message/stream` caller that opted in by sending the `X-Serving-Ask: 1` request header; it SHALL ride the same stream as the turn's deltas as an `ask` event carrying the ask id, the session id, the question batch exactly as the runtime's inquiry seam shaped it (question id, question, optional header/detail/options with label and optional description, optional multi-select), and the deadline by which the ask must be answered. The stream SHALL remain open while the ask is pending and SHALL resume delivering deltas, the final message and termination once the ask resolves.

Each hosted agent SHALL accept `POST /ask-answer` at its own route, behind the same backend credential check as the turn methods, taking `{askId, answers}` or `{askId, cancelled: true}` and returning the runtime's receipt: `{accepted: true}` for the first submission that lands on a pending ask and `{accepted: false}` with a reason for an unknown or already-resolved ask id. The first submission wins; a later one changes nothing.

Callers that did not opt in — a `message/stream` call without the header, every `message/send` call, delegation and bot callers — SHALL NOT wait on the ask: the runner SHALL decline it immediately so the tool resolves with a result stating that the caller cannot answer questions, and the turn completes on its normal path.

An ask SHALL be bounded by the turn budget: its deadline is the turn's budget end less a grace interval, the runner SHALL cancel an unanswered ask when the deadline passes so the agent can finish its turn, and the turn budget's hard stop remains the last resort and is otherwise unchanged. While an ask is pending the stream SHALL carry keepalive comment frames at least every 15 seconds so idle proxies between the runner and the caller do not drop the stream; comment frames SHALL NOT appear when no ask is pending.

#### Scenario: Served child carries the ask provider

- **WHEN** a served child is composed for a deployment (solo or pod)
- **THEN** its runtime home's overlay order ends with the user-questions overlay after the notify overlay
- **AND** an `ask_user_question` call from that child reaches the serving lane instead of failing with a no-provider error

#### Scenario: Opt-in stream receives the ask and stays open

- **WHEN** a `message/stream` call carries `X-Serving-Ask: 1` and the agent calls `ask_user_question` mid-turn
- **THEN** the stream emits an `ask` event with `askId`, `sessionId`, the question batch in the seam's shape, and `deadlineAt`
- **AND** the stream is not terminated and no `message` or `done` event has been sent yet

#### Scenario: First answer resolves the ask and the turn continues

- **WHEN** the caller posts `{askId, answers}` to `/ask-answer` for a pending ask
- **THEN** the response is `{accepted: true}`
- **AND** the tool call resolves with those answers, the agent continues, and the stream later delivers the turn's deltas, final `message` and `done`

#### Scenario: Cancel resolves the ask as closed by the user

- **WHEN** the caller posts `{askId, cancelled: true}` for a pending ask
- **THEN** the response is `{accepted: true}`
- **AND** the tool call fails with a user-closed error and the agent's turn continues to completion

#### Scenario: A late or unknown answer changes nothing

- **WHEN** `/ask-answer` is posted for an ask id that is unknown or already resolved
- **THEN** the response is `{accepted: false}` with a reason
- **AND** the earlier resolution stands

#### Scenario: Non-opt-in callers never wait on an ask

- **WHEN** the agent calls `ask_user_question` during a `message/send` turn, or during a `message/stream` turn whose request lacked `X-Serving-Ask: 1`
- **THEN** the ask is declined immediately, the tool result states the caller cannot answer questions, and the turn completes on its normal path within its usual timing

#### Scenario: The ask deadline precedes the budget hard stop

- **WHEN** an opt-in caller never answers a pending ask
- **THEN** the runner cancels the ask at `deadlineAt` (budget end less grace) and the agent's turn finishes normally
- **AND** the turn budget hard stop is not triggered by the pending ask alone

#### Scenario: Keepalive only while an ask is pending

- **WHEN** an ask is pending on an opt-in stream for longer than 15 seconds
- **THEN** the stream carries SSE comment frames at least every 15 seconds until the ask resolves
- **AND** a stream with no pending ask carries no comment frames

#### Scenario: The answer route is credential-gated

- **WHEN** `/ask-answer` is posted without the deployment's backend credential while the runner has one configured
- **THEN** the request is rejected with the same unauthorized response the turn methods give, and the pending ask is unaffected
