## 1. Matching core

- [x] 1.1 Create a pure tool-discovery module that parses dsh tool schemas into `{ name, server, leaf, origin, description, required, properties }` records; verify with unit tests covering built-in tools and `mcp__<server>__<tool>` parsing.
- [x] 1.2 Implement separator-normalization, wildcard stripping, tokenization, server filtering, deterministic relevance ranking, duplicate-leaf retention, and a bounded result limit; verify ranking unit tests for exact full name, leaf-only match, malformed `find_data-business` input, server-scoped GDP search, unrelated no-match, and truncation.
- [x] 1.3 Verify the matcher never mutates its input and returns no candidate when no normalized token overlap is credible; include adversarial tests for empty input, bare `mcp__`, wildcard-only input, and duplicate leaf names from multiple servers.

## 2. Agent-facing `tool_search`

- [x] 2.1 Add the platform dsh plugin that registers a read-only `tool_search` tool and derives results from the calling agent's live tool-schema projection; verify a fake-registry unit test sees only tools visible in that scope.
- [x] 2.2 Define `tool_search` parameters (`query`, optional `server`, optional `source`, bounded `limit`) and a compact result renderer that prominently states the exact callable name; verify unit tests for parameter validation, result shape, and maximum result count.
- [x] 2.3 Wire the plugin into the generated platform profile patch set without changing existing MCP, skill, preset, or permission patches; verify profile-generation tests show the plugin entry exactly once and a dsh child starts successfully with the new patch.
- [x] 2.4 Verify `tool_search` is read-only by asserting a call returns metadata only and leaves a captured tool registry, extension configuration, MCP patch, and credential store byte-for-byte unchanged.

## 3. Unknown-tool recovery

- [x] 3.1 Project dsh `request/header` tool schemas into an ephemeral current-turn roster, retaining only matching metadata and discarding raw schemas after projection; verify malformed/missing headers degrade gracefully without breaking turn translation.
- [x] 3.2 Correlate `UNKNOWN_TOOL` / `ToolNotFoundError` results with the preceding `tool/call`, run the shared matcher, and append bounded exact-name candidates before broadcast and persistence; verify synthetic event tests for missing server segment, malformed server fragment, and no-candidate cases.
- [x] 3.3 Ensure suggestion text explicitly states that no candidate was executed and that the next call must use an exact full name; verify persisted tool blocks contain the same enriched text shown over WebSocket.
- [x] 3.4 Add e2e coverage that a malformed MCP tool attempt does not auto-invoke a candidate, emits an error with the expected exact candidate name, and allows a following exact-name call path to proceed normally.

## 4. Vertical-pack exact tool guidance

- [x] 4.1 Enumerate the current effective tools for `fd-find-data-business-mcp`, `fd-open-data-mcp`, `fd-cn-report`, and `law-bench`, and record the small primary-tool set needed by each of the four pack demo workflows; verify the inventory names full callable names rather than wildcard patterns.
- [x] 4.2 Update `legal-contract-workflow`, `legal-case-workflow`, `stock-research-workflow`, and `china-macro-brief-workflow` source skills with exact primary tool names plus honest-unavailable fallback guidance; verify content tests reject wildcard-only primary instructions and missing-server-segment names.
- [x] 4.3 Update the registry copies of the four skills through the existing content-management path; verify each registry skill-content response contains the expected exact names and no stale wildcard-only primary instruction.

## 5. Integration and rollout verification

- [x] 5.1 Add focused tests proving discovery covers only effective tools: a disabled, role-gated, credential-omitted, or never-installed registry server does not appear, and `airegistry-tools` is neither installed nor mounted by discovery; verify the extension DB and effective MCP patch remain unchanged.
- [x] 5.2 Run lint, focused unit/e2e suites, and the full fast e2e suite; record any pre-existing known flakes separately from failures caused by this change.
- [x] 5.3 Verify live behavior after rollout: `tool_search` appears in the request roster, malformed `mcp__list_concepts` returns the expected exact candidate, an exact-name MCP call succeeds, and no marketplace/runtime mutation occurs during discovery.
