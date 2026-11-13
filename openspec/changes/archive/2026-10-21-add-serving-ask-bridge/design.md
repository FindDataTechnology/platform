## Context

The ask seam is settled platform machinery (ADR-0012, `platform-user-questions-bridge.js`): the child-side server parks each ask, notifies `userQuestion/ask` with `{sessionId, askId, questions}`, and resolves on a `userQuestions/answer` request; first-wins falls out of table emptiness; a 15-minute fallback timer (`DSH_ASK_FALLBACK_MS`) is the host-restart backstop. The seam's question shape is strict and the model controls only `id`, `question`, `header`, `detail`, `options[{label, description}]`, `multiSelect`; options carry no id and unknown fields are dropped at the seam. That last fact is what the sister change builds its intent convention on — nothing here may assume richer payloads.

The serving runner composes a child's private home from overlays in a fixed order (`compose.js`: presets → skills → MCP → notify), the notify overlay being a subclass swap of the platform bridge row that is explicitly "LAST in patch order". `harness/dsh.js` owns the per-turn collector keyed by wire session id (`agentKey--sessionId` for pod members); its notification pump already special-cases one child→host RPC (`botNotify/send` → host executes → `botNotify/result` request back). `a2a.js` binds one express app per agent port and streams `delta`/`message`/`done`/`error`. Turn budgets are wall-clock with a hard stop (spec "Turn budgets are enforced with a hard stop"); a pod's over-budget path is cancel-first.

The first consumer is the 萬星 facade chat lane: it relays upstream SSE bytes verbatim (`chat.js`), sits behind nginx with `proxy_buffering off` but default read timeout, and reaches the runner through the registry's reverse proxy. The widget already holds the stream open for the whole turn.

## Goals / Non-Goals

**Goals:**

- A served agent's `ask_user_question` resolves end-to-end for a caller that can answer, with no dsh SDK or child-side change.
- Zero observable change for every existing caller (delegation, bots, non-opt-in streams, `message/send`) — beyond turning a NO_PROVIDER tool error into a clean "cannot answer" tool result.
- The ask never outlives the turn budget and never wedges a runtime; it degrades to a graceful cancel before the hard stop.
- Idle proxies between runner and caller survive a human-paced pause.

**Non-Goals:**

- Rendering, host intents, visitor-level authorization of answers (sister change `add-copilot-control-surface` in fd-wanxing).
- Pausing or extending the turn budget while an ask is pending.
- A2A `input-required` task states or any multi-request turn splitting.
- ACP harness ask support (it keeps auto-decline).
- Asks on self-turns (rhythm/mission prompts): they have no caller and auto-decline like `message/send`.

## Decisions

**D1 — Port the cell bridge as one more subclass in the serving chain, composed last.**
`platform-serving-questions-bridge.js` extends the notify server (`platform-notify-bridge.js`), adds the `user-questions/request` waterfall listener and the `userQuestions/answer` handler with the cell bridge's body verbatim (park, notify, first-wins, fallback timer, shutdown reject-all). `compose.js` writes `user-questions.patch.yml` (disable the notify row, insert this one) after the notify overlay in both the solo and the pod composer. *Alternative rejected:* folding the ask body into the notify bridge — it would couple two independently-owned features and break the overlay-per-feature pattern the runner already follows. *Alternative rejected:* reusing the cell's `platform-user-questions-bridge.js` as-is — it subclasses the permission server, which the serving chain does not carry.

**D2 — Transport: mid-stream `ask` event + side `POST /ask-answer`, not A2A `input-required`.**
The parked promise lives inside the child; the turn's collector and stream sink live in the request handler that started the turn. Splitting the turn across two HTTP requests (return `input-required`, answer on the next message) would require the manager to hold and hand over a live stream sink per session, and the second request's response would have to become the remainder of the first turn's stream — new state, new failure modes, no proven leg. The single long-lived SSE leg is already proven through nginx, the facade relay and the registry proxy for deltas. The side route is the smallest addition: one more handler on the per-agent app, same credential gate, routed to the right child by construction (one app per agent, one child per app). *Trade-off accepted:* a pending ask holds an HTTP connection and a turn slot for its whole window; the budget bound (D4) caps that.

