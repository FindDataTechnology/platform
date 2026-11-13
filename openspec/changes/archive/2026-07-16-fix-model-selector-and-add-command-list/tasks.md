## 1. Server-side Model Filtering

- [x] 1.1 Add `litellmLoaded` flag tracking when LiteLLM extension is registered (used existing `litellmEnabled` flag)
- [x] 1.2 Modify `list_models` handler to filter LiteLLM models when configured
- [x] 1.3 Add helper function to detect if a model is LiteLLM-routed

## 2. Frontend Command List UI

- [x] 2.1 Add command list button next to the model selector in index.html
- [x] 2.2 Implement command list popup component in app.js
- [x] 2.3 Populate command list with slash commands and available models
- [x] 2.4 Make model items clickable to trigger `set_model`

## 3. Model Selection UX Improvements

- [x] 2.5 Ensure model selector reflects active model after selection from command list
- [x] 2.6 Add visual feedback when model is changed (toast notification)
- [x] 2.7 Test end-to-end: command list opens, models are clickable, model switch works (server running at localhost:3000)
