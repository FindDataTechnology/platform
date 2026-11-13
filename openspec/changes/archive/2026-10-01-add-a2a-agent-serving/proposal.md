# Proposal: add-a2a-agent-serving

## Why

A pack role (persona + skills + MCP references) has exactly one execution target today: the subscriber's cell, running as a preset switch inside the shared dsh runtime — one active persona per deployment at any moment, no way to serve it as a standing service. We need a protocol (the serving contract) so that a pack role following it deploys directly as a standing Agent Service callable by any A2A client, with the self-hosted mcp-gateway-registry (upstream ≥1.27 ships first-class A2A agents and a reverse-proxy gateway; prod runs 1.29.x–1.30.0) as the distribution and auth plane. Decision record: ADR-0004. Glossary: 服务契约（Serving Contract）, Agent 服务（Agent Service）.

## What Changes

- **Pack manifest v2**: `agents[]` entries gain an optional `serving` block (the serving contract: A2A capability-card declaration + auth scheme). Absent → v1 validation applies verbatim; present → the role is deployable as an Agent Service. Model and endpoint fields stay out of the protocol.
- **Deploy action**: marketplace gains a 「部署为服务」 button + API (creator/admin gated, idempotent). The action pushes the pack's skills as registry skill entries, composes an AgentCard plus a deployment descriptor and registers a registry agent entry (`supported_protocol: "a2a"`, `metadata` carries only the small descriptor), and the runner discovers it by polling (≤5 min to effective; UI shows 「部署中→在线」).
- **agent-runner** (new service): multi-tenant runtime on a tailnet host via docker-compose. One dedicated dsh child per role (reusing the dsh-profile composition machinery, private DSH_HOME), idle-reaped after 30 minutes, cold-started on the next message, bounded concurrency with queueing. Exposes A2A: `/.well-known/agent-card.json` + JSON-RPC `message/send` + `message/stream` (SSE), text-only parts in v1. Runner-level default model; inference burns the runner's service quota. MCP outbound uses the runner's service credential (weekly renewal).
- **Lifecycle**: upgrade = in-place version swap with old-child drain (existing sessions run to completion or 5-minute timeout); undeploy = an independent action (stop child + delist the registry entry) — pack unpublish does not cascade, it warns; rollback = redeploy an old version (versions are immutable).
- **Inbound auth**: through the registry's A2A reverse proxy (any valid registry caller token with the `invoke_agent` grant; the gateway injects the agent's backend credential to prevent bypass). Ops preconditions: upgrade prod registry to ≥1.30.0, fold the hand-patched Logto nginx conf into the regenerable template, enable `A2A_REVERSE_PROXY_ENABLED`, add the runner host to the SSRF allowlist.
- **paas consumption**: `mapAgent()` in registry-bridge maps `supported_protocol` (currently dropped); the catalog gains `mode: "a2a"` entries; chatting with one takes the remote branch (no preset switch, no shared-dsh restart, history still stored in the cell session). Implementation order sits behind add-session-ownership / perf-session-open / fix-agent-workspace.

Non-goals: file/chart A2A artifacts (v1.1), push notifications, A2A extensions, registry group gating for callers (v2, via upstream `allowed_groups`), fixing the upstream M2M accounts (backlog), per-agent model selection.

## Capabilities

### New Capabilities

- `a2a-agent-serving`: serving-contract semantics and the Agent Service lifecycle — the deploy action (registry-native composition: skill entries + agent entry), polling propagation, drain-on-upgrade, no-cascade undeploy, redeploy rollback.
- `agent-runner`: the multi-tenant runtime — child lifecycle (one per role, idle reaping, bounded concurrency with queueing), the A2A adapter surface (card + send + stream, text-only), contextId↔dsh session mapping, health, runner-level default model and service credential.

### Modified Capabilities

- `pack-authoring`: "Agents are persona entries" gains the optional serving contract — persona-only validation is unchanged when `serving` is absent; when present the block is validated (`card.skills` capability declarations are path-isolated from the pack's skill files, same word different meaning), and endpoint/model/credential fields remain forbidden.
- `agent-catalog`: entry types gain `mode: "a2a"`; registry-sourced a2a agents map to that mode; chatting with an a2a entry streams over the A2A protocol on the remote branch (no preset switch, no shared-runtime restart).
- `registry-market-deployment`: registry agent ingestion changes — `supported_protocol == "a2a"` entries map to `mode: "a2a"` catalog entries carrying the gateway route URL, instead of plain link entries.

## Impact

- **Code**: `lib/pack-manifest.js` (serving validation), `gateway/packs.js` + `server/routes/packs.js` (deploy action), `registry-bridge.js` (mapAgent mapping), `catalog.js` (a2a mode), `server/agent-session.js` (A2A client branch — sequenced behind the three in-flight changes), a new agent-runner service reusing the `dsh-profile.js` / `dsh-bridge.js` / `skill-materialize.js` composition machinery, web UI (deploy button, two-state status, a2a badge).
- **External systems**: the cheap1 registry upgrades to ≥1.30.0 and enables the A2A reverse proxy; SSRF allowlist gains the runner host; the Logto nginx hand-patch is folded into the regenerable template; the runner gets a new tailnet host (docker-compose).
- **Ops**: runner service credential weekly-renewal runbook (same cadence as `MARKET_REGISTRY_TOKEN`); DEPLOY.md gains the runner runbook; ADR-0004 already records the architecture.

## Open questions to resolve before implementation

1. cheap1: current `A2A_REVERSE_PROXY_ENABLED` state and the registry upgrade path (reconciling the host-mounted conf with nginx regeneration).
2. Upstream skills write API (CRUD paths; skill-entry `visibility`/`allowed_groups` capability).
3. Size cap on the agent entry's `metadata` (`agent_models.py`).
4. Whether default-minted gateway tokens carry the `invoke_agent` grant (#1434 `{agent,actions}` scopes).
5. The Logto nginx hand-patch folding approach (host mount → template).
