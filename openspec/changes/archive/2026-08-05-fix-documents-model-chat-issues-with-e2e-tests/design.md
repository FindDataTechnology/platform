## Context

Three issues have been identified in the PAAS web UI:
1. Document collections cannot be saved after adding documents
2. Clicking the model selector input throws a JavaScript error
3. Submitting a chat prompt throws a JavaScript error

The existing codebase uses vanilla JavaScript in `public/app.js` for the frontend, Express + WebSocket on the backend, and has an existing Playwright E2E test suite under `e2e/`.

## Goals / Non-Goals

**Goals:**
- Fix the three identified bugs (collections save, model selector click, chat submission)
- Add E2E regression tests for each fixed flow
- Maintain the existing architecture (no refactoring beyond bug fixes)

**Non-Goals:**
- Rewrite the frontend to use a framework
- Add new features beyond bug fixes and regression tests
- Change the WebSocket protocol

## Decisions

**Bug Fix Strategy:**
- **Model selector click error**: Add null checks in the click handler for DOM elements that may not be initialized. The likely root cause is accessing `.classList` or `.toggle()` on a null element reference.
- **Chat submission error**: Add null checks for WebSocket connection state and DOM references. Validate input before submission to prevent calling methods on undefined.
- **Collections save issue**: Verify the save button handler correctly calls the API endpoint and refreshes the collection list after success. Check for missing await or incorrect API path.

**E2E Test Strategy:**
- Extend the existing Playwright suite under `e2e/`
- Add tests in separate files per flow: `documents-collection.spec.js`, `model-selection.spec.js`, `chat-flow.spec.js`
- Use the existing `@smoke` project pattern for any tests that hit real LLM endpoints
- Reuse the existing server launch configuration with temp store directories

**Playwright Assertions:**
- Use `page.evaluate(() => !window.errorCount)` pattern to detect JavaScript errors
- Assert UI state changes (button states, element visibility, content updates)
- Verify API calls are made correctly by checking network requests or UI side effects

## Risks / Trade-offs

[Risk] Some bugs may be timing-dependent → Mitigation: E2E tests use Playwright's auto-waiting and proper locators to avoid flakiness.
[Risk] Fixing one bug may regress another → Mitigation: Run existing E2E tests after each fix.
[Risk] The root cause may be in server code, not just frontend → Mitigation: Check server logs during test runs and add server-side validation where needed.
