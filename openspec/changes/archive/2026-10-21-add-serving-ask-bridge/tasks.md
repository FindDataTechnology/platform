## 1. Bridge + composition (the provider lands in served homes)

- [x] 1.1 `dsh-profile-template/platform-serving-questions-bridge.js`: subclass of the notify server carrying the cell bridge's ask body — `user-questions/request` waterfall listener (park by fresh askId, notify `userQuestion/ask` with `{sessionId, askId, questions}`, abort-signal and fallback-timer unpark), `userQuestions/answer` handler (`{accepted}` first-wins; cancelled carries an optional `reason` so serving declines surface their own text in the tool error), shutdown reject-all; export `name: "platform-serving-questions-server"`
- [x] 1.2 `dsh-profile.js`: `writeServingQuestionsPatch({ dirs })` (renamed from the drafted writeUserQuestionsPatch — the cell side already owns that name and swaps the PERMISSION row) mirroring `writeNotifyPatch` — copies the bridge chain beside the preset bridge and writes `serving-questions.patch.yml` as a disable-notify-row + insert-own-row pair
- [x] 1.3 `agent-runner/compose.js`: append the questions overlay AFTER the notify overlay in both composers (solo + pod)
- [x] 1.4 Unit: `scripts/test-agent-serving-asks.mjs` writer half + the existing `scripts/test-agent-runner.mjs` 4.2 extended — materialized home's patch order ends `[…, notify, serving-questions]` (5 layers), the patch YAML disables the notify row and inserts the questions server row, both solo spec shapes asserted

## 2. Harness + manager threading (the ask reaches the turn)

- [x] 2.1 `agent-runner/harness/dsh.js`: collector handles `userQuestion/ask` → invoke the turn's `onAsk({ askId, sessionId, questions, deadlineAt })` (wire-id routing already free); `capabilities()` gains `asks: true` (allowlist extended in `harness/adapter.js`; ACP declares `asks: false`); an ask on a turn WITHOUT an `onAsk` is declined by the harness itself (`{cancelled: true, reason: "the caller cannot answer questions"}`) — same receipt as a declining callback would give, one implementation
- [x] 2.2 `agent-runner/child.js`: `turn(…, { onDelta, agentKey, onAsk })` passes through; `agent-runner/manager.js`: `turn(…, { …, onAsk })` threads it (solo + pod member paths); `answerAsk(entry, askId, { answers, cancelled, reason })` → `child.request("userQuestions/answer", …)` returning the bridge receipt, never spawning
- [x] 2.3 Unit (`scripts/test-agent-serving-asks.mjs`): fake client pumps a `userQuestion/ask` mid-turn → `onAsk` fires with the parked payload and a deadline inside the budget window; the answer resolves the turn; a no-`onAsk` turn declines immediately and completes; the deadline cancel fires before the budget kill on a shortened budget

## 3. A2A surface (event, side route, deadline, keepalive)

- [x] 3.1 `agent-runner/a2a.js`: `X-Serving-Ask: 1` opts a `message/stream` in — the a2a `onAsk` emits `event: ask {askId, sessionId, questions, deadlineAt}` and starts the keepalive comment timer (`askKeepaliveMs` / `SERVING_ASK_KEEPALIVE_MS`, default 15 s); non-opt-in streams and `message/send` pass NO `onAsk` (the harness declines, per 2.1 — same observable timing, one implementation)
- [x] 3.2 Deadline: computed in the harness (exact per-member budget; floor `min(1s, budget/2)` so the deadline can never pass the budget itself) and self-cancelled there; a2a carries only a post-deadline cleanup backstop that stops the keepalive
- [x] 3.3 `POST /ask-answer` on the per-agent app: same backend-credential gate as the turn route, `{askId, answers | cancelled}` (400 on malformed) → `manager.answerAsk` receipt relayed as-is; a settled ask also stops its stream's keepalive (`liveAsks` bookkeeping)
- [x] 3.4 Unit (`scripts/test-agent-serving-asks.mjs`): SSE emits a well-formed `ask` event mid-stream and stays open; `/ask-answer` first-wins receipts + 400 shapes + 401 without credential; a non-opt-in stream never sees an ask and completes normally; keepalive comments flow only while an ask pends

## 4. Docs + verification

- [x] 4.1 `docs/adr/0029-serving-ask-bridge.md`: D2 transport choice (side route vs `input-required` splitting), D3 opt-in header, D4 budget-bounded window — cross-links the fd-wanxing sister change
- [x] 4.2 Full local gate: `node --test scripts/test-agent-serving-asks.mjs` 10/10; runner-adjacent set (harness-adapter / agent-runner / agent-serving / serving-asks / notify-bridge / delegation-a2a) 166/166; full-suite re-run green except the pre-existing parallel-session `test-official-packs-lint.mjs` 14≠12 (wire tool_risk universe grew under an in-flight change — not this change's files); `openspec validate add-serving-ask-bridge --specs --json` green
- [x] 4.3 Live probe before rollout: after the serving image rolls, cold-recycle one deployment and confirm `ask_user_question` from it no longer answers NO_PROVIDER on a plain (non-opt-in) stream but returns the cannot-answer tool result
