# Session-open latency measurements (task 5.1)

Fixture: one session with 300 answered pairs (600 messages, ~220 chars per
assistant message) seeded into the throwaway SQLite store, opened by clicking
its sidebar row in headless Chromium against a local server. In-page
timestamps (performance.now at click; MutationObserver for the transient
skeleton; text-visibility polling for the loaded transcript). 3 runs each,
2026-10-01, localhost — network-free, so these isolate the CLIENT cost
(mount + paint); on fd-prod the payload round-trip dominates and the
optimistic/cache wins scale with it.

| metric                              | before    | after        |
| ----------------------------------- | --------- | ------------ |
| cold open (click → transcript tail) | 78–127 ms | 21–23 ms     |
| re-entry, visited session           | 76–96 ms  | 13–24 ms     |
| re-entry, cache bypassed            | —         | 12–14 ms     |
| feedback (click → skeleton)         | ∞ (none)  | ≤2 ms        |

Reading:

- The cold-open ~4× is the render-windowing win: only the last 50 of 600
  turns mount (Markdown + charts per turn were the mount cost).
- Re-entry improvement combines the cache (no server round-trip for content)
  with windowing; even with the cache emptied the windowed mount keeps the
  open fast (12–14 ms).
- The skeleton never had a "before" number — the pre-change view simply kept
  the previous transcript on screen until the load landed (the dead-click
  feel). ≤2 ms on localhost; on fd-prod's multi-second loads this is the
  visible difference between feedback and nothing.
- The before numbers were taken on the pre-change bundle (the five changed
  files stashed, e2e dist rebuilt); after numbers on the change's build.
  Method: temporary playwright probe (deleted after the run), same seeding
  and timing code both times.
