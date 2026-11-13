## Context

The Extensions page already has a Store tab backed by `market-catalog.json` (7 MCP servers) + `market-catalog-skills.json` (5 skills), served by `extension-store.js getMarketCatalog()` at `/api/extensions/market`, rendered by `MarketTab.tsx` / `McpMarketCard.tsx` / `SkillMarketCard.tsx`. The backend CRUD (`extension-store.js` over `db.js`) works — the API e2e tests pass. Two gaps:

1. **Catalog offers almost nothing usable out of the box.** 4 of 7 MCP servers need a secret or path; only `sequential-thinking` is a new zero-config server (`memory` is already installed, `puppeteer` drags Chromium). Clicking **Install** on a needs-config server calls `McpServerForm` with `initialConfig = configTemplate`, which prefills the raw fields — including placeholder strings like `your_token_here` inside a JSON `env` textarea and `/path/to/allowed/directory` inside the `args` text field. The user must hand-edit JSON and path strings.
2. **6 UI e2e tests are `test.skip`.** They cover add-MCP → delete, toggle MCP, install-from-store, add-skill → delete, toggle-skill. The API layer is covered; the React flows are not.

## Goals / Non-Goals

**Goals:**
- Make the Store tab offer ≥4 genuinely zero-config MCP servers (today: 1 new).
- Make needs-config servers installable through a real form, not placeholder-string editing.
- Enable the 6 skipped e2e tests and make them pass.

**Non-Goals:**
- Remote registry fetching (the spec mentions it; not wired today, leave it).
- Per-env-key help text / "where to get this" links as a schema field (defer; see D4).
- Fixing the 3 unrelated pre-existing flakes (documents-react upload/delete, LiteLLM iframe) — out of scope, noted in memory.
- Rebuilding the manual-add raw form — it stays for power users.

## Decisions

### D1. Derive `requiresConfig` server-side in `getMarketCatalog()`
Add a `requiresConfig: boolean` to each served `MarketMcpServer` entry, derived in `extension-store.js` (not authored per-entry in JSON — avoids a schema migration of every catalog row). Rule:

```
requiresConfig =
  hasEnvKeys(configTemplate.env)
  || (configTemplate.args || []).some(a =>
       /\/path\//.test(a) || /^your_/.test(a) || /^<.*>$/.test(a))
```

This flags `filesystem` (`/path/to/allowed/directory`), `sqlite` (`/path/to/database.db`), `github` (`your_token_here` env), `postgres` (env conn string) as needs-config; leaves `memory`, `sequential-thinking`, `puppeteer`, and the 3 new servers as ready-to-use. Add `requiresConfig` to the `MarketMcpServer` TS type. The existing e2e API test gets an assertion on the known split.

**Alternative considered:** author a `requiresConfig` boolean per JSON entry. Rejected — every future catalog edit must remember to set it; derivation from the template that already encodes the need is DRY and matches "the template is the source of truth."

### D2. Setup-form mode in `McpServerForm`, triggered by the full `MarketMcpServer`
`MarketTab` currently passes only `initialConfig={configTemplate}`. Change it to pass the full `MarketMcpServer` (`setupServer` prop). When `setupServer` is present, `McpServerForm` renders a **per-field setup form** generated from `configTemplate`:

- **Name** — prefilled from `setupServer.name`, editable (must be unique).
- **Help block** — `setupServer.installInstructions` shown as muted text at the top.
- **For each `configTemplate.args` entry:** if it's a placeholder (matches the D1 rule), render a labeled text input (label = the placeholder, e.g. "/path/to/allowed/directory"); otherwise render it as a read-only literal chip (`-y`, `@modelcontextprotocol/server-...`).
- **For each key in `configTemplate.env`:** render a labeled text input (label = the env key, e.g. `GITHUB_PERSONAL_ACCESS_TOKEN`), prefilled empty, placeholder = the template's placeholder value.
- **Add button** disabled until every placeholder field is non-empty.
- On submit, reconstruct `config = { command, args: [...literals + ...filled], env: { ...filled } }` preserving template order, then call `addMcpServer`.

