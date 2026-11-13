# add-web-search — Tasks

## 1. Shared web-fetch module

- [x] 1.1 Extract `fetchUrlAsText`, `isPrivateHost`, `proxyForUrl`, `htmlToText`, and the timeout/byte-cap constants from `documents.js` into a new dependency-free leaf module `server/web-fetch.js`; `documents.js` re-imports with behavior unchanged; verify the documents URL-ingest e2e still passes and `grep` shows a single definition of each helper

## 2. websearch MCP server

- [x] 2.1 Create `server/websearch-mcp.js` (patterned on `server/cron-mcp.js`: stdio, stdout reserved for JSON-RPC): `web_search` tool calling `POST {SEARCH_RELAY_URL}/v1/search` with Bearer auth, `{query, num?}` body, 15s `AbortSignal.timeout`, single attempt, normalized `{results:[{title,url,snippet}]}` JSON returned as tool text; verify a `tools/list` + `tools/call` round-trip against a stubbed relay shows both tools and normalized output
- [x] 2.2 Implement `web_read` on the shared `server/web-fetch.js` fetch with a ~50k-char text cap and explicit truncation marker; verify an https test page returns extracted text (not raw HTML), an oversized page returns truncated text with marker, `ftp://`/`javascript:` and private/loopback hosts are refused with explicit errors and no fetch
- [x] 2.3 Degradation paths: unset `SEARCH_RELAY_URL`/`SEARCH_RELAY_TOKEN` → "search not configured" error without any network call; relay 5xx / transport timeout → bounded explicit error ("Search relay: …"); verify both via the stub harness and confirm `web_read` still succeeds while the relay is down
- [x] 2.4 Input validation: `num` clamped to 1..10 (default 8), empty query rejected, `web_search`/`web_read` reject wrong-typed args with structured errors; verify invalid calls create no relay request and no fetch

## 3. Bundling, config, and seeding

- [x] 3.1 Add the `websearch` stdio entry (`node server/websearch-mcp.js`, no `env` block — secrets never in git) to `platform.bundle.json` `mcpServers`; verify with a fresh `PLATFORM_DATA_DIR` that `seedStartupMcpConfigs` seeds an `origin:"bundled"` row, `writeMcpPatch` mounts it, and the effective roster shows `mcp__websearch__web_search` / `mcp__websearch__web_read`
- [x] 3.2 Add `SEARCH_RELAY_URL` / `SEARCH_RELAY_TOKEN` to the Electron `SETTING_KEYS` allowlist (`electron/config/settings.js`) so packaged-desktop settings.json reaches the backend env; verify a packaged-mode settings.json value lands in the server child's env and an unset pair degrades per 2.3
- [x] 3.3 Verify cloud transport needs no code: set both vars on the gateway process env and confirm they reach a spawned cell and its MCP child (`buildScrubbedEnv` passes them through); record the gateway-host env requirement in DEPLOY.md
- [x] 3.4 Document the relay client contract for the operator (request/response shape, Bearer auth, error semantics, cache/cap expectations) in `.env.example` + DEPLOY.md; verify the documented contract matches the client in 2.1 exactly

## 4. E2E and verification

- [x] 4.1 e2e (Playwright harness, stub relay): a fresh cell boots with both tools in the roster; a chat turn that triggers `web_search` renders results through the existing tool-use rendering and the turn completes; verify against the e2e seam with the relay stub returning fixture results
- [x] 4.2 e2e degradation: with the relay unconfigured, `web_search` renders as an explicit unavailability tool error and the turn still completes; `web_read` against a served local test page still succeeds in the same session
- [x] 4.3 Extensions round-trip: disable the bundled websearch server via the extensions surface → tools leave the roster and tool-discovery results; re-enable → tools return after the profile regeneration/restart; verify via the Extensions UI flow or its REST route
- [x] 4.4 Full pre-archive pass: `openspec validate add-web-search`, run the complete relevant e2e set, and confirm zero regressions against the existing extension/tool specs

## 5. Live-verification fix (found driving a real turn)

- [x] 5.1 Forward the relay pair through dsh's MCP-child env scrub: dsh-subprocess strips TOKEN-shaped names from MCP children, so `SEARCH_RELAY_TOKEN` never reached the websearch child ("not configured" on a live turn); the bundle entry now declares `envRefs` (names only, git-safe) and `writeMcpPatch` resolves them into the patch entry's explicit `env` on every write; verify the generated patch carries the pair and a real chat turn returns real search results
- [x] 5.2 Fresh-baked /opt/dsh-home boot crash (found rolling sha-5a501b0 to prod): writePresetsPatch skipped the bridge FILE along with the roster on an unresolvable preset root, leaving platform-permission-bridge.js (unconditional overlay) importing a missing file — dsh crash-looped at boot; the bridge is now written unconditionally and resolveShippedPresetRoot gained the image's /opt/dsh install as a third anchor (roster survives fresh pods); verified by hot-patching the live pod (dsh stable 3min+) pending the fix image
