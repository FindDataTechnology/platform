# Tasks — dsh-llm-models-page

## 1. Profile patch layer
- [x] 1.1 In `dsh-profile.js`, add `readProviders()` that parses the current `settings.yaml` and returns the list of providers as `{ id, name, baseUrl, hasKey, type, models }[]`
- [x] 1.2 Add `writeProviderPatch(action, provider)` to `dsh-profile.js` that mutates `$DSH_HOME/settings.patch.yaml` (atomic temp-file + rename) and returns the new effective list
- [x] 1.3 On startup, `dsh-profile.js` loads the patch file (if present) and merges it over the env-driven base before passing the effective settings to dsh
- [x] 1.4 Add a startup log line listing the source of each provider (env vs patch)

## 2. dsh restart with patch
- [x] 2.1 In `dsh-bridge.js`, extend `restart({ profilePatchPath })` to accept a patch path; the next child spawn reads the merged settings
- [x] 2.2 Add `dshBridge.deleteSession(id)` (called from chat-history delete in change A; exported for reuse)
- [x] 2.3 Add a `restartPending` flag in the dsh bridge so concurrent `set_model` WS calls during a restart get a 409 with "restart in progress" — not a tear-down
- [x] 2.4 Ensure the active chat session's persisted-on-disk id is used so it resumes cleanly after restart

## 3. Server REST endpoints
- [x] 3.1 In `server.js`, mount `/api/llm/providers` with GET, POST handlers
- [x] 3.2 Add PUT and DELETE handlers for `/api/llm/providers/:id`
- [x] 3.3 Add `POST /api/llm/providers/:id/test` (lightweight GET probe, 5s timeout, sanitized error)
- [x] 3.4 Add `GET /api/llm/default` and `PUT /api/llm/default` (default pointer; no restart)
- [x] 3.5 Add a module-level async mutex (`writeMutex`) around the write paths; concurrent writes return 409
- [x] 3.6 Add WS `models` broadcast on provider add/edit/remove so the sidebar model chip updates
- [x] 3.7 Never log or echo the API key; sanitize error messages from the test endpoint

## 4. Models page (UI)
- [x] 4.1 Create `web/src/pages/ModelsPage.tsx` (replaces the ModelsPagePlaceholder from change A)
- [x] 4.2 Create `web/src/components/llm/ProviderCard.tsx` (name, type, baseUrl truncated, hasKey indicator, connection status, model list, action buttons)
- [x] 4.3 Create `web/src/components/llm/ProviderForm.tsx` (Add/Edit dialog with name, type, baseUrl, apiKey fields; empty apiKey on Edit means "keep current")
- [x] 4.4 Create `web/src/components/llm/TestConnectionButton.tsx` (button that calls the test endpoint, shows latency or error)
- [x] 4.5 Create `web/src/components/llm/ModelList.tsx` (list of discovered model ids with Set-as-default action)
- [x] 4.6 Add the Add provider button at the top of the page
- [x] 4.7 Add the delete confirmation dialog (reuses the existing confirmation pattern)
- [x] 4.8 Show a "Settings updated — reloading…" toast on every successful write (so the user knows the restart is happening)

## 5. Sidebar model chip
- [x] 5.1 In `web/src/components/Sidebar.tsx`, replace the model `<select>` with a read-only chip showing the current model id
- [x] 5.2 On click, the chip navigates to `/models` (no model-switch WS message)
- [x] 5.3 The chip updates from the WS `current_model` / `model_changed` events as before
- [x] 5.4 Add i18n key `sidebar.modelChipHint` ("Manage models →")

## 6. i18n
- [x] 6.1 Add `modelsPage.title`, `modelsPage.providers`, `modelsPage.addProvider`, `modelsPage.editProvider`, `modelsPage.deleteProvider`, `modelsPage.testConnection`, `modelsPage.setDefault`, `modelsPage.confirmDelete`, `modelsPage.keyPlaceholder`, `modelsPage.keyMasked`, `modelsPage.settingsUpdated`, `modelsPage.restartFailed` to all 5 locales
- [x] 6.2 Add `modelsPage.lastTest.never` (no test yet), `modelsPage.lastTest.ok` ("OK"), `modelsPage.lastTest.failed` ("Failed")

## 7. Tests
- [x] 7.1 Unit-test `dsh-profile.js` `readProviders()` and `writeProviderPatch()` (round-trip, atomic write, merge order)
- [x] 7.2 Unit-test the test endpoint's sanitizer (key not in error message, body truncated)
- [x] 7.3 E2E: add a provider, see it in the list, test connection, set as default, delete
- [x] 7.4 E2E: edit a provider's apiKey (empty field = unchanged) and verify the hasKey flag does not flip
- [x] 7.5 E2E: clicking the sidebar model chip navigates to /models
- [x] 7.6 Negative test: delete the only provider returns 409
- [x] 7.7 Concurrent-edit test: two simultaneous writes; second returns 409
