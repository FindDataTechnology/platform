# Assembly-time capability check

When a pack is installed, its manifest declares `mcpServers[].registryName` (+ optional
`allowTools`). That is a claim. This check verifies the claim against the
capability catalog before `installPack` writes anything: a referenced
`(server, tool)` must hit a real serving edge, and must fall inside the
assembler's own capability range.

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

## Read contract

paas is Node, the catalog is Python; the check reaches the catalog through a
subprocess to the `capability-catalog` CLI:

| env | meaning |
|---|---|
| `CAPABILITY_CATALOG_CMD` | the CLI command (default `capability-catalog`) |
| `CAPABILITY_CATALOG_DB` | the catalog SQLite path |

It reads two things: `serving` (capability → `[[server, tool], ...]`, for the
reference hit test) and, when a governor is supplied, `resolve` (the governor's
effective capability set, for the range test). A catalog that cannot be reached
is **fail-closed** in `enforce` mode (refuse) and a visible degrade in `warn`
(logged, never silent).

## Failure semantics

- **admin / no governor** (full visibility): a bad ref is reported precisely —
  `server.tool not found in catalog` vs `server.tool outside governor's range`.
- **governed caller** (has a capability range): both collapse into one opaque
  `unavailable` — the check must not reveal whether a capability the caller may
  not use exists at all (`capability-resolution` "unperceivable").

## Where it runs

`server/routes/packs.js`, in the install path: after `validatePackManifest`
(structure) and `mcpBudgetRefusal`, before `installPack`. So a refused pack
materializes zero bytes — same acceptance rule as the budget gate.
