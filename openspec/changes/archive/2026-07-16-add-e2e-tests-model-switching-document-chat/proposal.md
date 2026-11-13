## Why

The existing E2E test suite covers document management, chat history, and basic chat turns, but does not verify the model switching flow or the document chat (RAG) flow. These are core user-facing features that need automated coverage to catch regressions. There are also reported issues in both flows that need to be fixed.

## What Changes

- Add E2E test coverage for model switching flow (UI selector and /model command)
- Add E2E test coverage for chatting with documents (RAG)
- Fix any bugs discovered during test implementation in both flows
- Tests follow the existing Playwright-based pattern with isolated server

## Capabilities

### New Capabilities
- None

### Modified Capabilities
- `e2e-testing`: Add requirements and scenarios for model switching and document chat coverage

## Impact

- Test files: `tests/e2e/*.spec.ts`
- Backend: `server.js` (model switching, document retrieval)
- Frontend: `public/app.js` (model selector UI, document chat UI)
- No production dependencies added; uses existing Playwright setup
