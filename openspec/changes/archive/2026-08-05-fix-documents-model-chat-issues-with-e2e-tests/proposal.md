## Why

Three critical usability issues are blocking normal operation: document collections cannot be saved after adding documents, the model selector throws an error when clicked, and chat functionality fails with an error on prompt submission. E2E tests are needed to prevent regressions after fixes.

## What Changes

- Fix documents collection save functionality (persistence not working after document addition)
- Fix model selector error when clicking the change model input
- Fix chat prompt submission error that prevents agent interaction
- Add Playwright-based e2e tests covering all three flows to catch regressions

## Capabilities

### New Capabilities

- `e2e-documents-collection`: Tests for adding documents and saving collections
- `e2e-model-selection`: Tests for model selector interaction and switching
- `e2e-chat-flow`: Tests for basic chat prompt submission and response rendering

### Modified Capabilities

- `document-collections`: Fix save persistence issue
- `model-selection`: Fix click handler error
- `chat-streaming`: Fix prompt submission error
- `e2e-testing`: Expand coverage to the three broken flows

## Impact

Affected files:
- `public/app.js` - model selector click handler, chat submission
- `documents.js` - collection persistence
- New e2e test files under `e2e/` or `tests/` directory
