# Agent Cluster Platform - Technical Design

> **归档对账（2026-10-22）**：本文保留立项时的设计意图。实施与四轮生产验证后，**Decision 4（provider 路由层）被推翻**——
> 平台的模型真源是 sub2api/词元车道，部署侧三闸（白名单/车道/roster）已由 serving 车道工作建成，再造路由层=复制车道；
> Decision 5 的"并行"按运行时事实落定为「本地 persona 恒串行、仅 a2a 成员并行，摘要如实注记」。
> 最终行为以主 spec（agent-cluster-core / dynamic-cluster-composer / marketplace-cluster-view / scheduling-cluster-aware
> 及 pack-marketplace / agent-catalog / agent-scheduling-tools 的 MODIFIED 段）为准，逐任务证据见 tasks.md。


## Context

The platform currently has three separate capabilities:
1. **Custom presets** (cell-local, user-composed)
2. **Pack marketplace** (shareable, versioned capability bundles)
3. **A2A agent serving** (deploy packs as remote services)

These capabilities overlap in function but lack a unified mental model. Users discover packs, install them, then manually compose agents into sessions — there's no first-class "cluster" abstraction that represents a group of cooperating agents.

Existing infrastructure to leverage:
- `pack-marketplace` spec already defines pack schema, publish/subscribe flows
- `custom-presets` spec already defines resource composition and focused mode
- `a2a-agent-serving` spec already defines deployment lifecycle and A2A protocol
- `agent-catalog` already supports merged catalog from multiple sources
- `agent-scheduling-tools` already provides MCP scheduling tools

## Goals / Non-Goals

**Goals:**
- Define cluster as a first-class citizen alongside packs and agents
- Enable shareable cluster templates via pack metadata
- Support dynamic cluster assembly at runtime without publishing
- Provide cluster-aware task scheduling and execution
- Enable per-agent model binding with provider routing

**Non-Goals:**
- Redefine existing pack or preset capabilities (only extend them)
- Implement multi-harness support (DSH-only for MVP)
- Build a new orchestration engine (leverage existing DSH runtime)
- Support cross-cell cluster sharing (clusters are cell-local)

## Decisions

### Decision 1: Pack as cluster template (not new cluster format)

**Choice**: Use existing pack manifest as the vehicle for declaring cluster templates. Add optional `cluster` field to pack schema.

**Rationale**:
- Reuses existing publish/subscribe/versioning infrastructure
- No new storage format needed
- Creators can publish clusters without learning new schema
- Backward compatible: non-cluster packs render unchanged

**Alternatives considered**:
1. **New `cluster.yaml` format**: Separate from packs
   - Pros: Cleaner separation of concerns
   - Cons: New publishing flow, new versioning, duplication of pack metadata
   
2. **Hybrid approach**: Packs can be clusters OR standalone agents
   - Pros: Flexible
   - Cons: Confusing mental model (is this a pack or a cluster?)

**Chosen approach**: Pack-as-cluster-template because it leverages existing creator workflows and marketplace infrastructure with minimal friction.

### Decision 2: Dynamic clusters as ephemeral session-bound objects

**Choice**: Dynamic clusters are created at runtime, bound to sessions, and auto-terminated after inactivity. They are NOT published or versioned.

**Rationale**:
- Fits exploration/use-case: users want to try combinations before committing
- Avoids marketplace spam: no need to publish every ad-hoc combination
- Resource-efficient: auto-termination prevents accumulation of unused clusters

**Alternatives considered**:
1. **Persistent dynamic clusters**: User-created clusters stored indefinitely
   - Pros: Can share between sessions
   - Cons: Storage overhead, cleanup complexity, potential for orphaned clusters
   
2. **Shareable dynamic clusters**: Allow users to publish dynamic clusters
   - Pros: Community sharing
   - Cons: Requires new "dynamic pack" format, validation complexity

**Chosen approach**: Ephemeral session-bound clusters because they solve the immediate need (try combinations) without over-engineering. If users want to share, they can convert to pack drafts (existing flow).

### Decision 3: Catalog-level cluster marking, not new entity type

**Choice**: Mark pack-sourced agents with `clusterId` in the agent catalog; do NOT create a separate "cluster" entity type in the catalog.

**Rationale**:
- Minimal change to existing catalog mechanism
- Agents remain the primary unit of selection; clusters are organizational
- Enables cluster-aware UI grouping without changing WebSocket protocol

**Alternatives considered**:
1. **Cluster-first catalog**: Catalog returns clusters, not agents
   - Pros: Clean cluster abstraction
   - Cons: Major protocol change, breaks existing clients
   
2. **Dual-layer catalog**: Agents AND clusters returned separately
   - Pros: Explicit cluster entities
   - Cons: Duplication, synchronization complexity

**Chosen approach**: Catalog-level marking because it's the least invasive way to enable cluster-aware discovery while preserving backward compatibility.

### Decision 4: Provider routing layer for model binding

**Choice**: Implement a provider routing layer that maps model IDs to provider endpoints with automatic fallback.

