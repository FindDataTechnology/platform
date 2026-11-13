## Why

The live agent can have 160+ MCP tools mounted and callable, but it has no way to search that effective roster or recover from a malformed tool name. Weak models then invent names such as `mcp__list_concepts` instead of calling the registered `mcp__fd-open-data-mcp__list_concepts`, producing `unknown tool` errors even though the intended tool is available. Vertical-pack skills also describe tool groups with wildcard-like wording, which is not directly callable and reinforces those malformed names.

## What Changes

- Add an effective-tool discovery index for the current dsh runtime, covering every tool visible to the agent in the current request roster, including built-in tools and MCP tools.
- Expose that index to the agent as a small read-only discovery surface so it can resolve intent or a partial name to the exact callable tool name before invoking a tool.
- Normalize and rank malformed/partial tool-name lookups, including names missing the MCP server segment, leaf-name-only lookups, separator mistakes, and unknown wildcard forms.
- Add deterministic unknown-tool candidate suggestions to the agent-facing tool error path so a failed call can name likely alternatives instead of returning only `unknown tool`.
- Update vertical-pack entry skills to state exact callable names for their primary mounted tools, while retaining intent-level fallback guidance when a server or tool is unavailable.
- Keep discovery scoped to tools already mounted in the effective runtime profile. It SHALL NOT mount, install, proxy, or execute `AI Registry tools`, and it SHALL NOT add registry-wide dynamic MCP discovery in this change.

## Capabilities

### New Capabilities

- `tool-discovery`: Maintain a searchable index of the effective agent tool roster, expose read-only tool lookup to the agent, return useful candidates for unknown tool calls, and require pack guidance to use exact callable names for primary workflows.

### Modified Capabilities

(none — MCP mounting, marketplace installation, registry credentials, and skill hot-loading requirements remain unchanged. This change adds a discovery layer over the already-effective tool roster.)

## Impact

- **Runtime/tool bridge**: derive and refresh an effective-tool index from the dsh request/tool roster; provide a read-only lookup mechanism available alongside built-in tools.
- **Tool error handling**: enrich unknown-tool failures with deterministic candidates without masking genuine mistakes or executing anything.
- **Vertical-pack content**: revise the four entry skill sources under `docs/vertical-packs/skills/` to name primary tools exactly.
- **Tests**: unit tests for indexing/ranking/candidate suggestions and e2e coverage for malformed MCP tool-name recovery.
- **Explicit non-goals**: no `airegistry-tools` installation or mounting, no semantic search of the registry catalog, no dynamic MCP installation from chat, and no change to MCP authorization or execution semantics.
