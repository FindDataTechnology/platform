# Evidence — enabling `concurrent` on the production engine (dsh 0.2.0-rc.2)

All experiments ran 2026-10-20 ~04:2x +08 inside the production platform pod
(`platform-587c795d86-xxvlm`, image sha-73c912d), on a THROWAWAY cell
(own data dirs, `TURN_DISPATCH=concurrent` + `DSH_MATRIX_CLOSE_INTERLEAVE=1`,
real volces route deepseek-v4.1-flash inherited from the pod env, zero MCP
servers for a fast honest boot). Protocol: two WS connections, each on its own
fresh session per round; prompts sent while the other turn is open; per-event
timestamps assert turn-lifetime overlap from the SERVER's events.

## Experiment 1 — symmetric concurrency (8/8 PASS)

Both connections prompt「请只回复两个字：收到」back-to-back each round.
PASS criteria per round: both `agent_start` precede the other's `done`
(overlap), zero `queued` events, zero `error`, both `done` ≤90s.

```
[exp  8072ms] cell ready; policyWarn(should be false)=false
round 1: overlap=true queued=false errored=false 3170ms
round 2: overlap=true queued=false errored=false 1798ms
round 3: overlap=true queued=false errored=false 1589ms
round 4: overlap=true queued=false errored=false 1627ms
round 5: overlap=true queued=false errored=false 1776ms
round 6: overlap=true queued=false errored=false 2180ms
round 7: overlap=true queued=false errored=false 1620ms
round 8: overlap=true queued=false errored=false 1617ms
sanity prompt after all rounds: ok
{"verdict":"PASS","rounds":8,"badRounds":[],"policyWarn":false,"sanityOk":true,"avgMs":1922}
```

## Experiment 2 — asymmetric close-interleave (6/6 PASS) — the original failure shape

Connection A asks for a ~200-word essay (turn 3.9–8.6s); 400ms later
connection B prompts the two-char reply (turn 1.3–2.3s). PASS criteria: B's
turn opens AND closes strictly inside A's in-flight turn
(`bDone < aDone && bStart > aStart`) — "turn close interleaves with another
session's parked/in-flight request", the exact property the rc.2 limitation
note ("close does not freely interleave … non-deterministic wedging") said
was broken.

```
round 1: B-closed-inside-A=true errored=false queued=false total=4911ms A-turn=4809ms B-turn=2334ms
round 2: B-closed-inside-A=true errored=false queued=false total=8662ms A-turn=8647ms B-turn=1332ms
round 3: B-closed-inside-A=true errored=false queued=false total=4861ms A-turn=4847ms B-turn=2322ms
round 4: B-closed-inside-A=true errored=false queued=false total=3933ms A-turn=3918ms B-turn=1931ms
round 5: B-closed-inside-A=true errored=false queued=false total=5785ms A-turn=5769ms B-turn=1345ms
round 6: B-closed-inside-A=true errored=false queued=false total=7686ms A-turn=7673ms B-turn=1306ms
{"verdict":"PASS","rounds":6,"bad":[],"policyWarn":false}
```

## Why the old contract evidence was discarded (chain)

1. 2026-10-19 spike「⑨b 5/5 PASS」— VACUOUS: the dummy's final-message [HOLD]
   match parked the session-TITLE side call; the conversation turn answered
   instantly (found while strengthening the harness, changes reverted after).
2. rc.2 issues THREE request kinds per fresh-session turn (conversation,
   context-maintenance「Current runtime context…」, titler); marker-based
   dummy parking cannot be made honest without modeling them (2026-10-20
   trace in dsh-matrix/README.md 勘误).
3. dsh 0.2.1-rc.2 (npm latest): full contracts 8/17 — ④ credentials
   hot-reload regression (rotated credential never reaches the wire), cascade
   ⑦⑧⑨⑩⑯, ⑫ `subagents.start` API change, ⑮ delta lane dead → version
   upgrade rejected per matrix discipline.

## Residual risk & rollback

The historical note claimed NON-deterministic wedging; 14 recorded rounds +
sanity did not reproduce it on the current engine+provider, but a rare wedge
cannot be fully excluded by any bounded experiment. Rollback is env-only:
remove `TURN_DISPATCH`/`DSH_MATRIX_CLOSE_INTERLEAVE` from platform.yaml (or
set `TURN_DISPATCH=queue`) and let cells respawn — minutes, no image change.
The queue policy and its whole UI remain intact as the fallback.

## Production acceptance (2026-10-20 ~04:5x +08)

GitOps `1a74070`（env-only）→ pod `platform-74fd7987f4-pgzth`（image 仍 sha-73c912d，
`TURN_DISPATCH=concurrent` + latch 实证在 env）。用户 cell（webhook 拉起，端口 45459，
合同审查官 persona）双连接双新会话并发 prompt：A 回合 9198ms、B 回合 5626ms、
`overlap=true`、`queued=false`、`errored=false`；测试会话 DELETE 200 ×2。
cell 日志无 `[turn-dispatch]` 降级告警、无 `Unknown agent preset`。

## Rollback (documented, not drilled tonight)

`TURN_DISPATCH=queue`（或删两个 env）→ cells respawn 即回排队态。翻转前 24h 生产
即 queue 态且全链验收过（concurrent-chat-sessions），两者互为演练；镜像不变。
