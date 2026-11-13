# Tasks: add-plan-progress-panel

## 1. Protocol & server capture

- [x] 1.1 Add `TodoItem` (`content`, `status: pending|in_progress|completed`) and the `todos` server event (with `counts`) to `packages/core/src/types/ws.ts`; verify `npm --prefix web run typecheck` passes
- [x] 1.2 Add `todos`/`counts` state + `apply` case to `packages/core/src/store/chat-store.ts` (reset on `session_loaded` and in `clearView`); verify a store unit check via typecheck and the e2e dev build compiling
- [x] 1.3 In `server/dsh-events.js`, add `case "todo/write"`: validate array payload, cache on a new `ctx.planBySession` map, broadcast `{type:"todos", todos, counts}`; malformed payload → debug log only. Verify by hand-running a fake notification through `handleDshEvent` (or a unit script) and observing the broadcast
- [x] 1.4 Push the cached snapshot in `server/ws.js` (connection handler + `syncReadyClient`, mirroring `current_permission`) and after `session_loaded` in `server/agent-session.js`; clear the current session's entry on new-session creation. Verify with two browser tabs: tab A prompts the model, tab B reloads mid-plan and shows the same list

## 2. Web — panel, dock, ToolBlock

- [x] 2.1 Add `chat.plan.*` i18n keys ×5 locales (title, counts join, per-status labels, tooltip, updated-plan line); verify `npm run check:locales` passes
- [x] 2.2 Build `TodoList` + status iconography (pending ○ / in-progress with spinner + emphasis / completed muted strikethrough, `line-clamp-2` + title tooltip) and the right-side `PlanPanel` (300px, `border-l`, header `Progress completed/total` + collapse, internal scroll, auto-scroll to first in-progress); mount in `ChatPage` as the two-column wrapper (chat column `min-w-0 flex-1`, panel `hidden lg:flex`, unmounts when list empty). Verify visually on ≥lg viewport with mocked store state and `npm run web:dev`
- [x] 2.3 Build the `<lg` dock: collapsed line (title + `completed/total` + `·`-joined non-zero counts) inside the composer card above the textarea, accordion expansion reusing `TodoList`; verify at a narrow viewport that expansion keeps the composer pinned (no page scrollbar)
- [x] 2.4 Special-case `todo_write` in `ToolBlock`: compact localized one-line summary with counts (from block args or latest `todos` state), expandable to the generic body; verify in a transcript replay that other tools render unchanged

## 3. e2e & verification

- [x] 3.1 New e2e spec: `todos` broadcast renders panel; whole-list replacement; plan survives next-turn send and turn end; hidden when empty; `todo_write` transcript line present. Verify `playwright test` (fast project) green
- [x] 3.2 New e2e spec: new-chat clears the plan; switch away → panel clears, switch back → restores; reload mid-plan restores (server push). Verify green
- [x] 3.3 Full gate: `npm run lint`, `npm --prefix web run typecheck`, `npm run check:locales`, fast e2e project all pass; record the post-ship adoption query (`SELECT COUNT(*) FROM trace_events WHERE event_type='todo/write'`) in the change notes for the follow-up nudge decision

## Verification notes (implementation)

- **Unit** (`npm run test:unit`, 164 pass): `scripts/test-plan-progress.mjs` covers the
  capture contract — broadcast shape + counts, wholesale replacement, bot-session
  routing, malformed payload ignored, whitespace-only entries dropped, turn
  boundaries leaving the plan alone, and `planMessage` answering empty for an
  unknown session. `scripts/test-plan-rehydrate.mjs` boots the real
  `attachWebSocket` handler over a real WS client: connect-time snapshot,
  switch-to-a-session-with-a-plan restoring it *after* `session_loaded`, and
  switch-to-a-session-without-one clearing it.
- **Fast e2e** (`npx playwright test --project=fast`, 213 pass / 1 fail):
  `e2e/plan-progress.spec.js` (10 tests) covers panel rendering + counts + status
  treatments + side-by-side geometry, wholesale replacement, turn-boundary
  persistence, empty-hides-everything, collapse/expand, `session_loaded` clear,
  the `< lg` dock (counts, expansion, composer stays pinned, no page scrollbar),
  the `todo_write` summary line vs. an unchanged generic block, the real server's
  connect-time `todos` push, and new-chat clearing through the real server.
  The 1 failure is `e2e/sso-user-bindings.spec.js` (email case normalization in
  `/api/auth/me`) and reproduces with this change's server files stashed — it is
  pre-existing and unrelated.
- **Live model** (`e2e/plan-smoke.spec.js`, @smoke, not part of the fast gate):
  written to prove the whole path with a real turn. A manual probe against the
  same prompt DID verify it — the model called `todo_write`, dsh emitted
  `todo/write`, and the server broadcast `todos` with
  `counts {pending:3}` over the WS. The spec itself is currently red in this
  environment because that run's live provider route produced no model output at
  all within 90s (the user turn rendered, no assistant turn followed); the spec
  now asserts the turn completes first so a provider outage no longer reads as a
  plan-pipeline bug. Re-run with `npm run test:e2e:smoke` once a working provider
  route is configured.
- **Gates**: `npm --prefix web run typecheck` clean, `npm run check:locales` clean
  (428 keys × 5 locales), `npx biome check` clean on every touched file (the
  repo-wide lint errors are pre-existing vendored scripts under `.pi/skills/`).
