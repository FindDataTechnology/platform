## Why

The Extensions Store tab ships a catalog of 7 MCP servers, but only **one** new server (`sequential-thinking`) works without the user typing in a secret or a path — `memory` is already installed, `puppeteer` drags down Chromium, and the other four (`filesystem`, `sqlite`, `github`, `postgres`) need a token or path the user must hand-edit into a raw placeholder string like `your_token_here`. So in practice the marketplace offers ~1 usable server, which is why it feels like "nothing possible to use." At the same time, 6 e2e tests covering the core MCP/skills add/toggle/install/delete UI flows are `test.skip` because the flows didn't work end-to-end — so the management UI that *does* work has no automated coverage.

## What Changes

- **Catalog: add genuinely zero-config servers.** Add `@modelcontextprotocol/server-fetch` (fetch any URL), `@modelcontextprotocol/server-time` (time/timezone), and `@modelcontextprotocol/server-everything` (demo/test) to `market-catalog.json`. None require a secret or a path.
- **Catalog: surface zero-config first + needs-config badge.** Reorder the catalog so no-config servers list first; derive a "needs config" / "ready to use" badge per server from whether `configTemplate.env` or placeholder args are present, and render it on the market card.
- **Install UX: per-field setup form, not a placeholder string.** Replace the current "prefill the form with `your_token_here` / `/path/to/...` and let the user edit it" flow with a setup form generated from `configTemplate`: one labeled field per `env` key (with a "where to get this" link where known) and one labeled path field per placeholder arg. The Add button stays disabled until required fields are filled. The form is data-driven from the template, not hardcoded per server.
- **E2E: enable + fix the 6 skipped tests** in `e2e/extensions.spec.js` covering add-MCP-via-form → delete, toggle MCP enable/disable, install-MCP-from-Store, install-opens-prefilled-form, add-custom-skill → delete, and toggle-skill. Making them pass means the underlying React flows must actually work (card appears after add, toggle persists, install-from-store lands in Installed, delete removes).

## Capabilities

### New Capabilities
<!-- None — all three capabilities already exist. -->

### Modified Capabilities
- `extension-marketplace`: catalog gains zero-config servers; servers are ordered with ready-to-use first; each catalog entry carries a derived config-requirement badge.
- `extension-management-ui`: the MCP add/install form becomes a data-driven per-field setup form generated from `configTemplate`, with validation gating Add; install-from-market prefills that form by field rather than as a raw placeholder string.
- `e2e-testing`: the suite gains enabled (no longer skipped) coverage for the MCP/skills add → delete, toggle enable/disable, and install-from-market flows.

## Impact

- `market-catalog.json` — add 3 servers, reorder, (no schema change; badge is derived).
- `extension-store.js` `getMarketCatalog()` — derive a `requiresConfig` flag per server from `configTemplate.env` and placeholder args.
- `web/src/components/extensions/MarketTab.tsx` — render ordering + badge.
- `web/src/components/extensions/McpMarketCard.tsx` — render the ready-to-use / needs-config badge.
- `web/src/components/extensions/McpServerForm.tsx` — data-driven per-field setup form from `configTemplate` (env-key fields + path fields + validation).
- `web/src/lib/extensions-api.ts` — add `requiresConfig` to the `MarketMcpServer` type.
- `e2e/extensions.spec.js` — unskip the 6 tests; fix flows they exercise.
- `web/src/locales/*` — strings for new badges/field labels (i18n convention).
- No backend API contract changes; `/api/extensions/market` already returns the catalog and the existing API tests stay green.
