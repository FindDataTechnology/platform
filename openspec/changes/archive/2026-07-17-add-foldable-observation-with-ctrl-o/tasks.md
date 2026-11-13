## 1. Frontend Implementation

- [x] 1.1 Add keyboard event listener for Ctrl/Cmd+O in public/app.js
- [x] 1.2 Implement toggleAllThinkingBlocks() function to toggle .open class on .thinking-block elements
- [x] 1.3 Prevent default browser behavior for the shortcut
- [x] 1.4 Verify only thinking blocks are affected (not tool/skill blocks)

## 2. E2E Test Implementation

- [x] 2.1 Create new test file e2e/thinking-blocks.spec.js
- [x] 2.2 Add test: thinking blocks are expanded by default
- [x] 2.3 Add test: Ctrl+O toggles thinking block expansion state
- [x] 2.4 Add test: Tool blocks are not affected by Ctrl+O shortcut

## 3. Verification

- [x] 3.1 Manual test: Start server and verify shortcut works in browser
- [x] 3.2 Run existing E2E test suite to ensure no regressions