**D3 — Ask forwarding is per-turn and opt-in by request header.**
`turn()` takes `onAsk`; the collector forwards `userQuestion/ask` for its own wire id (the child reports the wire id, so pod namespacing needs nothing). The a2a handler supplies `onAsk` only when the request carried `X-Serving-Ask: 1`; otherwise `onAsk` declines immediately via `userQuestions/answer {cancelled: true}` with the "caller cannot answer questions" reason. Opt-in is a request header rather than a card capability or a per-deployment flag because the ability to answer is a property of the *caller's* transport, and the same deployment is called by both capable (facade stream) and incapable (delegating cell, bot relay) callers. *Alternative rejected:* an adapter-level `onAsk` hook like `onNotify` — notify targets are per-deployment (bound channel); asks target whoever is on the other end of this turn.

**D4 — The ask window is the remaining turn budget, minus a grace interval; the runner self-cancels at the deadline.**
`deadlineAt = turnStartedAt + turnBudgetMs − ASK_GRACE_MS` (default grace 20 s, env-overridable). At the deadline the a2a layer cancels the ask through the answer path, so the agent gets a tool failure it can narrate and the turn ends with a real `message`; the `-32001` hard stop stays untouched as the backstop for a turn that still runs over. Budgets are not paused: the budget protects the runtime's wall-clock occupancy and billing, and a human-paced wait is exactly the occupancy it meters. Deployments that want long asks raise `budget_minutes` (the sister change sets the copilot deployment accordingly). *Alternative rejected:* pausing the budget clock during an ask — it silently decouples the meter from occupancy and invites unbounded waits.

**D5 — Keepalive comment frames, only while an ask is pending.**
`: keepalive\n\n` every 15 s from the moment an ask is forwarded until it resolves. SSE comments are relayed byte-verbatim by the facade and ignored by parsers; 15 s clears the 60 s nginx default and any 30 s-class proxy idle window with margin. Not emitting them on every stream keeps normal turns byte-identical to today.

**D6 — Authorization of answers is the runner's backend credential; visitor binding is the caller's job.**
`/ask-answer` sits behind the same `AGENT_RUNNER_BACKEND_TOKEN` check as the turn methods; the ask id is a fresh UUID minted by the bridge. The runner has no notion of the end visitor, so binding an answer to the visitor who holds the session is enforced in the facade (sister change), not here.

**D7 — Harness capability flag.**
`capabilities()` gains `asks: true` on the dsh adapter (allowlist extended in `harness/adapter.js`); the ACP adapter reports `asks: false`. The flag is informational for callers — ACP children never compose the ask overlay, so they can never emit an ask, and the a2a layer gates on the opt-in header alone. No ACP child ever composes the overlay.

## Risks / Trade-offs

- **Budget kill during a long ask** → mitigated by D4's self-cancel at `deadlineAt`; the residual case (the agent itself runs past budget after the answer) is today's behavior.
- **Middle proxies with sub-15 s idle windows** → keepalive interval is env-overridable (`SERVING_ASK_KEEPALIVE_MS`); the facade relay is verbatim so no tuning is needed there.
- **An agent asking during a self-turn or delegation** → auto-decline (D3); the tool result tells the agent why, which is strictly more informative than today's NO_PROVIDER.
- **Overlay-order regression in a future composer edit** → the compose test asserts the questions overlay is last; the user-questions and notify rows are a disable/insert pair so a mis-order would surface as a missing `bot_notify` or missing answerer at cold start, both already observable in the health surface.
- **Pod runtime: two members asking concurrently** → asks are keyed globally by UUID and routed by wire id; collectors are per wire session, so no cross-member mixing. Each member's own budget bounds its own ask.
- **Image rollout** → homes materialize the new overlay on cold start/upgrade only; already-warm children keep NO_PROVIDER until recycled (same as the notify overlay's rollout).
