## Why

When chatting with AI models that produce extended reasoning (thinking blocks), users need a quick keyboard shortcut to toggle the visibility of these blocks without reaching for the mouse. The existing thinking blocks are only collapsible via click; a keyboard shortcut improves accessibility and workflow efficiency.

## What Changes

- Add `Ctrl+O` (or `Cmd+O` on Mac) keyboard shortcut to toggle expansion/collapse of all thinking blocks in the chat UI
- Thinking blocks remain expanded by default (existing behavior)
- E2E tests verify thinking blocks are displayed, the shortcut toggles their state, and the visual state updates correctly
- No breaking changes - this is purely additive

## Capabilities

### New Capabilities
- `foldable-observation-shortcut`: Keyboard shortcut (Ctrl/Cmd+O) to toggle thinking block expansion state

### Modified Capabilities
- `chat-streaming`: Thinking blocks (already streamed via WebSocket) now support keyboard-driven toggle
- `e2e-testing`: Add coverage for thinking block display and keyboard shortcut behavior

## Impact

- **Frontend**: `public/app.js` - Add keyboard event listener, toggle thinking block CSS classes
- **Tests**: New Playwright test for observation/thinking block display and shortcut behavior
- **No backend changes** required
