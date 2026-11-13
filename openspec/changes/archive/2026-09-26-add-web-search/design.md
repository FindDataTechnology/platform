# add-web-search — Design

## Context

See `proposal.md` for motivation. The load-bearing facts established during exploration:

- The repo already has the first-party-MCP pattern: `server/cron-mcp.js` (and `library-mcp.js`) are thin stdio MCP servers declared as `mcp.json` entries, mounted by `dsh-profile.js#writeMcpPatch()` as `mcp__<server>__<tool>`. But `mcp.json` is gitignored and excluded from the prod image (`.dockerignore`), so file-based declaration is not a zero-config path for customers.
- The zero-config path exists and is unused: `platform.bundle.json` `mcpServers` (validated by `bundle-manifest.js`, stdio or http shape) → `server.js#seedStartupMcpConfigs()` seeds an extension-store row with `origin: "bundled"` on every startup → `writeMcpPatch()` mounts it. Works identically in dev (repo-root manifest), packaged desktop (app-root manifest), and fresh cloud cells (per-user DB).
- Env transport to the MCP child is proven: cloud cells inherit the gateway process's `baseEnv`; `dsh-profile.js#buildScrubbedEnv()` scrubs only `LLM_API_KEY` refs, so anything else in the env reaches the dsh child and its stdio MCP subprocesses. `cron-mcp.js` already reads `HOST`/`PORT` this way.
- `documents.js#fetchUrlAsText()` already implements scheme allowlist, SSRF guard (`isPrivateHost`), corporate-proxy support (`proxyForUrl` + undici `ProxyAgent`), timeout, byte cap, and `htmlToText`. Duplicating any of that would be a drift hazard, especially the SSRF guard.
- Demo/sandbox budgets count prompts, not tool calls — there is no cell-side metering seam for search spend; cost control therefore lives relay-side (product decision: demo fully open).

## Goals / Non-Goals

**Goals:**

- Agent gets `mcp__websearch__web_search` (relay-backed) and `mcp__websearch__web_read` (local fetch) in every deployment form with zero customer action.
- The relay client is a dumb, stateless HTTP caller — all intelligence (key pool, rotation, failover, cache, caps) is operator-side.
- Graceful, explicit degradation when the relay is unconfigured/unreachable; `web_read` never depends on the relay.

**Non-Goals:**

- The relay service itself (implementation, deployment, key wiring) — operator-side deliverable; this change fixes only its client contract.
- Engine selection, per-result ranking knobs, images/news verticals — one query in, normalized results out.
- Miniprogram tool-event rendering (existing gap, backlog); search-specific UI in web (existing tool-use rendering suffices).
- Cell-side per-user search metering or billing.

## Decisions

### D1: Thin first-party stdio MCP client, not relay-as-remote-MCP

`server/websearch-mcp.js` (patterned on `cron-mcp.js`) exposes both tools; `web_search` calls the relay over REST. **Alternative rejected**: run MCP protocol on the relay and declare it in the bundle as an http entry (zero client code). Rejected because `web_read` needs local code anyway (fetch must use the deployment's egress, not the relay's), local policy seams (disable, discovery, future telemetry) are lost when the protocol session is dsh↔relay direct, and the relay would carry MCP SDK versioning it doesn't need.

### D2: Ship via `platform.bundle.json` — first user of the bundled-origin path

One stdio entry (`node server/websearch-mcp.js`, no `env` — secrets never in git). Seeded by `seedStartupMcpConfigs` on every form factor; Extensions-page disable/re-enable works through the normal DB row; tool-discovery picks the tools up like any MCP server. **Alternative rejected**: `mcp.json` entry (matches cron/library but is per-deployment operator config — exactly the customer burden this change removes). Demo/sandbox: no `requiredGroups`, no bundle permission — open to all (product decision; see Risks).

### D3: Config = `SEARCH_RELAY_URL` + `SEARCH_RELAY_TOKEN`, plain env vars