When `setupServer` is **absent** (manual "Add MCP" or "Edit"), the existing raw form (command/args-text/env-JSON/url/headers-JSON) is unchanged.

**Alternative considered:** replace the raw form entirely with the data-driven one. Rejected — the raw form handles arbitrary configs (e.g. a user-pasted `mcp.json` snippet) that no template describes; keeping it is the smaller, safer diff.

### D3. Placeholder-arg detection rule (same as D1)
An arg is "fillable" iff `/\/path\//.test(a) || /^your_/.test(a) || /^<.*>$/.test(a)`. Everything else is a literal. This is the same predicate as `requiresConfig`'s arg half — extract one helper, use in both places, so they cannot drift.

### D4. No per-key help schema; `installInstructions` is the help
The catalog has one `installInstructions` string per server. Per-env-key help would need a new schema field (`env: { KEY: { placeholder, helpUrl } }`). That's over-engineering for 4 needs-config servers — the env key name (`GITHUB_PERSONAL_ACCESS_TOKEN`) is already self-documenting, and `installInstructions` already says where to get the token. Show `installInstructions` as a help block above the fields. **Defer** per-key help until there's a server where the key name alone is insufficient.

### D5. Order ready-to-use servers first, server-side
Sort `getMarketCatalog()` output so `requiresConfig === false` entries come first, then alphabetical. This makes the contract hold regardless of JSON file order. Also hand-order `market-catalog.json` with the 3 new zero-config servers at the top for readability. Both are cheap; the sort is the source of truth.

### D6. Unskip e2e by fixing the React flows (discover-and-fix)
Remove `test.skip` from the 6 tests, run `npm run test:e2e`, fix what breaks. The backend is proven (API tests pass), so the work is in the React components + testids. Known shape to verify during implementation:
- `McpServerCard` / `SkillCard` must expose the testids the tests assert (`mcp-toggle`, `mcp-disabled-badge`, `skill-card`, the delete button) and use whatever confirm pattern the tests drive (`page.on("dialog", d => d.accept())` assumes a native `confirm()` — if the cards use a custom `Dialog`, either keep native `confirm()` as the simplest path or rewrite the test to click the custom dialog's confirm button).
- install-from-store must land on the Enabled tab with the new card visible.
- toggle must persist (the `PATCH /enable` round-trip) and flip the disabled badge.

This is genuinely discover-during-implementation; tasks.md encodes it as "unskip, run, fix iteratively."

## Risks / Trade-offs

- **[Derivation rule is fragile to future catalog edits]** → A server whose placeholder doesn't match `/path/|your_|<...>` would be mislabeled ready-to-use. Mitigation: documented rule + an e2e assertion pinning the known split; the rule covers every current entry. Accept.
- **[npx fetches the package on first connect]** → The 3 new servers (`fetch`, `time`, `everything`) need `npx` to download on first run (network, slow). Not a new risk — `memory` already does this and works. e2e disables real connects, so tests don't hit it.
- **[Setup-form arg reconstruction]** → Splicing filled values back into literal positions could break if an arg appears twice or order matters. Mitigation: preserve template arg order; replace only detected-placeholder positions; the known templates have one placeholder each.
- **[E2E confirm-dialog assumption]** → If cards use a custom Dialog, the `page.on("dialog")` pattern in skipped tests won't work as-is. Mitigation: verify in D6; prefer native `confirm()` (one line, no new component) unless a custom dialog already exists.

## Open Questions

- Should the manual "Add MCP" button also offer the data-driven form when a template is pasted? **Decided: no** — manual add stays raw; setup form is market-install-only.
- Per-env-key help links? **Deferred** (D4) — revisit when a server's key name is insufficient.
