## Context

The Platform project is a browser-based AI assistant built on the pi-coding-agent SDK. It currently has a Playwright E2E test suite with 16 tests covering app shell, documents, chat history, SQLite persistence, and uploads/collections. One test is currently failing due to new sidebar tabs (dashboard, litellm) that weren't in the original test expectations.

## Goals / Non-Goals

**Goals:**
- Fix the failing e2e test by updating expected sidebar tabs
- Expand e2e test coverage for dashboard and LiteLLM tabs
- Ensure all existing tests pass reliably
- Identify and fix any code quality issues or bugs

**Non-Goals:**
- No major architectural changes
- No new features beyond test coverage and bug fixes
- No additional dependencies

## Decisions

**1. Update existing tests first before adding new ones**
- Rationale: The failing test blocks CI/CD and needs to be fixed first
- Alternative: Could disable the test temporarily, but fixing it is better
- Impact: Minimal change, just update the expected array in `app.spec.js`

**2. Use existing test patterns for new coverage**
- Rationale: Maintains consistency with existing test structure
- Alternative: Could refactor test architecture, but unnecessary
- Impact: New tests follow same patterns as existing ones, easy to maintain

**3. Incremental refactoring only where needed**
- Rationale: Avoid big-bang refactoring that introduces risk
- Alternative: Full rewrite of modules, but that's high risk
- Impact: Only refactor code that has clear bugs or maintenance issues

## Risks / Trade-offs

- **Risk**: Test flakiness due to timing issues
  - Mitigation: Use Playwright's built-in waiting and assertions, avoid arbitrary timeouts

- **Risk**: Refactoring might introduce regressions
  - Mitigation: Make small, isolated changes and run tests after each change

- **Risk**: New features may have undocumented behavior
  - Mitigation: Explore the UI first to understand expected behavior before writing tests
