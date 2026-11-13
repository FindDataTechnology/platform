## Why

The `migrate-pi-to-dsh` change is complete (35/35 tasks), but it left the host driving dsh *exclusively* through the minimal SDK wire protocol (`initialize` / `session/prompt` / `shutdown`). That protocol exposes no management RPCs — no `setModel`, no `reloadMcp`, no `setCredential`. So every live config change (model switch, MCP toggle, skill edit, key rotation) kills and respawns the dsh child: 5–15s of frozen UI, dropped in-memory session state, and an unsersialized overlap-corruption risk when two mutations race.

But dsh has a first-party **file-watch / HMR layer** sitting behind that protocol — `cordis-plugin-hmr` + `cordis-plugin-include` hot-swap module/patch edits; `dsh-settings-file` hot-reloads `settings.yaml`; `dsh-credentials-local` hot-reloads `.credentials.yaml` and resolves keys **per request**; `dsh-skill-filesystem` Chokidar-watches skill dirs. The host never reaches this layer — it regenerates patch files and restarts instead. So the "replace hand-rolled with official" request doesn't mean swapping packages (the plugins are already official); it means routing the host's config writes through dsh's own watch seams instead of through `restart()`.

Alongside that, three user-facing gaps remain: the web Composer has no way to attach a local file to a prompt (drag-drop only ingests to Documents, never the prompt); the Sidebar's workdir picker is a dead control that alerts "desktop only" in the browser and throws "not supported under the dsh runtime" on desktop; and several stale `pi`-era artifacts (comments referencing deleted `public/app.js`, an i18n assistant name still hardcoded as `"pi"`, a `__chatStore` debug global leaking into production) were never cleaned up after the migration.

## What Changes

**Config hot-reload — stop restarting for live changes:**
- MCP add/remove/enable/disable SHALL write entries in-place into the patch file dsh's `include`/`hmr` plugins watch, letting `dsh-mcp-client` hot-swap (disconnect+reconnect, no process restart) — replacing `dshRegenMcp()`'s kill+respawn. *(Gated on a spike: confirm `--patch` overlay files are inside the HMR watch root.)*
- MCP mutations SHALL be serialized (single-flight mutex + debounce) to kill the overlap-corruption race; restart stays as a documented fallback if the hot-swap path is unavailable.
- Database custom skills SHALL be materialized as `SKILL.md` into a `dsh-skill-filesystem`-watched directory so they hot-reload identically to file skills (closing the asymmetry where file skills hot-reload but DB skills don't).
- Provider credentials SHALL be written to dsh's hot-reloaded credential/settings stores (`.credentials.yaml` / `settings.yaml`) so a changed key reaches the **next LLM request** with no restart, instead of being baked into `process.env` at boot. *(Gated on a spike: confirm `dsh-settings-file` hot-reloads the `llm-pi-ai:` section's model list, not just keys.)*
- Fix `/api/litellm/credentials` leaking `LITELLM_API_KEY` to the browser in local mode — align with the cookie-based auto-login used for the `/ui` iframe.

**Local file selection — thread 1:**
- Add a Composer attachment affordance (paperclip) that uploads a local file via the existing `POST /api/documents` (FormData → multer, the path that already works in-browser) and references the ingested document in the outgoing prompt. Reuses existing ingestion; no new server storage.
- **Remove** the dead workdir picker (Sidebar "Working Directory" → Change) — it alerts "desktop only" in the browser and throws "not supported under the dsh runtime" on desktop, so it is non-functional everywhere. No replacement capability is built: the active-session cwd is baked into `initialize` and has no runtime setter (documented ceiling).

**Chat-history consistency:**
- Remote (catalog `agent-remote`) agent turns SHALL be persisted to the SQLite mirror via `recordMessage()` like local turns, so a browser-close-reopen doesn't leave a dangling user message with no reply.

**Cleanup (no spec-level behavior change):**
- Remove stale `pi`→dsh migration leftovers: comments referencing deleted `public/app.js`, the `AGENT_RUNTIME` branch language in `catalog.js`, and the `.pi/` directory if present.
- Update the i18n assistant display name from `"pi"` to **"Find Data Technology"** across all 5 locales (en/zh-CN/es/fr/ja) in `composer.placeholder` and `turn.assistantName`.
- Gate `window.__chatStore` behind `import.meta.env.DEV` so the Zustand store isn't globally readable/mutable in production.

## Capabilities

### New Capabilities
- `chat-attachments`: attaching a local file to an outgoing chat prompt — upload via the existing documents ingestion endpoint and reference the resulting document in the prompt text.

### Modified Capabilities
- `mcp-integration`: the existing requirement that runtime MCP changes update the tool registry "without requiring a restart" is currently violated by `dshRegenMcp()`'s kill+respawn. This change replaces it with in-place patch-file writes consumed by dsh's HMR/include watchers, and adds a serialization requirement to prevent concurrent-mutation overlap.
- `skill-invocation`: database custom skills (currently "loaded at startup" only) SHALL be materialized to a `dsh-skill-filesystem`-watched directory so they hot-reload at runtime without restart, matching file-skill semantics.
- `dsh-llm-providers`: provider credentials (currently resolved from `process.env` at boot, model switch = restart) SHALL be routed through dsh's hot-reloaded credential/settings stores so key changes reach the next request without restart. The `/api/litellm/credentials` browser leak is closed.
- `chat-history`: remote (catalog) agent turns SHALL be persisted to the SQLite mirror on turn completion, matching local-turn persistence.

## Impact

**Backend:** `server.js` (`dshRegenMcp`, `rebuildAgentForWorkdir`, `switchModelTo`, `streamRemoteChat`, the `/api/extensions/mcp*` and `/api/litellm/credentials` routes), `dsh-profile.js` (write targets for `writeMcpPatch`/`writeLlmProfile` shift from boot-only to live-watched), `dsh-bridge.js`, `extension-store.js`, `db.js`, `chat-history.js`.

**Frontend:** `web/src/components/Composer.tsx` (attachment affordance), `Sidebar.tsx` (hide dead workdir picker), `web/src/hooks/useChatStore.ts` (`__chatStore` gating), all 5 locale files.

**Dependencies:** none added — uses dsh's already-installed plugins (`dsh-mcp-client`, `dsh-skill-filesystem`, `dsh-credentials-local`, `dsh-settings-file`). No new npm packages.

**Two spikes gate the largest wins** (both are live runtime checks, not readable from source alone):
1. Does `cordis-plugin-include`/`hmr` watch the `--patch` overlay file in-place, and is that file inside the HMR watch root? → decides whether MCP hot-swap retires `dshRegenMcp` entirely or falls back to the restart mutex.
2. Does `dsh-settings-file` hot-reload the `llm-pi-ai:` model *list* (not just resolve keys per-request)? → decides whether model-list additions appear without restart.

**Documented ceilings (not implemented — blocked on dsh extending the SDK protocol):** active-session model switch without restart (model baked into `initialize`); `session/loadContext` to repopulate dsh from the SQLite mirror when its own disk session is gone/moved; `ctx.skills.register()` for runtime (non-filesystem) skills. These dissolve if/when dsh grows the RPCs; until then they are documented constraints, not silent gaps.
