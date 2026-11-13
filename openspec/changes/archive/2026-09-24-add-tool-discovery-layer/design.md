## Context

The effective dsh tool roster is assembled from built-in tools plus `dsh-mcp-client` tools whose public names are `mcp__<serverName>__<toolName>`. The live roster can exceed 190 tools, and current models receive all of their schemas in each request. The platform already has marketplace installation, role/credential filtering, MCP hot-swap, and skill materialization; it does not have a tool-name lookup or unknown-tool recovery path. The live failure mode is therefore name recall, not connectivity: the agent attempts names such as `mcp__list_concepts` or `mcp__find_data_business`, receives `UNKNOWN_TOOL`, and has no authoritative way to discover the exact effective name.

## Goals / Non-Goals

**Goals:**

- Make exact effective tool names discoverable from inside the agent conversation.
- Keep lookup scope-aware: it must reflect tools actually visible to the calling agent, including restrictions and MCP hot-swap changes.
- Recover deterministically from malformed MCP names without executing a suggested tool.
- Make vertical-pack skill instructions name their primary tools exactly.
- Keep the implementation local, read-only, and free of new long-lived state or network dependencies.

**Non-Goals:**

- No semantic registry-wide search and no `airegistry-tools` mount.
- No dynamic marketplace installation or MCP mounting from chat.
- No vector database, embedding service, or second LLM call.
- No change to MCP connection, authorization, credential, or execution behavior.
- No reduction or filtering of the model-facing tool roster merely to hide the naming problem.

## Decisions

### D1: Register `tool_search` as a first-class dsh tool

Add a small platform dsh plugin to the generated platform profile. The plugin injects the dsh tool registry and registers a read-only tool named `tool_search`.

At execution time the tool SHALL call the registry's schema projection for the calling agent's scope (`ctx.tools.schemas(exec.agent)` in dsh terms). That projection is the authoritative visible roster for that exact agent: global tools, scoped tools, MCP tools, restrictions, and code-mode transport details are already resolved by dsh. The search implementation projects only model-safe metadata (name, description, parameters) and never touches execution callbacks or credentials.

Why this source of truth:

- It cannot drift from the runtime because it reads the live registry at call time.
- It naturally follows MCP hot-swap and role/credential filtering already applied to the effective profile.
- It avoids a host-side persisted index and avoids inter-process synchronization with the dsh child.
- It cannot search unmounted registry entries because they are not in the registry.

Alternatives rejected:

- **Internal index MCP over stdio**: would duplicate the roster in another process and need a synchronization mechanism.
- **Host REST lookup exposed as an MCP**: would add network/auth topology for information the child already owns.
- **`airegistry-tools` / `search_registry`**: discovers registry assets, but cannot enumerate this user's effective tools and cannot execute them. It also violates the explicit scope decision.
- **Persistent SQLite tool index**: unnecessary long-lived state and risks stale entries after hot-swap.

### D2: Use deterministic lexical ranking, not semantic search

`tool_search` will normalize names and queries by lowercasing, replacing non-alphanumeric separators with spaces, removing the literal `mcp` prefix token, stripping wildcard characters, and tokenizing. Ranking will consider, in descending weight:

1. Exact normalized full-name match.
2. Exact leaf-tool match.
3. MCP server plus leaf-tool match.
4. Full-name token coverage.
5. Server-name match or boost when a server filter is supplied.
6. Description token overlap.
7. Parameter-property overlap for queries that look like field names.

Results will be capped (initial maximum 20) and include:

- exact callable name;
- `server` and `leaf` for MCP tools;
- built-in/local origin for non-MCP tools;
- short description;
- required parameter names and a compact property-name/type summary;
- a truncation flag.

This can be implemented synchronously and deterministically. It avoids embedding-model latency/cost and does not turn tool discovery into another probabilistic LLM step.

### D3: Enrich `UNKNOWN_TOOL` results from the current request roster

