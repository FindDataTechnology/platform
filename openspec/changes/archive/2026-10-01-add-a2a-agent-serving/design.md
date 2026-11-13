# Design: add-a2a-agent-serving

## Context

Pack roles today have one execution target: the subscriber's cell, as a generated preset inside the single shared dsh child (`dsh-profile.js` composes persona/skills/MCP patches; one active persona per deployment). The self-hosted mcp-gateway-registry (upstream ≥1.27; prod between 1.29.0 and 1.30.0) already stores A2A AgentCards as first-class agent entries (`POST /api/agents/register`, `supported_protocol`, `metadata`, `visibility/allowed_groups`), can proxy A2A traffic at `/agent/{path}/` behind `auth_request` with backend-credential injection, and distributes skills via its skills API. Why we are doing this: see proposal.md — Why. What must hold: see the five delta specs. The architectural choice (multi-tenant runner + registry as runtime source) is recorded in ADR-0004; the glossary terms are 服务契约（Serving Contract）and Agent 服务（Agent Service）(CONTEXT.md).

## Goals / Non-Goals

Goals: one composition pipeline (the existing `dsh-profile` machinery) serving two execution targets — in-cell presets unchanged, standalone Agent Services new; registry as the only runtime-facing distribution plane; no changes to dsh itself beyond existing patch mechanisms.

