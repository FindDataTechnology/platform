## 1. Model Switching E2E Tests

- [x] 1.1 Create e2e/model-selection.spec.js with test structure
- [x] 1.2 Add test: model selector loads models and reflects active model
- [x] 1.3 Add test: switch model via UI selector
- [x] 1.4 Add test: switch model via /model command
- [x] 1.5 Add test: invalid model id shows error
- [x] 1.6 Run model switching tests and fix any bugs discovered

## 2. Document Chat (RAG) E2E Tests

- [x] 2.1 Create e2e/document-chat.spec.js with test structure
- [x] 2.2 Add test: query document collection returns an answer with sources
- [x] 2.3 Add test: empty collection query returns empty answer
- [x] 2.4 Mark document chat tests as @smoke project
- [x] 2.5 Run document chat tests and fix any bugs discovered

## 3. Verification

- [x] 3.1 Run full existing test suite to verify no regressions
- [x] 3.2 Verify npm run test:e2e runs model tests without LLM
- [x] 3.3 Verify npm run test:e2e:smoke includes document chat tests
