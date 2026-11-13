# ⑨b close-under-concurrency — measurement record

Date: 2026-10-19
Candidate tree: `node_modules/.cache/dsh-contracts-tree/eab0fd13e31334e8` (frozen matrix scratch, dsh@0.2.0-rc.2)
Dummy LLM route: local, no upstream, no tokens spent.

## Result

**5/5 PASS** with both turns genuinely parked mid-request before release.

```
⑨b close-under-concurrency (advisory) [advisory] PASS — both turns closed without a cancel — close-under-concurrency holds (620-650ms)
dsh-contracts: 17/17 PASS
```

## This contradicts the design's premise

`wire-dsh-live-runtime-control` design (Risks) and contract ⑨'s inline note both
record "turn close does not interleave freely with another session's parked
request on rc.2 — observed non-deterministically wedging even after release".
The design for `concurrent-chat-sessions` inherited that as the reason the
platform must serialize turns (`queue` policy), and the spec makes `concurrent`
gated on ⑨b going green.

## Why this measurement is not yet a refutation

1. **A false-green was found and removed.** The first version held only A
   (`[HOLD]`), so B's turn completed while A was parked — the strict question
   was never asked. It passed 6/6 that way. The contract now parks BOTH
   (`[HOLD]` on each) and asserts `heldCount() >= 2` before releasing.
2. **Session-status preconditions were also wrong.** An earlier revision
   asserted `lastStatus(...) === "running"` for both sessions and read
   `A:idle B:idle` — `lastStatus` is the latest reported transition, not proof
   of a live run. The precondition is now the dummy's held queue.
3. **The original failure was non-deterministic** ("observed non-deterministically
   wedging"). Five green runs cannot rule out a rare wedge, and this suite's
   dummy LLM is far faster than a real provider (one SSE chunk, release
   immediately). The timing profile that produced the original observation is
   not reproduced here.
4. **The platform's own contract ⑨ still documents the limitation** and its
   cleanup path says convergence after release is unreliable. Two contracts now
   make opposite claims about the same upstream behavior.

## Consequence for this change

No code decision is taken from this record. `TURN_DISPATCH` keeps `queue` as the
default and `concurrent` keeps its gate. To revisit:

- reproduce with a slow/streaming dummy (multiple chunks with delays) and with
  interleaved tool-call steps, not a single instant answer;
- run enough iterations to bound a rare wedge (the original note implies
  nondeterminism, so 5 is under-powered);
- resolve the ⑨ / ⑨b contradiction in `dsh-contracts` before any flip.

If a stronger reproduction stays green, the follow-up is a dsh-upgrade change
that promotes ⑨b to a gate and flips the default — exactly the seam design D8
reserved. Nothing in the current implementation has to change for that
(turn-dispatch already treats the policy as a switch).
