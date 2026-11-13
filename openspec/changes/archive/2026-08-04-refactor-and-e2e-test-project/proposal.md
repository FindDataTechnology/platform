## Why

The project has grown organically with several new features added (dashboard tab, LiteLLM web UI, collections, SQLite persistence) but the e2e tests haven't been fully updated. One test is already failing due to new sidebar tabs. There's also accumulated technical debt from rapid feature additions that need to be cleaned up for maintainability.

## What Changes

- Fix the failing e2e test (update expected sidebar tabs)
- Expand e2e test coverage to include: dashboard tab, LiteLLM web UI, collections, SQLite persistence features
- Refactor code for consistency across the codebase
- Fix any bugs identified during testing
- Ensure all tests pass reliably

## Capabilities

### New Capabilities
- `e2e-coverage-expansion`: Expand end-to-end test coverage for new features (dashboard, litellm web, collections, sqlite)
- `codebase-refactoring`: Code quality improvements and bug fixes

### Modified Capabilities
- `e2e-testing`: Update existing e2e tests to match current UI state

## Impact

- **Affected code**: `e2e/*.spec.js`, `server.js`, `public/app.js`, potentially other backend modules
- **Dependencies**: Playwright already installed; no new dependencies needed
- **No breaking changes**: All changes preserve existing behavior
