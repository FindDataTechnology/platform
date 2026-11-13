# agent-cluster-core Delta: mcpServers 上限

## MODIFIED Requirements

### Requirement: Pack manifest supports cluster metadata

Each pack MAY declare a top-level `cluster` object:

```yaml
cluster:
  name: string            # Human-readable cluster name (required, ≤500 chars)
  description: string     # Cluster description (required, ≤500 chars)
  defaultAgents: string[] # Agent ids activated by default (non-empty)
  optionalAgents?: string[] # Additional members available but not default
  schedulingPolicy?: { maxConcurrentRuns?: number }  # positive integer ≤10
```

The `cluster` field is OPTIONAL; packs without it are ordinary packs. When present: `name` and `description` MUST be non-empty; `defaultAgents` MUST be non-empty and reference only agent ids declared in the pack's `agents` array; `optionalAgents` MUST reference declared agents and MUST NOT repeat `defaultAgents`; `schedulingPolicy.maxConcurrentRuns` MUST be a positive integer ≤10. Publishing SHALL reject a malformed `cluster` block naming the offending field. The pack-level limits (agents ≤3, mcpServers ≤6, skills ≤10) apply unchanged — a cluster pack is a small-team template; larger teams are assembled as dynamic clusters. Those three counts are market POLICY, so they SHALL be operator-configurable at the deployment (`PACK_MAX_AGENTS` / `PACK_MAX_MCP_REFS` / `PACK_MAX_SKILLS`), read per publish so a running market retunes without a restart; the numbers above are the defaults, and an invalid override SHALL fall back to the default rather than disable the ceiling. Character and byte caps stay fixed — they are abuse guards, not policy. Member agents keep their focused resource sets through the existing per-role `resources` declaration (openspec: pack-agent-scoping), so a bundled team never widens a member's tool face.

#### Scenario: Valid cluster metadata accepted

- **WHEN** a pack manifest includes a well-formed `cluster` object
- **THEN** publish and `/api/packs/validate` accept it and the metadata is stored alongside the manifest

#### Scenario: Missing required fields rejected

- **WHEN** a pack manifest declares `cluster.name` but omits `cluster.description` or `cluster.defaultAgents`
- **THEN** validation fails naming the missing field

#### Scenario: Invalid agent reference rejected

- **WHEN** `cluster.defaultAgents` or `cluster.optionalAgents` names an agent id not declared in the pack's `agents`
- **THEN** validation fails naming the offending agent id

#### Scenario: Excessive concurrency limit rejected

- **WHEN** `cluster.schedulingPolicy.maxConcurrentRuns` is not a positive integer ≤10
- **THEN** validation fails naming the field

#### Scenario: MCP reference ceiling admits six servers

- **WHEN** a pack manifest declares exactly six `mcpServers` entries
- **THEN** publish and `/api/packs/validate` accept it
- **WHEN** a pack manifest declares seven `mcpServers` entries
- **THEN** validation fails naming the limit

#### Scenario: Operator retunes a policy ceiling

- **WHEN** the deployment sets `PACK_MAX_MCP_REFS=8` and a pack declares eight `mcpServers`
- **THEN** publish and `/api/packs/validate` accept it, with no code change and no restart
- **WHEN** the override is not a positive integer (empty, `0`, `-1`, `abc`)
- **THEN** the default ceiling applies — an invalid override never disables the limit
