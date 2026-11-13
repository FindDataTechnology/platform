## Context

The chat UI currently renders thinking/observation blocks as collapsible elements that can only be toggled by clicking their header. These blocks are created by `createThinkingBlock()` in `public/app.js` and receive streamed content via WebSocket `thinking` events. The blocks use an `.open` CSS class to control visibility of their content.

The existing E2E test suite (Playwright-based) covers document management, chat history, model selection, and chat turn flows under `e2e/`.

## Goals / Non-Goals

**Goals:**
- Add keyboard shortcut (`Ctrl+O`/`Cmd+O`) to toggle all thinking blocks
- Maintain existing default-expanded behavior
- Add E2E tests for the shortcut behavior
- No breaking changes to existing functionality

**Non-Goals:**
- No backend/server changes required
- No changes to tool blocks or skill blocks (only thinking blocks)
- No per-block keyboard shortcuts (all blocks toggle together)
- No persistence of toggle state across page reloads

## Decisions

1. **Shortcut Choice: Ctrl/Cmd+O**
   - Rationale: "O" for "Observation" / "Open", not currently used by browser or app for critical operations
   - Alternatives considered: Ctrl+T (collides with new tab), Ctrl+H (collides with history), Ctrl+Space (used by many editors)

2. **Toggle Mode: Global Toggle**
   - All thinking blocks toggle together (not individually via keyboard)
   - Rationale: Simplest implementation, matches most common use case (user wants to see/hide all reasoning at once)
   - Alternatives considered: Individual focus + toggle, but adds complexity and UI doesn't have focus management yet

3. **Implementation Location: `public/app.js`**
   - Add `keydown` event listener on `document`
   - Select all `.thinking-block` elements and toggle `.open` class
   - Prevent default browser action (Cmd+O is "Open File" on macOS)

## Risks / Trade-offs

- **Risk**: Shortcut may conflict with browser/OS shortcuts
  - Mitigation: `Ctrl+O` on Windows/Linux = "Open File" dialog, non-destructive; `Cmd+O` on macOS = same. The feature is optional and users can still click to toggle.
  - Note: Preventing default is appropriate here since this is a web app with its own functionality.

- **Risk**: Accessibility - screen readers may not announce the toggle
  - Mitigation: The existing click-based toggle already has this limitation; the keyboard shortcut is additive, not a replacement.

## Migration Plan

No migration required. Changes are additive and backward compatible. Deploy in standard CI flow.

**Rollback**: Revert the two file changes (`public/app.js`, new test file) if issues arise.
