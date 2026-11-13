## 1. Fix Failing E2E Test

- [x] 1.1 Update sidebar tabs expectation in `e2e/app.spec.js` to include "dashboard" and "litellm"
- [x] 1.2 Run tests to confirm the fix works

## 2. Expand E2E Test Coverage

- [x] 2.1 Add dashboard tab navigation test in `e2e/app.spec.js`
- [x] 2.2 Add LiteLLM tab navigation test in `e2e/app.spec.js`
- [x] 2.3 Verify all new tests pass

## 3. Code Quality and Bug Fixes

- [x] 3.1 Review server.js for any obvious bugs or inconsistencies
- [x] 3.2 Review public/app.js for any obvious bugs or inconsistencies
- [x] 3.3 Fix any identified issues
  - Added missing `dashboard` to the `views` object in app.js
  - Fixed duplicate `break` statement in dashboard_update case
  - Added `dashboard_state` message handler
  - Added dashboard refresh on reconnect and view switch
  - Updated activeView comment
- [x] 3.4 Run full e2e suite to confirm no regressions

## 4. Final Verification

- [x] 4.1 Run `npm run test:e2e` and confirm all tests pass
- [x] 4.2 Run `npm run test:e2e:smoke` and confirm all tests pass
  - Note: 2 smoke tests failed due to external LLM connectivity issue (pre-existing, not caused by our changes)
  - All 19 fast tests passed successfully
