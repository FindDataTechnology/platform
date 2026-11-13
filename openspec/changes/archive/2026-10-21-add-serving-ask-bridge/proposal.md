# Serving Ask Bridge Proposal

## Why

The embed copilot lane (fd-wanxing `add-embed-copilot-lane`, archived 2026-10-21) put a 萬星-served agent inside product-line pages as a chat widget with host context. Its archived proposal names the second half explicitly: an **操控面** where the agent can ask the user mid-turn and propose host-page actions — and it states that the runner-side piece is "a port, not a build": the platform already owns the `ask_user_question` seam (`dsh-profile-template/platform-user-questions-bridge.js`, ADR-0012) for cells.

The serving plane cannot do this today, and the gap is deeper than a dropped notification:

- `agent-runner/compose.js` composes served children from four overlays — presets, skills, MCP, notify. The user-questions bridge is written only by `dsh-profile.js` into a **cell's** home. A served child's `ask_user_question` tool therefore has **no provider**: the seam's own waterfall answers NO_PROVIDER and the tool errors. No fleet-served agent can hold an interactive turn, whether called from the 萬星 chat lane, the embed widget, or a delegating cell.
- Even with a provider, `harness/dsh.js`'s turn collector only understands `session.status`, `platform/stream`, `session.event` and `_child_exit`; an in-flight `userQuestion/ask` would be ignored and the ask would sit until the bridge's 15-minute fallback — long after the turn budget killed the turn.
- `a2a.js` streams exactly four events (`delta`/`message`/`done`/`error`) and has no way for a caller to answer anything.

This change is the foundation half of the E3 pair. Its sister, fd-wanxing `add-copilot-control-surface`, consumes the new stream event and answer route to render 问询卡 in the widget and route host-page intents; it cannot start acceptance until this lane exists. The two touch disjoint specs (this one: `agent-runner`; the sister: `wanxing-facade`/`wanxing-web`), so neither blocks the other's archive.

## What Changes

- **Served children carry the user-questions provider.** A new bridge subclass (`dsh-profile-template/platform-serving-questions-bridge.js`) extends the notify server with the cell bridge's ask body — park the ask, notify `userQuestion/ask` upward, answer on `userQuestions/answer`, first-wins by table emptiness, fallback timer — and `compose.js` writes a `user-questions.patch.yml` overlay **last** (after notify), for both the solo and the pod composers. No dsh SDK or child-side change; the ask payload is the seam's strict shape (`{id, question, header?, detail?, options?[{label, description?}], multiSelect?}`).
- **In-flight asks ride the turn.** `DshHarnessAdapter.turn()` accepts a per-turn `onAsk`; the collector forwards `userQuestion/ask` notifications for its wire session to it (the same mid-turn, session-bound lane `platform/stream` deltas already ride — pod wire-id namespacing works unchanged because the child reports the wire id). `AgentChild.turn` and `manager.turn` thread the option through; the manager gains `answerAsk(entry, askId, payload)` on the adapter's existing `request()` deep-control passthrough.
- **A2A surface: `ask` event + `/ask-answer` route, opt-in.** A `message/stream` call that sends `X-Serving-Ask: 1` receives `event: ask` `{askId, sessionId, questions, deadlineAt}` mid-stream and the stream stays open; `POST /ask-answer` on the same per-agent port (behind the same backend-credential check as the turn) takes `{askId, answers}` or `{askId, cancelled: true}` and returns the bridge's `{accepted}` receipt. Callers that did not opt in — plain streams, `message/send`, delegation and bot callers — get the ask **auto-declined immediately** so the tool resolves with a clean "the caller cannot answer questions" result instead of waiting; that is strictly better than today's NO_PROVIDER error and changes no existing caller's observable timing.
- **Ask window is the remaining turn budget.** `deadlineAt` = turn start + budget − grace; the runner cancels an unanswered ask at the deadline itself so the agent finishes its turn gracefully rather than taking a `-32001` budget kill. Budgets stay wall-clock (spec "Turn budgets are enforced with a hard stop" is untouched); deployments that want human-paced asks raise `budget_minutes`.
- **Keepalive while an ask is pending.** The stream emits SSE comment frames (`: keepalive`) every 15 s only while an ask is open, so the wanxing nginx (default 60 s read timeout), the registry reverse proxy and the facade's byte-verbatim relay never drop an idle stream while a human is thinking.
- Harness scope: dsh only. The ACP harness keeps auto-decline (its `capabilities()` does not claim asks).

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `agent-runner`: adds the requirement "In-flight asks ride the serving stream" — provider composition order, the opt-in `ask` event, the `/ask-answer` route and its receipts, auto-decline for non-opt-in callers, the budget-bounded deadline, and pending-ask keepalive. The existing "A2A adapter surface" and "Turn budgets are enforced with a hard stop" requirements are not modified; the new requirement is additive to both.

## Impact

- Code: `dsh-profile-template/platform-serving-questions-bridge.js` (new), `agent-runner/compose.js` (new overlay writer, both composers), `agent-runner/harness/dsh.js` (collector + `onAsk`), `agent-runner/child.js` and `agent-runner/manager.js` (threading + `answerAsk`), `agent-runner/a2a.js` (event, route, heartbeat, deadline), `agent-runner/test/*` (harness, a2a, compose).
- Deployments: the serving image needs a release; runtime homes re-materialize the new overlay on the next cold start / upgrade (same mechanism as the notify overlay). No registry schema change, no new secret — `/ask-answer` reuses `AGENT_RUNNER_BACKEND_TOKEN`.
- Consumers: zero behavior change for callers that do not send the opt-in header. The fd-wanxing sister change is the first opt-in caller.
- Docs: ADR-0029 "Serving asks ride the stream, answers ride a side route" (decision record for the transport choice vs. A2A `input-required` turn splitting).
