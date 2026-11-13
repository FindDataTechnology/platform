# Tasks: perf-session-open

## 1. Optimistic switch

- [x] 1.1 Store: on session activation set `currentSessionId` optimistically + `pendingSession` + clear turns; ignore `session_loaded` whose id ≠ current view but feed the cache; restore previous session on switch error; verify store unit tests: instant pending on activate, stale-load ignored, error restore
- [x] 1.2 Render the pending placeholder (skeleton) for the target session in `Chat.tsx` / welcome path; verify e2e: clicking a sidebar row shows the skeleton immediately (no old transcript) and resolves into the loaded session

## 2. Session cache

- [x] 2.1 Implement the LRU turn cache (fill on applied `session_loaded`, cap 10), instant render on cached re-entry with background refresh; drop on delete; conservative `done`-while-viewing refresh; verify store unit tests for fill / re-entry / eviction / drop-on-delete
- [x] 2.2 Verify e2e: A→B→A navigation renders A from cache instantly and reconciles when the refresh lands

## 3. Render windowing

- [x] 3.1 Slice the transcript render to the last 50 turns with a load-earlier affordance (+50, scroll-anchored prepend, outline-jump expansion); data stays complete in the store; verify existing transcript e2e passes unchanged + new e2e for load-earlier and long-session open

## 4. File busy states

- [x] 4.1 Unify the drawer's busy state across image/pdf/docx/external renderers (today text-only); verify e2e: drawer for a slow/large file shows the busy indicator
- [x] 4.2 Switch download actions to fetch→blob→save with a spinner and plain-anchor fallback on failure; verify e2e: download completes via blob path and still downloads when fetch fails

## 5. Integration

- [x] 5.1 Run the full e2e suite + `openspec validate --strict` for this change; measure session-open time before/after on the longest local fixture and record the numbers in the change dir
