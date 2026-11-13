# Agent Cluster Platform Proposal

## Why

Users want to discover, install, and operate **groups of cooperating agents** as a single unit — not just individual agents or skills in isolation. Current capabilities (custom presets, pack marketplace, A2A serving) each solve part of this problem but lack a unified "cluster" abstraction that enables:
- **Shareable agent clusters**: Pre-defined multi-agent solutions that can be published and subscribed like packs
- **Dynamic cluster assembly**: Users can combine multiple pack agents into ad-hoc clusters at runtime
- **Cluster-aware scheduling**: Tasks that coordinate execution across multiple agents in a cluster
- **Model/harness selection**: Per-agent model binding and user override for flexible deployment

This change unifies the existing building blocks (packs, presets, A2A services) under a coherent cluster-first mental model.

## What Changes

### New Capabilities
- **Pack-as-cluster-template**: Packs gain optional `cluster` metadata declaring their agent composition and relationships
- **Marketplace cluster views**: Pack detail pages show contained agents; browse/search supports cluster-level filtering
- **Dynamic cluster composer**: UI/API for users to assemble custom clusters from multiple pack agents at runtime
- **Cluster-aware scheduling**: Enhanced scheduling tools support cluster context, parallel execution policies, and cross-agent task coordination
- **Per-agent model binding**: Deploy-time and runtime model selection per agent, with provider routing and user override

### Modified Capabilities
- **pack-marketplace**: Add cluster metadata display, agent count badges, and bulk install progress
- **custom-presets**: Add "convert to pack draft" action for sharing compositions (already exists, clarified as cluster→pack bridge)
- **agent-catalog**: Mark pack-sourced agents with `clusterId` for cluster-aware discovery
- **agent-scheduling-tools**: Extend task schema with `clusterId`, `executionPolicy`, and aggregate results

### Breaking Changes
- None in MVP phase; all changes are additive or backward-compatible

## Capabilities

### New Capabilities
- `agent-cluster-core`: Core cluster abstraction, pack manifest extensions, catalog marking
- `marketplace-cluster-view`: Marketplace UI enhancements for cluster visibility and browsing
- `dynamic-cluster-composer`: Runtime cluster assembly API and UI
- `scheduling-cluster-aware`: Enhanced scheduling tools with cluster context
- `model-binding-per-agent`: Per-agent model configuration and provider routing

### Modified Capabilities
- `pack-marketplace`: Display cluster metadata, add agent count badges, bulk install flow
- `agent-catalog`: Add `clusterId` marker to pack-sourced agents
- `agent-scheduling-tools`: Extend task schema with cluster fields

## Impact

### Affected Code
- **gateway/packs.js**: Pack manifest validation, cluster metadata handling
- **server/routes/custom-presets.js**: Convert preset to pack draft action
- **web/src/pages/AgentsPage.tsx**: New cluster composer UI, enhanced marketplace views
- **web/src/lib/packs-api.ts**: Bulk install API, dynamic cluster assembly endpoints
- **lib/pack-manifest.js**: Manifest schema extension for cluster metadata

### APIs
- **New**: `POST /api/clusters/dynamic` — create dynamic cluster from selected agents
- **New**: `GET /api/clusters/:id` — get cluster status and member agents
- **New**: `POST /api/clusters/:id/schedule` — schedule cluster-wide task
- **Modified**: `GET /api/catalog` — add `clusterId` field to pack-sourced entries
- **Modified**: `POST /api/jobs` — accept `clusterId` and `executionPolicy` in task creation

### Dependencies
- **Existing**: `pack-marketplace`, `custom-presets`, `a2a-agent-serving`, `agent-scheduling-tools`
- **New**: No external dependencies; all implementation within paas repo

### Systems
- **Cell-local**: Dynamic clusters run in user's cell via existing DSH runtime
- **Fleet**: Deployed A2A agents leverage existing fleet scheduler and runner assignment
- **Marketplace**: Pack registry (facet service) unchanged; only display layer enhanced

---

**Phased Rollout**:
- **Phase 1 (MVP)**: Pack-as-cluster-template + marketplace views (2 weeks)
- **Phase 2 (Core)**: Dynamic cluster composer + bulk install (4 weeks)
- **Phase 3 (Advanced)**: Cluster-aware scheduling + model binding (3 weeks)