Non-Goals (design-level): multiple runner instances or autoscaling (single instance, bounded children); per-caller identity at the runner (gateway's job); file/chart artifacts, push notifications, A2A extensions (v1.1+); per-agent model selection; fixing upstream M2M accounts (backlog); MP (miniprogram) UI for deployed agents.

## Decisions

### D1 — The serving contract rides the pack manifest (v2), not a separate envelope

An optional `serving` block on `agents[]` entries; absent ⇒ v1 validation verbatim. Alternatives: a separate `agent-bundle.json` envelope (rejected: duplicates publish/versioning/subscriptions machinery; loses "one role, two execution targets"), or relaxing persona-only rules generally (rejected: the in-cell consumer must stay endpoint/model-free). Validation lives in `lib/pack-manifest.js` as today, enforced at gateway publish and cell install; the runner re-validates the descriptor it pulls. `card.skills` capability declarations are namespaced under the contract — never confused with the pack's skill files.

### D2 — One multi-tenant runner, one dedicated dsh child per role (ADR-0004)

A new `agent-runner/` service in this repo (Node, sibling of `gateway/`), shipped as its own image built from the same base as the platform image (dsh + patches available), deployed via docker-compose on a tailnet host with memory headroom — not the 4GB prod node. Per role: private `DSH_HOME`, composition via the existing `deriveScope`-style path against the deployment descriptor (persona + skill files materialized from registry skill entries + MCP patches resolving registry credentials), then a `DshBridge`-managed child over stdio JSON-RPC. Rejected: serving from the platform gateway (single-active-persona ceiling; external traffic competes with user sessions) and per-agent k8s deployments (N× memory and deploy ceremony — ADR-0004 lists them).

### D3 — Registry-native composition for the bundle

The deploy action never ships the raw manifest to the registry. It pushes each pack skill as a registry skill entry under a pack-scoped path (`packs/<packId>/<skill>`) with restricted visibility, and registers one agent entry whose `metadata` carries only the deployment descriptor: persona (≤16k), MCP references (registry names), skill paths, and the serving contract — all small fields, dodging custom-entity 50k-text limits entirely (custom entities are not used). Alternative rejected: stringify the full manifest into a custom-entity text field — pack skills can total ~650k chars; it doesn't fit and it duplicates the skills plane. Open sub-question (verification): skill-entry write API shape and `visibility/allowed_groups` support upstream.

### D4 — Deploy is an idempotent marketplace action; propagation by polling

`POST /api/packs/:id/versions/:v/deploy` (creator/admin gated, mirrors `PACK_CREATOR_GROUPS` + admin) on the gateway + cell route; idempotent per (pack version, agent id): skill entries upserted, agent entry PUT in place. The runner polls `GET /api/agents` on a TTL like the existing bridge (`MARKET_REGISTRY_TTL_SECS` precedent), ≤5 min to effective. No webhook dependency (upstream has none we rely on); the deploy response carries the expected-effective window and the UI derives 「部署中→在线」 from the agent entry's health status.

### D5 — A2A adapter: card + `message/send` + `message/stream`, text-only, contextId↔session

The runner terminates HTTP per agent at `<route>/.well-known/agent-card.json` + a JSON-RPC endpoint. `contextId` maps 1:1 to a dsh session on that role's child (sessions within a child are cheap; persona/skills/MCP are child-level constants). Turn results are text parts only; the served card equals the registered card (both composed from the same deploy payload). Unsupported methods return JSON-RPC `-32601`. We implement against the current stable subset (card at `agent-card.json`, send/stream); A2A's 1.0 roadmap may add surface, but this subset is the interoperability floor.

### D6 — Inbound auth rides the registry reverse proxy; ops preconditions first

Prod registry code has the A2A gateway (≥1.27) but it is flag-off (unverified) and pre-1.30.0 (agent-card route bug #1724/#1734). Preconditions, in order: upgrade cheap1 registry to ≥1.30.0; fold the 2026-09-19 hand-patched Logto nginx conf into the regenerable template (the hand patch sits exactly where `AGENT_LOCATION_BLOCKS` regeneration writes — it must survive regeneration); set `A2A_REVERSE_PROXY_ENABLED=true` (+ `DEPLOYMENT_MODE=with-gateway`); add the runner host to `SSRF_ALLOWED_HOSTS/CIDRS`. The runner then validates only the gateway-injected backend credential (per-agent constant) and rejects direct calls. Caller authz (`invoke_agent` grant) is the gateway's `/validate`. Alternative rejected: runner-direct with self-minted tokens — contradicts the "any valid registry token" caller policy and loses per-agent authz/audit.

### D7 — Lifecycle: in-place upgrade with drain, independent undeploy, redeploy rollback

Upgrades PUT the same agent entry with a new descriptor; the runner marks the old child draining (new messages → new child; in-flight turns finish or 5-min timeout kills), never two public entries. Undeploy is explicit (stop child, delist entry and pack-scoped skills); unpublish only warns. Rollback = deploy an old version — version immutability does the rest.

### D8 — Runner-level default model; MCP outbound on the service credential

The runner's dsh children use the runner's LLM gateway config (same `llm-default.json`/gateway pattern as a deployment); inference burns the runner's quota. MCP outbound resolves `credentialRef: "registry"` against one runner service token, renewed weekly (same runbook rhythm as `MARKET_REGISTRY_TOKEN`; TTL 168h). Model/credential fields stay out of the contract (v1).

### D9 — paas consumption: `mode:"a2a"` entries + an A2A client remote branch, sequenced last

`registry-bridge.js` `mapAgent()` maps `supported_protocol === "a2a"` → `{mode: "a2a", url: gatewayRoute}` (today the field is dropped and everything becomes link). `catalog.js` serializes the new mode. `server/agent-session.js` gains the A2A client branch as a sibling of the OpenAI-compatible remote fork (card cached per entry; `message/stream` when the card advertises streaming; parts → existing `text`/`done`/`error` events; history replay mirrors the fork's bounded replay). All `server/agent-session.js` work lands **after** add-session-ownership / perf-session-open / fix-agent-workspace — they rewrite the same file.

### D10 — Runner placement and resource policy

docker-compose on a tailnet host (chosen for headroom; k8s migration later if agent count grows). Child idle reap at 30 min; concurrent-child cap configurable (start 4–8 by host memory); capacity queues rather than evicts; `/health` reports per-agent child states (starting/serving/draining) for the registry's health checks. Cold start costs one dsh boot (~5–10 s) on the first message after reap — accepted for the standing-service use case.

> **Staging corrections (2026-09-30, verified live on cheap1):** the registry's A2A proxy (1.30.0, #1734) maps `/agent/{path}/**` onto the registered URL's ORIGIN and drops its path — one agent per origin. The runner therefore serves each agent on its own port (`agentPortFor(registryPath)`, shared helper with the deploy side). And the gateway does NOT inject a backend credential: it strips the caller's `X-Authorization` after `/validate` and forwards the caller's standard `Authorization` end-to-end — so the runner's credential check is the A2A out-of-band secret this deployment's clients carry (admin-scoped tokens pass `/validate`'s invoke gate; verified empirically).

## Risks / Trade-offs

- [Registry upgrade regresses Logto auth or nginx] → upgrade on cheap1 with the `.bak-*` rollback ritual first; verify `/api/auth/csrf-token` + market refresh before enabling A2A flags.
- [Agent-entry `metadata` size cap unknown] → verify in `agent_models.py` before building the descriptor; fallback is trimming persona to a path + shipping it as a skill entry.
- [Default-minted gateway tokens may lack `invoke_agent`] → probe after enabling flags; if missing, document the required scope minting in the runbook before go-live.
- [Cold-start latency on first message] → bounded by dsh boot; accepted; prewarm-on-deploy is a one-line later addition if it annoys.
- [Drain races (message in flight when child dies)] → drain timeout 5 min + A2A error mapping; contexts survive as fresh sessions, never mixed history (spec).
- [Runner host memory exhaustion] → cap + queue (spec), compose `mem_limit`, health exposes child count for the ops board.
- [A2A spec drift toward 1.0] → we implement the card/send/stream floor; card path already moved once (`agent.json` → `agent-card.json`) — registry ≥1.30.0 serves the current path.

## Migration Plan

1. Ops preconditions on cheap1 (D6): upgrade registry ≥1.30.0, fold nginx patch, enable flags, SSRF allowlist; verify with a scratch a2a agent entry.
2. Ship the runner inert (no deployed agents; polls, hosts nothing) + runbook in DEPLOY.md.
3. Ship manifest v2 validation + deploy action (gateway + cell) behind a flag; deploy one seed role; verify end-to-end through the gateway route with curl.
4. Last, after the three in-flight changes land: `mapAgent` mapping, catalog mode, chat branch, UI badges.

Rollback: disable the deploy flag (existing agents keep running; undeploy them explicitly), revert code, registry flags off; nothing in the pack schema is load-bearing for v1 consumers (`serving` is ignored by old validators).

## Open Questions

The proposal's five verification items (cheap1 flag state, skills write API shape, `metadata` cap, token grants, nginx patch folding) — all resolvable during implementation without changing the specs, the approach, or the task breakdown.
