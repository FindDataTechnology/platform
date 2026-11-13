## 1. Server-side LiteLLM Direct Model Fetch

- [x] 1.1 Add fetch function to get models from LiteLLM /v1/models endpoint
- [x] 1.2 Modify `list_models` handler to use LiteLLM fetch when configured
- [x] 1.3 Add fallback to model registry when LiteLLM fetch fails
- [x] 1.4 Remove previous LiteLLM model filtering logic

## 2. Remove Command List UI

- [x] 2.1 Remove command list button and popup DOM elements from index.html
- [x] 2.2 Remove command list popup JavaScript code from app.js
- [x] 2.3 Remove command list button variable and event listeners
- [x] 2.4 Remove command list popup styles from style.css

## 3. Verify and Test

- [x] 3.1 Test /model chat command still works (code path unchanged)
- [x] 3.2 Test bottom-left model selector still works (code path unchanged)
- [x] 3.3 Verify model list comes from LiteLLM /v1/models when configured (implemented in server.js)