The host already receives dsh `request/header` notifications carrying the tool schemas used for the current model request. The platform will keep an ephemeral, per-turn effective-roster projection from those events and use it when translating a `tool/result` whose error is `ToolNotFoundError` / `UNKNOWN_TOOL`.

When an unknown-tool result arrives:

1. Read the attempted name from the corresponding `tool/call`.
2. Run the same deterministic matcher against the current request roster.
3. Append a bounded candidate list to the agent-facing result text before broadcasting and persisting it, for example:

```text
Error: unknown tool "mcp__list_concepts".
Exact effective-tool candidates:
- mcp__fd-open-data-mcp__list_concepts
- mcp__fd-find-data-business-mcp__list_concepts
Call one exact name. No candidate was executed.
```

4. If no plausible candidate exists, retain the unknown-tool error and add guidance to use `tool_search`; do not invent a substitute.

This is deliberately host-side: it avoids patching or monkey-patching the vendored dsh tool runtime while still reaching the model through the normal tool-result event. It also updates the persisted transcript with the same corrected guidance the user sees.

No automatic retry is performed. The model must make the next exact-name call itself.

### D4: Keep discovery metadata read-only and bounded

`tool_search` will never expose:

- MCP URLs or headers;
- registry credentials or token state;
- extension database records;
- tool execution callbacks;
- full unbounded schemas.

Unknown-tool enrichment will likewise carry only names and short metadata. Search output limits prevent a 160-tool roster from being converted into another oversized prompt response.

### D5: Vertical-pack skills move from wildcard intent to exact primary names

The four pack skill sources under `docs/vertical-packs/skills/` will be updated after enumerating the effective tool rosters for their pack servers. Each skill will keep a short "primary exact tools" section and retain intent-level fallback prose, but primary workflow steps will name tools like:

```text
mcp__fd-find-data-business-mcp__wb_search_indicators
mcp__fd-open-data-mcp__get_entity
```

rather than relying on `mcp__<server>__*` as the only instruction. If a listed tool is absent, the skill will direct the agent to state that the tool is unavailable and use `tool_search` only to check the current effective roster — not to guess a replacement.

Registry copies of these skills are updated through the existing registry content-management path after the repository source changes. This change does not add automatic registry synchronization.

## Risks / Trade-offs

- [A weak model may still skip `tool_search`] → The unknown-tool path supplies candidates after the first failed call, so recovery does not depend on perfect upfront tool selection. Tool descriptions will explicitly tell the agent to search before uncertain MCP calls.
- [`request/header` may arrive with a very large schema payload] → The host will retain only projected metadata needed for matching and candidate formatting, never the full raw header object.
- [MCP hot-swap can race with an in-flight turn] → The per-request roster is authoritative for the current turn; `tool_search` reads the live registry when called. A post-swap turn receives a new request roster.
- [Lexical search can rank a same-named leaf from the wrong server first] → Results retain server identity and duplicate-leaf entries are never collapsed. The model must use the exact full name.
- [Pack tool names can drift when a registry server changes] → Skills will phrase exact names as the preferred path and explicitly fail honest if a named tool is absent; they will not instruct substitution by similarity.
- [This overlaps the active vertical-pack documentation change] → Implementation should update the pack skill source files once against the current `add-vertical-sample-packs` state and keep this change limited to tool-name guidance.

## Migration Plan

1. Add the dsh tool-discovery plugin and include it in the generated platform profile patch set.
2. Add shared matching/ranking tests before wiring the host-side `UNKNOWN_TOOL` enrichment.
3. Update dsh event translation to project the current request roster and enrich only unknown-tool failures.
4. Enumerate current pack-server tools and update the four skill source documents with exact primary names.
5. Run focused unit/e2e tests, then deploy through the normal Jenkins → Harbor → GitOps path.
6. Rollback: remove/disable the generated tool-discovery patch and the unknown-tool enrichment; exact-name skill text can remain because it is harmless without the search tool.

## Open Questions

- The exact set of "primary" tools worth naming in each of the four pack skills. This is content selection, not architecture; resolve during implementation by probing the currently effective servers and keeping the list to the tools each demo path actually needs.