Dev: `.env` (supervisor injects). Desktop: settings.json → supervisor env injection (existing mechanism, same as `VOLCES_API_KEY`). Cloud: set on the gateway process → flows into every cell via `baseEnv`. Unset ⇒ `web_search` returns "not configured" without any network call. **Correction from live verification:** the vars reach the dsh child fine (`buildScrubbedEnv` only scrubs `LLM_API_KEY`), but dsh's subprocess layer re-scrubs credential-shaped names (`/KEY|PASSWORD|SECRET|TOKEN/i`) from MCP children — `SEARCH_RELAY_TOKEN` was stripped at that hop. The sanctioned path (dsh-subprocess's explicit per-entry `env`, merged after the scrub) is now used: the bundle entry declares `envRefs: [SEARCH_RELAY_URL, SEARCH_RELAY_TOKEN]` (names only, git-safe), and `writeMcpPatch` resolves them from `process.env` into the patch entry's `env` on every write — so token rotation lands on the next restart/HMR swap. **Alternative rejected**: `apiKeyEnv`-style catalog entry or `env` block in the bundle entry — both would either leak the token into git or invent a new config surface for one consumer.

### D4: Extract `fetchUrlAsText` into a shared leaf module (`server/web-fetch.js`)

Move `isPrivateHost`, `proxyForUrl`, `htmlToText`, the scheme check, timeout/byte-cap constants, and `fetchUrlAsText` itself out of `documents.js` into a dependency-free leaf module; `documents.js` re-imports (behavior unchanged); `websearch-mcp.js` imports the same function. **Alternative rejected**: slim re-implementation inside the MCP server — two SSRF guards that drift independently is exactly how the guard gets holes. `web_read` adds on top: a text-length cap (~50k chars) with an explicit truncation marker (spec requirement), and a slightly higher fetch timeout than documents' ingest path is acceptable but starts from the same constant.

### D5: Relay client contract

`POST {SEARCH_RELAY_URL}/v1/search`, header `Authorization: Bearer <SEARCH_RELAY_TOKEN>`, body `{ "query": string, "num": int? }` (default 8, relay clamps ≤10). Success: `200 { "results": [{ "title", "url", "snippet" }] }`. Failure: non-2xx with `{ "error": string }`, or transport failure. Client behavior: single attempt (retry/rotation is the relay's job), 15s timeout via `AbortSignal.timeout`, errors surfaced verbatim to the agent prefixed with context ("Search relay: …"); 401/403 ⇒ "not configured or unauthorized" phrasing. Tool output is the JSON of the normalized results as text content — deterministic, machine-parseable, no prose wrapping.

### D6: Tool schemas stay minimal

`web_search`: `{ query: string (required), num?: number }`. `web_read`: `{ url: string (required) }`. No engine/locale/region params — locale-sensitive ranking is the relay's concern (it can geo-infer or expose nothing). Fewer knobs = fewer wrong invocations; the tool-discovery layer already renders the schema.

## Risks / Trade-offs

- [Relay token is extractable from a packaged desktop app or any cell's env] → per-customer tokens with relay-side daily caps; revoking a customer = relay-side token disable, no platform release needed. Accept that a determined customer can use *their own* token's quota directly.
- [Demo fully open ⇒ search spend scales with demo traffic] → relay TTL cache (demo queries are highly repetitive) + per-token caps are the controls; if spend still misbehaves, gating demo via the DB row's `requiredGroups` is a config change, no code.
- [SerpAPI free-tier multi-key pooling may violate provider ToS] → operator-side decision; paid keys pooled for capacity/redundancy are normal. Platform is agnostic.
- [First real user of the bundled-seeding path in production] → e2e asserts the seeded row + effective roster; manual fallback is adding the same server to `mcp.json` (identical config shape).
- [`web_read` on slow/blocking sites stalls a turn] → bounded timeout, explicit error, model falls back to snippets from `web_search`.
- [Relay outage disables search fleet-wide] → relay-internal GLM fallback + ops monitoring; client-side there is deliberately nothing (no client retry storm).

## Migration Plan

1. Operator deploys the relay and issues tokens (independent of this repo).
2. Platform release ships the bundle entry; env vars set on gateway host / desktop settings. Search appears on next cell boot / app restart — no data migration (the extension-store seed row is created idempotently at startup).
3. Rollback: disable the websearch server via the Extensions UI per deployment, or remove the bundle entry in the next release. No persisted state beyond the standard seed row.

## Open Questions

- Relay deployment host & key inventory (operator; does not affect the client contract).
- GLM search API request/response specifics (relay-internal; resolved when the relay is built).
- Whether the relay should later also expose `/v1/read` for egress-uniform deployments (deferred; `web_read` stays local either way).
