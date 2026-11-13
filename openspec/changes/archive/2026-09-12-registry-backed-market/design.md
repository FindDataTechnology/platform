## Context

The market is served from two static JSON files read once per process (`extension-store.js`), while the agent catalog (`catalog.js`) already demonstrates the dual-source + refresh + broadcast pattern. The operator's mcp-gateway-registry exposes `GET /api/servers`, `GET /api/skills`, `GET /api/skills/{path}/content`, and `GET /api/agents` (193-endpoint OpenAPI), with group-based scopes on its side; paas users arrive with `{email, groups}` from forward-auth (oauth2-proxy → Logto). The runtime is a single team-shared dsh agent session — per-user tool enforcement was explicitly descoped (store-level visibility only).

## Goals / Non-Goals

**Goals:**
- One adapter module serves both consumers (market + agent catalog), so registry fetch/cache/degradation logic exists once.
- Zero change to the install path and dsh MCP wiring: registry entries must flow through the existing template → form → SQLite → cordis patch / SKILL.md materialization chain.
- No URL configured ⇒ byte-identical behavior to today.

**Non-Goals:**
- Per-user agent sessions / per-user MCP credentials (OBO token pass-through). The adapter's auth is a provider function so a user-token mode can be added later without touching consumers.
- Registry write APIs (register/edit from paas), semantic search proxying, health badges on cards (candidates for a follow-up).
- Logto custom-claims setup (deployment concern, documented as an operator convention).

## Decisions

### D1: Service token + paas-side group filtering (Phase B), not user-token pass-through
The adapter authenticates to the registry with a service token (`MARKET_REGISTRY_TOKEN`) and fetches a **global** snapshot; per-user visibility is computed per-request as `entry.groups ∩ user.groups`. Rationale: forward-auth gives paas only email/groups headers (no access token), Logto's default access tokens are opaque (not JWT), and the background TTL refresh has no user context — user-token mode would force per-user on-demand pulls and break the last-good cache model. Alternative rejected: forwarding `X-Forwarded-Access-Token` (OBO) — correct end-state but requires Logto JWT-resource configuration and per-user caches; deferred, not blocked (auth is injected via a provider hook).

### D2: New module `registry-bridge.js`, mirroring `catalog.js` conventions
Module state + accessors: `initRegistryBridge({broadcast})`, `getMarketEntries()`, `getSkillContent(path)`, `getAgentEntries()`, `refreshRegistry()`, last-good caches per asset type, 10s fetch timeout, signature-change detection for broadcasts. Both `extension-store.getMarketCatalog()` and `catalog.refresh()` consume it. Alternative rejected: extending each consumer separately — two fetch/cache/degradation implementations would drift.

### D3: Merge precedence — local overrides remote
Market: bundled JSON wins on name collision (bundled entries are curated for this deployment). Catalog: built-in → registry → `agents.json` → cloud (later wins), preserving both existing rules (cloud stays the live control plane; local files override remote sources). Alternative rejected: registry-wins — a remote registry edit would silently shadow curated local entries.

### D4: Cache model — global snapshot + per-request filter, no per-user caches
The registry snapshot (entries + group metadata) is cached globally with `MARKET_REGISTRY_TTL_SECS` (default 300) background refresh via the service token; `GET /api/extensions/market` filters per-request (cheap set intersection). `market_changed` broadcasts only on signature change (mirrors `catalog_changed`). The market cache in `extension-store.js` changes from "read file once" to "bundled (immutable) + registry snapshot (TTL)".

### D5: Gateway MCP entries and the `requiresConfig` gap
Adapter emits `configTemplate: { url, headers: { Authorization: "Bearer <your_token>" } }`. **Gap**: the current `requiresConfig()` only inspects `env` and `args` placeholders — a headers-only template would wrongly derive `requiresConfig: false` ("ready to use"), inviting installs with no token. Fix: extend the shared placeholder check (`isPlaceholderArg`) to header values in **both** `extension-store.js` (derivation) and the client's setup-form field generation (it re-implements the same rule). Alternative rejected: adapter forcing `requiresConfig: true` — leaves the predicate wrong for any future headers-based entry.

### D6: Registry skills install via a server-side route
The service token must never reach the browser, so the client cannot fetch `GET /api/skills/{path}/content` itself. New route `POST /api/extensions/market/skills/:name/install`: server resolves the registry skill, fetches content, creates the custom skill (existing `addCustomSkill` + SKILL.md materialization), returns the skill. Bundled skills keep the existing client-side install (template content is already in the catalog). Skill entries gain `origin: "registry"` + `contentPath`; install of a missing/stale entry 404s.

