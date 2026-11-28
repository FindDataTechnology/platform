# Assembly-time MCP-reference check

When a pack is installed, its manifest declares `mcpServers[].registryName` (+ optional
`allowTools`). That is a claim. This check verifies it before `installPack` writes
anything: every declared tool must exist on the referenced server.

Change: `wire-capability-catalog-into-pack-assembly`.

## Switch

| env | default | effect |
|---|---|---|
| `CAPABILITY_CHECK_MODE` | `off` | `off` = check never runs (install byte-for-byte unchanged); `warn` = check runs, failures logged, install proceeds; `enforce` = failures refuse with 409 `capability-unavailable` |

`off`/unset/anything-else is treated as skip (`activeCheckMode` returns null and
`capabilityCheckRefusal` returns null on its first line, before any I/O) — the
switch being off is a hard guarantee of prior behavior, not a best effort.

Ships **off**. Turn on `warn` first and watch the log line
`[packs] capability check (warn): ...` over a real install window; only flip to
`enforce` once that window shows no false positives on existing packs.

## Authority: the registry server index

A pack reference is a SERVICE reference — `(server, tool)` on an MCP server. The
authority is the registry's server index (`registryServerIndex()`), the same
source `lib/publish-tool-gate.js` validates publishes against.

Measured 2026-11-23 against all 104 live packs that declare `mcpServers`:

| authority | packs refused |
|---|---|
| capability catalog | **104 / 104** — a category error: it knows semantic capabilities (concept/indicator/graph), not servers |
| registry server index, every unknown name refused | 51 / 104 — most refs are to bundled or local-binding servers |
| registry server index, unknown names exempt (shipped) | **30 / 104** — all 30 are genuine |

The 30 genuine failures are packs declaring `wire-build-mcp.wire_artifact_doc_create`
/ `wire_artifact_dashboard_create`, tools the **deployed** image (sha-4ae7809)
predates — confirmed twice: absent from the registry's stored `tool_list` and
absent from a live `tools/list` through the gateway. The source has them
(commit `86d634a`); prod does not. That is exactly what an assemble-time gate
is for.

### Local-binding exemption

A `registryName` that is **not** in the index is a local-binding reference
(`chatwoot`, `fleet-architect`, `fd-memory`, `actions-mcp` … — bundled or
in-cell servers whose surface is knowable only inside the cell). It is exempt,
exactly as the publish gate exempts it. Absence of the name is not evidence
that the tool is absent.

What the check CANNOT prove: a local-binding ref's tool names. Those ride as
the local contract, unchanged from today.

## Read contract

`loadIndex` is the only seam. The route passes `() => registryServerIndex()` —
authenticated, 60s-cached, already used by the publish gate. A fetch failure is
**fail-closed** in `enforce` (refuse) and a visible degrade in `warn` (logged,
never silent). A successful-but-empty index (registry knows nothing) refuses
nothing: no verdict is invented.

## Failure semantics

A refusal names the `server.tool` and the pack, and the message says the server
does not expose it — not that the pack is malformed:

```
Pack references MCP tools the referenced server does not expose: wire-build-mcp.wire_artifact_doc_create not exposed by that server
```

## Where it runs

`server/routes/packs.js`, in the install path: after `validatePackManifest`
(structure) and `mcpBudgetRefusal`, before `installPack`. So a refused pack
materializes zero bytes — same acceptance rule as the budget gate.

## Range (not this check)

The governor's capability RANGE — which semantic capabilities a principal may
use — is the capability catalog's question (`resolve_for`), wired through the
catalog MCP. It is a separate concern from "does this MCP tool exist" and is
not enforced by this check; see `lib/capability-catalog-client.js`.
