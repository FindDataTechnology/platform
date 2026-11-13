## Context

The project already has a Playwright-based E2E test suite in `e2e/` covering:
- App shell navigation
- Document upload/view/delete
- Chat history flows
- Chat turn with duplicate text check
- SQLite persistence
- Bugfix regressions

The server supports model switching via WebSocket (`set_model`) and chat command (`/model`), and document querying via the "Ask the collection" UI in the Documents tab. These flows have reported issues needing fixes and test coverage.

## Goals / Non-Goals

**Goals:**
- Add E2E test coverage for model switching (UI selector + /model command)
- Add E2E test coverage for document chat (RAG) flow
- Fix any bugs discovered during test implementation
- Follow existing test patterns (isolated server, temp stores, Playwright conventions)

**Non-Goals:**
- No new test frameworks or dependencies
- No architectural changes to model switching or document retrieval
- No comprehensive model-provider testing (focus on switching flow, not model correctness)

## Decisions

**Test File Location:**
- Model switching tests → `e2e/model-selection.spec.js` (new file)
- Document chat tests → `e2e/document-chat.spec.js` (new file)
- Rationale: Keeps test files focused by feature area, matches existing pattern (documents.spec.js, chat-history.spec.js)

**Test Project Assignment:**
- Model switching tests → default Playwright project (no-LLM, fast)
- Document chat tests → `@smoke` project (requires LLM call)
- Rationale: Model switching only exercises UI and WS protocol; document chat needs LLM for retrieval/answering

**Fix Strategy:**
- Tests will be written first against current behavior
- Any failures indicate bugs to be fixed in server.js (model switching) or public/app.js (UI)
- Fixes follow existing code patterns with minimal changes

## Risks / Trade-offs

| Risk | Mitigation |
|------|------------|
| Model switching tests flaky due to timing | Use Playwright's `expect().toHaveValue()` with proper timeouts; wait for WS events via UI state changes |
| Document chat tests depend on LLM availability | Mark as `@smoke`, allow generous timeout, use simple deterministic queries |
| Fixes introduce regressions | Run full existing test suite after fixes |
