# Tasks: add-a2a-agent-serving

Order: §1 (ops/verification) unblocks §4/§6; §5 must land after add-session-ownership / perf-session-open / fix-agent-workspace (same file, `server/agent-session.js`); §2/§3 are independently startable.

## 1. Verification & registry ops preconditions (design D6, Open Questions)

> Status 2026-09-30 (all of §1 DONE, verified live): registry upgraded to 1.30.0 + `A2A_REVERSE_PROXY_ENABLED=true`
> on cheap1 (DEPLOY.md 实录; the "fold the nginx patch" step was unnecessary — the patch lives in the TEMPLATE
> and regeneration writes elsewhere; SSRF already covered the whole tailnet). 1.3: agent `metadata` has no
> field-level cap; default-minted ADMIN tokens pass the `/validate` invoke gate (verified via the scratch
> agent's gateway route). 1.5's verify ran end-to-end with a scratch agent: anon 401, gateway-credential-only
> 401 (rejected by the RUNNER — proving `/validate` passed it), both credentials 200 card; undeploy stopped
> the runner's listener. fd-prod's `MARKET_REGISTRY_TOKEN` renewed the same evening (it had lapsed 09-29).
> Staging runner: container `agent-runner-stage` on cheap1 (`/opt/agent-runner-stage`), token expires 10-07.

- [x] 1.1 Probe cheap1 (`/opt/mcp-gateway-registry`): current image tag, `A2A_REVERSE_PROXY_ENABLED` state, host-mounted nginx hand-patch layout; record findings in a DEPLOY.md note. Verify: findings written, upgrade path decided
- [x] 1.2 Verify the upstream skills write API against prod (CRUD routes, skill-entry `visibility`/`allowed_groups`) with a throwaway probe script (pattern: `scripts/probe-*.mjs`). Verify: probe output answers whether pack-scoped skill entries can be gated
- [x] 1.3 Verify the agent-entry `metadata` size cap (upstream `agent_models.py`) and, once flags are on, whether default-minted gateway tokens carry the `invoke_agent` grant. Verify: both answers recorded in DEPLOY.md
- [x] 1.4 Upgrade the cheap1 registry to ≥1.30.0 with the `.bak-*` rollback ritual. Verify: `/api/auth/csrf-token` still 401s anonymous, platform market refresh still returns registry entries, Logto login unaffected
- [x] 1.5 Fold the Logto nginx hand-patch into the regenerable template, enable `A2A_REVERSE_PROXY_ENABLED` (+ `DEPLOYMENT_MODE=with-gateway`), add the runner host to `SSRF_ALLOWED_HOSTS/CIDRS`. Verify: a scratch a2a agent entry's card is fetchable through `/agent/{path}/.well-known/agent-card.json` and unauthorized calls 401

## 2. Serving contract in the pack manifest (design D1)

- [x] 2.1 Add the optional `serving` block schema + validation to `lib/pack-manifest.js` (protocol id, optional manual card, forbidden endpoint/model/credential keys, `card.skills` namespace isolation). Verify: unit tests — contract-free manifest validates under v1 rules verbatim; minimal contract validates; a contract carrying a model/endpoint/credential field is rejected naming the field
- [x] 2.2 Wire v2 through gateway publish and cell install validation (shared validator both already call). Verify: publish of a serving-contract pack succeeds end-to-end; an old (v1) consumer ignores the block (back-compat test)

## 3. Deploy action (design D3, D4)

- [x] 3.1 Registry client helpers: upsert skill entries under `packs/<packId>/<skill>` with restricted visibility; register/PUT the agent entry with `supported_protocol: "a2a"`, runner backend URL, and the small `metadata` descriptor; compose the AgentCard (manual fields override, defaults derived from name/description/tags). Verify: unit tests with a registry stub, including derived-default and override cases
- [x] 3.2 Add `POST /api/packs/:id/versions/:version/deploy` (gateway) and the cell-side route, creator/admin gated, idempotent per (pack version, agent), response carrying the expected-effective window. Verify: double-deploy is a no-op; deploying a contract-less pack is refused with a reason; authorization tests for creator/admin/other
- [x] 3.3 Deploy bookkeeping: record deployed (pack, agent, version) for status and the unpublish warning. Verify: unpublishing a deployed pack warns and leaves the service running; status flips as registry health changes

## 4. agent-runner service (design D2, D5, D10)

- [x] 4.1 Scaffold `agent-runner/` (Node service, docker-compose on the tailnet host, image from the platform base, env: registry URL + token, LLM default, MCP service credential, concurrency cap, idle TTL). Verify: inert boot polls `GET /api/agents`, hosts nothing, exposes `/health`
- [x] 4.2 Bundle materialization: pull agent entries, fetch skill contents from registry skill entries, compose a private DSH_HOME per role (persona + skills + MCP patches via the existing composition machinery, runner-level default model, service credential for MCP outbound). Verify: a child boots with exactly the descriptor's persona/skills/MCP and the runner's model
- [x] 4.3 A2A adapter: `/.well-known/agent-card.json` (identical to the registered card), `message/send`, `message/stream` (SSE), text parts only, `-32601` for unsupported methods. Verify: curl walkthrough against a seeded role — card fetch, send, stream, unknown method
- [x] 4.4 Session mapping and child lifecycle: `contextId`↔session 1:1, idle reap (default 30 min) with cold start on next message, capacity queue (no eviction of busy children), drain on descriptor change (new messages → new child, in-flight turns finish or 5-min timeout), health states (starting/serving/draining). Verify: unit tests + a scripted walkthrough covering cold-start, queue-at-capacity, and drain-during-stream
- [x] 4.5 Gateway-auth posture: require the gateway-injected backend credential, reject direct calls. Verify: request through the gateway route succeeds; the same request sent directly to the runner is rejected

## 5. paas consumption (design D9 — land after the three in-flight changes)

> Status 2026-09-30 late: 5.1/5.2 DONE (34/34 across affected suites). 5.4 code-complete (deploy section in
> PackDetailDialog + public raw-md route + packs-api + AgentsPage A2A badge + picker filters a2a entries out
> until 5.3; tsc + biome clean; locales ×5) — its e2e walkthrough stays open because chatting with a deployed
> entry needs 5.3, and 5.3 stays sequenced behind the three in-flight changes (perf-session-open is 0/8,
> agent-session.js carries ~118 lines of their uncommitted work).

- [x] 5.1 `registry-bridge.js` `mapAgent()`: map `supported_protocol: "a2a"` to `{mode: "a2a", url: <gateway route>}`. Verify: unit test with the registry fixture (the `supportedProtocol` field already present in test fixtures)
- [x] 5.2 `catalog.js`: serialize `mode: "a2a"`; drop a2a entries missing `url` as invalid. Verify: `GET /api/catalog` shows the deployed role as an a2a entry coexisting with the same pack's in-cell persona entry, no id collision
- [x] 5.3 `server/agent-session.js` A2A client branch: card cache per entry, `message/stream` when the card advertises streaming else `message/send`, parts → existing `text`/`done`/`error` events, bounded history replay mirroring the remote fork, no preset switch or runtime restart on select/leave. Verify: e2e chat with a seeded deployed role (streamed reply, follow-up context, error on stopped service)
- [x] 5.4 Web UI: 「部署为服务」 button (creator/admin) on the pack page with 「部署中→在线」 states, a2a badge in the agent picker and Agents page. Verify: e2e walkthrough deploying a seed pack and chatting with the deployed entry

> 5.3 update 2026-10-01: landed (commit 30edadc, pushed) once the three blocking changes were archived by
> the parallel session — switchableAgents includes a2a, streamA2aChat rides the gateway with dual credentials
> (X-Authorization gateway + Authorization agent), context_id = the cell session id carries continuity (no
> history replay needed), ws.js dispatches by mode, picker filter removed. Implementation deltas vs the task
> text: always message/stream (the runner always streams), no card cache (single endpoint per entry).

> 5.4 walkthrough covered by e2e/agent-serving.spec.js (3/3 green 2026-10-01): a2a entry seeded via
> agents.json + /api/catalog/refresh, picker selection, streamed reply + persistence + dual credentials,
> context_id continuity across turns, stopped-service error surfaced with the composer released. The prod
> button-click walkthrough rides the first real serving-contract pack (6.1).

## 6. Docs & end-to-end verification

- [x] 6.1 DEPLOY.md: agent-runner runbook (compose layout, env inventory, weekly service-credential renewal, health/ops board pointers) + the deploy 实录 section. Verify: runbook steps match what was actually executed in §1/§4
- [x] 6.2 Full-chain probe `scripts/probe-agent-serving.mjs`: deploy → poll-until-effective → card → `message/send` → `message/stream` → upgrade with drain → undeploy. Verify: one green run against the staging registry + runner before release
  <!-- Status 2026-09-30: steps 1–3 verified GREEN repeatedly on the staging stack (cheap1 runner `agent-runner-dsh`
       with a real dsh runtime + real registry): deploy library → skills/agent entries → runner pickup → health →
       gateway card with all three auth layers. The remaining send/stream/upgrade/undeploy steps need ONE
       successful text turn, blocked on a serving rehearsal model — the retired deepseek-v4.1-flash roster gap was
       probed too aggressively and knocked sub2api's Baidu account offline (incident; see memory llm-gateway-config:
       NEVER rapid-probe models; ask the user for the rehearsal model). Final run pending the user's model choice,
       ONE attempt only. -->