### D7: Agent mapping — link-mode by default, groups → roles
Registry agents become `agent-remote` entries: `link` mode (URL card) unless the registry entry declares an OpenAI-compatible endpoint (then `chat` mode with `baseUrl`/`model`, key via `apiKeyEnv` only — never inline secrets). Registry group membership maps to `roles`, reusing the catalog's existing visibility rule unchanged. Registry fetch joins the existing `CATALOG_REFRESH_SECS` cadence and the shared signature → `catalog_changed` broadcast.

### D8: Config and degradation matrix
`MARKET_REGISTRY_URL` (unset ⇒ feature off), `MARKET_REGISTRY_TOKEN`, `MARKET_REGISTRY_TTL_SECS=300`. Unreachable/invalid-token registry ⇒ keep last-good snapshot + warn (same rule as `AGENTS_CONFIG_URL`). The market response serializes registry entries without the service token; header templates carry only the literal `<your_token>` placeholder the user fills in.

## Risks / Trade-offs

- [Registry API response shape unverified] → **RESOLVED (spike; mapping pinned from `api/registry_client.py` models, then LIVE-PROBED 2026-09-11 against mcp.finddatatech.cloud with a real admin token — all three listings returned 200 and matched):**
  - `GET /api/servers?limit=500` → `{servers: [{path, display_name, description, is_enabled, health_status, status}], total_count, limit, offset, has_next}`. **No URL and no group metadata on the summary.**
  - `GET /api/servers/{path}/server.json` → adds `server_name, proxy_pass_url, tags, num_tools, transport, version` — `proxy_pass_url` is the vaulted backend URL; clients never use it. The client-facing MCP endpoint is **`{MARKET_REGISTRY_URL}/{path}/mcp`** (per the registry's own `test-mcp-client.sh`), so listing alone suffices (no N+1 detail fetches).
  - `GET /api/skills?limit=500` → `{skills: [{id, name, path (e.g. "/skills/pdf-processing"), description, skill_md_url, version, author, visibility, is_enabled, tags, owner, health_status, status}], ...}`.
  - `GET /api/skills{path}/content` → `{content: "<raw SKILL.md>", url}` (strip the `/skills/` prefix from the entry path).
  - `GET /api/agents` → `[{name, path, url, num_skills, is_enabled, status, supportedProtocol, externalTags, ...}]` (mixed snake/camelCase — accept both).
  - **Group metadata confirmed absent from all listings** → the D-risk fallback is adopted: a paas-side `registry-groups.json` (name → groups[]) supplies visibility groups; unmapped entries are group-less (visible to everyone per spec). Live probe adds: server docs carry a `visibility` field (`public` / `group-restricted`) but not the group list itself, and `/api/agents` returns the `{agents: [...]}` wrapper (not a bare array). Derived MCP endpoint `{REGISTRY_URL}/{path}/mcp` confirmed live (JSON-RPC protocol response); an explicit `mcp_endpoint` field (currently null in listings) is preferred when present. Caveat observed: the `law-bench` server's MCP route rejects the admin API token (401) while `/api` listing accepts it — per-server MCP scopes are enforced separately by the gateway, so users installing a group-restricted server need a token its MCP route accepts.
- [Service token needs read access to catalog APIs] → provision a minimal-scope token; if the registry requires admin for list APIs, that broadens the token's blast radius — document it in `.env.example`.
- [Group-name drift: Logto claim ↔ forward-auth groups ↔ registry group_mappings] → operator convention documented (single naming scheme, e.g. `mcp-<asset>-users`); drift shows up as invisible-but-installed assets, caught by the Task 1 spike.
- [Store-level visibility only — an installed MCP is usable by every user of the shared agent] → accepted explicitly (exploration decision); sensitive MCPs stay out of the market or behind the registry gateway's own scopes. Revisit only with a per-user-sessions change.
- [Two refresh timers (market TTL 300s, catalog 60s) both hitting the registry] → acceptable; the bridge dedupes concurrent fetches (single-flight) and signature checks prevent broadcast storms.

## Migration Plan

Additive env vars, default off. Deploy: set `MARKET_REGISTRY_URL`/`MARKET_REGISTRY_TOKEN`, restart; bundled catalog unchanged, registry entries appear after first fetch. Rollback: unset the vars and restart — the market returns to bundled-only with no data migration (registry-installed MCP/skills are ordinary DB rows and keep working).

## Open Questions

- Exact field names of the live registry responses (resolved by the Task 1 spike; adapter isolates the mapping).
- Whether any registry agent in practice exposes an OpenAI-compatible endpoint (if none, the `chat`-mode branch is dormant but harmless).