**Rationale**:
- Solves the "model selection" requirement without UI clutter
- Automatic fallback improves reliability (one provider down → use another)
- Billing attribution works transparently

**Alternatives considered**:
1. **UI-only model selection**: Users manually choose providers per agent
   - Pros: User control
   - Cons: UX burden, users don't understand provider differences
   
2. **Hardcoded provider mapping**: Each model ID maps to one provider
   - Pros: Simple
   - Cons: No fallback, single point of failure

**Chosen approach**: Provider routing with fallback because it balances automation and reliability. The UI shows "which model" is used, not "which provider" — providers are an implementation detail.

### Decision 5: Sequential vs parallel execution policy

**Choice**: Default to sequential execution for cluster tasks; allow parallel execution as an opt-in policy.

**Rationale**:
- Sequential is safer: results are deterministic, easier to debug
- Parallel introduces race conditions and ordering ambiguity
- Most cluster use cases don't need parallelism (agents typically coordinate sequentially)

**Alternatives considered**:
1. **Always parallel**: All cluster agents run concurrently
   - Pros: Faster execution
   - Cons: Non-deterministic results, harder to trace
   
2. **Configurable per-task**: No default, must specify
   - Pros: Explicit
   - Cons: UX friction, users won't read docs

**Chosen approach**: Sequential default with opt-in parallel because it matches most users' mental model (agents work together in sequence) while allowing power users to optimize for speed.

## Risks / Trade-offs

### Risk 1: Dynamic cluster proliferation

**Problem**: Users create many dynamic clusters that are never used, accumulating technical debt.

**Mitigation**: 
- Auto-termination after 24h idle (or 7 days absolute)
- Usage metrics visible in cluster management UI
- Warning events before deletion

### Risk 2: Pack manifest bloat

**Problem**: Adding `cluster` metadata could make pack manifests complex and error-prone.

**Mitigation**:
- Optional field: packs without it work unchanged
- Validation at publish time: reject malformed cluster metadata
- Marketplace UI guides creators through cluster declaration

### Risk 3: Model routing complexity

**Problem**: Provider fallback adds latency and makes debugging harder ("why did it use tencent instead of volces?").

**Mitigation**:
- Log `providerUsed` in usage metrics for every turn
- Session header shows effective model (not provider)
- Error messages name the final provider used

### Risk 4: Cluster agent conflicts

**Problem**: Two different packs might declare the same agent id, causing confusion when both are installed.

**Mitigation**:
- Existing shadowing rules apply (custom presets > packs > registry)
- Catalog marks each agent with its source `clusterId`
- Picker UI shows pack name next to agent name for disambiguation

### Risk 5: Bulk install UX fragility

**Problem**: Installing 10 agents from a cluster could fail mid-way, leaving partial state.

**Mitigation**:
- Progress modal shows individual agent status
- Cancellation rolls back all partially-installed agents
- Success report clearly lists what was installed

## Migration Plan

### Phase 1: MVP (2 weeks)
1. Update `lib/pack-manifest.js` to accept `cluster` field
2. Add `clusterId` marker to catalog response for pack-sourced agents
3. Enhance marketplace UI to display cluster metadata
4. Deploy with feature flag `CLUSTER_VIEWS_ENABLED=true`

### Phase 2: Core (4 weeks)
1. Implement `POST /api/clusters/dynamic` endpoint
2. Build Cluster Composer UI component
3. Add bulk install progress modal
4. Deploy with feature flag `DYNAMIC_CLUSTERS_ENABLED=true`

### Phase 3: Advanced (3 weeks)
1. Extend scheduling tools with cluster fields
2. Implement provider routing layer
3. Add per-agent model binding to deploy form
4. Remove feature flags, enable for all users

### Rollback Strategy
- Feature flags allow incremental rollout; disable problematic features immediately
- Dynamic clusters are ephemeral; disabling them causes no data loss
- Pack manifest changes are additive; old packs continue to work
- Provider routing degrades gracefully if unavailable (use hardcoded mappings)

## Open Questions

### Q1: What should be the default `maxConcurrentRuns` for cluster tasks?

**Current design**: Default to 1 (sequential), allow up to 10.

**Considerations**:
- Lower default = safer, but may surprise power users
- Higher default = faster, but risks resource contention

**Recommendation**: Keep default at 1; document how to increase it in cluster metadata.

### Q2: Should dynamic clusters support persistence across restarts?

**Current design**: No; clusters are ephemeral and re-created on session start.

**Considerations**:
- Persistent = can share between sessions, but adds storage complexity
- Ephemeral = simpler, but requires re-selection each session

**Recommendation**: Start ephemeral; add persistence later if users request it.

### Q3: How should we handle agent id collisions between packs?

**Current design**: Existing shadowing rules apply; catalog marks source clusterId.

**Considerations**:
- Shadowing is well-understood behavior
- But users may not expect two packs to define the same agent

**Recommendation**: Add warning during install: "Pack B defines agent 'X' which is also in Pack A; Pack A's version will be used".
