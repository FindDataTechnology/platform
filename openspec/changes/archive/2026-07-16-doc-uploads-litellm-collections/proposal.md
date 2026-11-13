## Why

The platform currently accepts only PDF, Markdown, plain text, and URL uploads, so users with `.docx`, `.csv`, `.html`, `.pptx`, or `.json` content have no way to ingest it - and non-PDF/non-Markdown files dropped or pasted are silently mis-classified as Markdown and garbled. The model selector and `/model` command derive their list from the SDK's model registry, which can drift from the live LiteLLM proxy (models added via the LiteLLM admin UI do not appear without a restart) and gives the client no single authoritative source. Finally, documents are a flat list with no grouping, so users cannot organize documents into reusable sets or query a subset.

## What Changes

- **Expand uploadable file types** via `@llamaindex/readers` (already a dependency). Add support for `.docx`, `.csv`, `.html`/`.htm`, and `.json` across both ingestion paths - the Documents-tab file picker and the chat-window drag-and-drop / clipboard paste. Extracted text is fed into the existing PageIndex → SQLite pipeline. Unsupported types are now **rejected explicitly** (HTTP 415 / clear error) instead of being silently treated as Markdown.
- **Source the model list from the LiteLLM API.** When LiteLLM is configured, the server fetches `GET ${LITELLM_BASE_URL}/v1/models` (OpenAI-compatible) and uses the returned ids as the authoritative model list for the model selector and for validating/autocompleting the `/model` command. The list reflects the live proxy state (newly added models appear without a server restart). `pi --list-models | grep litellm` was used during design to confirm the pi-agent recognizes exactly these models (`deepseek-chat`, `volc-coding-deepseek-v4-flash`, `volc-coding-deepseek-v4-pro`, `volc-coding-glm-5.2`). Falls back gracefully when LiteLLM is unreachable or unconfigured.
- **Add document collections.** Users can create, list, rename, and delete named collections; add/remove documents to/from a collection; list a collection's documents; and query within a collection (retrieve over that collection's `ready` documents only). Collections persist in the project SQLite database (`collections` + `collection_documents` tables). A Collections UI is added to the Documents tab.

## Capabilities

### New Capabilities
- `document-collections`: Grouping documents into named collections and querying per collection (create / list / rename / delete / add-remove documents / list members / query within a collection).

### Modified Capabilities
- `document-management`: Expand accepted ingestion types to include `.docx`, `.csv`, `.html`/`.htm`, and `.json` parsed via LlamaIndex readers; explicitly reject unsupported types instead of silently classifying them as Markdown. The query endpoint gains the ability to scope retrieval to a collection (cross-references `document-collections`).
- `model-selection`: When LiteLLM is configured, the model list is sourced from the LiteLLM proxy's `/v1/models` endpoint (live, authoritative) rather than the SDK model registry, and the selector and `/model` command validate against that list.

## Impact

- **Code - backend**: `pageindex-bridge.js` (or a new `readers.js` adapter) adds LlamaIndex-reader-based text extraction for the new types; `documents.js` updates extension→type mapping and returns a clear error for unsupported types; `server.js` updates the `/api/documents` upload route's type inference, replaces the `list_models` source with a LiteLLM `/v1/models` fetch, and adds `/api/collections/*` routes; `db.js` adds `collections` and `collection_documents` tables (schema migration) plus typed helpers; `migrate.js` needs no legacy-collection import (collections are new).
- **Code - frontend**: `public/index.html` widens the file-picker `accept`; `public/app.js` updates drag-drop/paste type inference, renders the Collections UI, and populates the model selector (and `/model` autocomplete) from the LiteLLM-sourced list.
- **Dependencies**: `@llamaindex/readers`, `@llamaindex/openai`, and `llamaindex` are already in `package.json`. Some readers require optional peer dependencies (e.g. `mammoth` for `.docx`); these will be added as needed during implementation.
- **APIs**: new `/api/collections/*` endpoints; `/api/documents` accepts additional types and may return HTTP 415 for unsupported ones; `/api/models` (the `list_models` WS handler) returns the LiteLLM-sourced list when configured.
- **Specs**: new `document-collections` spec; delta specs for `document-management` and `model-selection`.
- **Graceful degradation preserved**: when LiteLLM is unreachable, the model list falls back to configured-provider models; when the DB is unavailable, collections are disabled and the server starts normally.
