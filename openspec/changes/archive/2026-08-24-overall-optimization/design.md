## Context

`migrate-pi-to-dsh` (35/35) replaced the pi-agent SDK with dsh as the sole agent runtime. The host now drives dsh exclusively through the `@deepseek-ai/dsh-sdk-client` `HarnessClient`, whose wire protocol (`@deepseek-ai/dsh-sdk-protocol` `HarnessSdkRequestMap`) exports exactly three RPCs: `initialize`, `session/prompt`, `shutdown`. There are **no management RPCs** — no `setModel`, no `reloadMcp`, no `setCredential`, no `setWorkdir`, no `session/loadContext`, no `ctx.skills.register()`.

The host responded to that absence by routing every live config change through a single hammer: `dshBridge.restart()`, which kills the child (5s SIGTERM→SIGKILL ladder) and respawns it with fresh `initialize` args. Today that path backs MCP add/remove/enable/disable (`dshRegenMcp` in `server.js:367`) and model switching (`switchModelTo` in `server.js:554`). Consequences:

1. **5–15s frozen UI** per mutation — the new child re-runs `initialize`, retries the adapter-registration race (`INIT_RETRIES`, up to 10s ceiling), and only then is `isReady()`.
2. **Dropped in-memory session state** — dsh persists sessions by id to disk, so the conversation text survives a restart, but any non-persisted state (in-flight tool calls, transient scratch) is lost. `dsh-bridge.js:183` flags this `ponytail: v1 ceiling`.
3. **Unserialized overlap-corruption risk** — `dshRegenMcp` has no mutex; two concurrent REST mutations race the patch-write + restart sequence. `server.js:365` carries the comment "no regen serialization — concurrent REST calls may overlap restarts."

The key correction from the explore phase: dsh is **not** limited to the three-RPC surface. Behind it sits a first-party **file-watch / HMR layer** the host never touches:

| dsh plugin | What it hot-reloads | How the host could reach it |
|---|---|---|
| `cordis-plugin-hmr` + `cordis-plugin-include` | module/patch edits; `include` reads+watches `cordis.yml` + `--patch` overlays | edit the watched patch file in place |
| `dsh-settings-file` | `$DSH_HOME/settings.yaml` sections | write to `settings.yaml` |
| `dsh-credentials-local` | `.credentials.yaml`; resolves apiKeyEnv **per request**; 0600 + Chokidar watch | write to `.credentials.yaml` |
| `dsh-skill-filesystem` | skill dirs; add/remove/change of `SKILL.md` picked up live | write `SKILL.md` into a watched dir |

So "replace hand-rolled with official dsh" does **not** mean swapping npm packages — the plugins in use (`dsh-mcp-client`, `dsh-skill-filesystem`, `dsh-llm-pi-ai`) are already official. It means routing the host's config writes through dsh's own watch seams instead of through `restart()`.

Three user-facing gaps ride alongside this:

- **Local file in the prompt** — the web Composer (`Composer.tsx`, 232 lines) has no paperclip; drag-drop (lines 140–156) ingests to Documents but never references the file in the outgoing prompt. The Sidebar's workdir picker (`Sidebar.tsx:134–164`) is dead in both layers: it alerts "desktop only" in the browser and throws "not supported under the dsh runtime" on desktop (`rebuildAgentForWorkdir`, `server.js:507`). The active-session cwd is baked into `initialize` with no runtime setter — a genuine ceiling. The user decided to **remove** the dead picker rather than build a replacement.
- **Chat-history gap** — remote (`agent-remote` catalog) turns are broadcast-only; `streamRemoteChat` (`server.js:615–654`) never calls `recordMessage()`. A browser close/reopen leaves a dangling user message with no reply.
- **Stale migration leftovers** — `pi` hardcoded as the assistant name across all 5 locales; `public/app.js` referenced in comments/code despite `public/` being deleted; `window.__chatStore` exposed ungated in production; the `.pi/` directory.

## Goals / Non-Goals

### Goals

1. **Stop restarting dsh for live config changes wherever dsh's own watch seams can carry the change** — MCP mutations, DB-skill edits, provider key rotation.
2. **Serialize the remaining restart path** so concurrent mutations can't overlap-corrupt.
3. **Add a Composer attachment affordance** that reuses the working documents ingestion endpoint — no new server storage, no new dependency.
4. **Persist remote agent turns** to the SQLite mirror so chat-history is consistent across local and remote agents.
5. **Close the `/api/litellm/credentials` browser leak** (LITELLM_API_KEY reaches the browser in local mode).
6. **Remove the dead workdir picker** and the stale `pi`-era artifacts; rename the assistant to "Find Data Technology".

### Non-Goals (documented ceilings — blocked on dsh extending the SDK protocol)

- **Active-session model switch without restart.** The model is an `initialize` argument; dsh exposes no `setModel` RPC. A switch still = `restart({provider, model})`. dsh persists sessions by id so the conversation resumes from disk, but the process is replaced. Dissolves if/when dsh grows a `setModel` RPC.
- **`session/loadContext`** to repopulate dsh's own session from the SQLite mirror when its disk session is gone/moved (e.g. after `PLATFORM_DATA_DIR` moves). No such RPC exists.
- **`ctx.skills.register()`** for runtime, non-filesystem skill registration. We work around it by materializing DB skills as files (see D3), not by calling an unsupported API.
- **Generalizing the workdir picker.** Removed, not replaced. The cwd is an `initialize` argument.

## Decisions

### D1 — Route MCP mutations through the watched patch file; serialize and fall back to restart

**Decision:** `dshRegenMcp()` is replaced by `dshUpdateMcp()`: write entries **in place** into `mcp.patch.yml` (the file already passed via `--patch` and watched by `cordis-plugin-include`/`hmr`), let `dsh-mcp-client` hot-swap (disconnect the affected server, reconnect, no process restart), and serialize all mutations behind a single-flight mutex + debounce. `restart()` stays as a **documented fallback** when the hot-swap path is unavailable (spike 1 fails, or a server config shape the hot-swap can't reconcile).

**Why over the alternative (keep restart, just add a mutex):** A mutex alone kills the overlap race but keeps the 5–15s freeze and the in-memory-state drop on every mutation. The hot-swap path removes both. The mutex is kept regardless — even hot-swap writes must not overlap, and the fallback restart path needs it.

**Why over (wrap every RPC behind a host-side queue and always restart):** That's the status quo with serialization bolted on; it preserves every cost the watch-seam path removes.

**Alternatives considered:**
- *Hand-roll an MCP client manager in the host* (reconnect per server, re-`listTools`, re-register). Rejected: `dsh-mcp-client` already does this natively with backoff; hand-rolling reintroduces the exact pi-era `mcp-bridge.js` code the migration deleted.
- *Switch to a different MCP plugin.* Rejected: `dsh-mcp-client` is official and already wired; the problem is the host's reload glue, not the plugin.

**Gated on spike 1** (see Open Questions): does `cordis-plugin-include`/`hmr` watch the `--patch` overlay file in place, and is that file inside the HMR watch root? If the overlay is read once at boot and not watched, the hot-swap path is unavailable and we keep the serialized-restart fallback as the primary path (still an improvement: overlap corruption fixed, just not the freeze).

### D2 — Materialize DB custom skills as `SKILL.md` into a watched dir

**Decision:** Database custom skills (the `custom_skills` table, mutated via `/api/extensions/skills*`) SHALL be materialized as `SKILL.md` files into a directory `dsh-skill-filesystem` already watches (the `customSkillDirs` from `writeSkillsPatch`, or a dedicated materialization subdir added to it). DB mutations write/update/delete the corresponding `SKILL.md`; `dsh-skill-filesystem`'s Chokidar watcher picks up the change live — exactly like file skills. No `restart()`.

**Why over the alternative (call a dsh skills RPC on DB mutation):** No such RPC exists (`ctx.skills.register()` is a documented ceiling). The materialization approach reaches the same outcome through the seam that already exists.

**Why over (restart on DB skill mutation, like MCP does today):** Restarts for skill edits are the loudest UX failure — a user typing a skill and saving shouldn't freeze the chat for 10s. File skills already hot-reload; this makes DB skills behave identically, closing the asymmetry.

**Atomicity:** Each `SKILL.md` write is temp+rename (matches `documents.js`'s manifest pattern and `writeMcpPatch`'s existing pattern). The materialization dir is a runtime artifact under `PLATFORM_DATA_DIR`, gitignored.

### D3 — Route provider credentials through dsh's hot-reloaded stores; close the browser leak

**Decision:** Provider credentials SHALL be written to dsh's hot-reloaded stores rather than read once from `process.env` at boot:
- Upstream keys (`LLM_API_KEY`, `LITELLM_API_KEY`) → `.credentials.yaml` (hot-reloaded by `dsh-credentials-local`, resolved **per request**, 0600 perms). A changed key reaches the next LLM request with no restart.
- Model-list changes (a new LiteLLM model appears) → `settings.yaml`'s `llm-pi-ai:` section. **Gated on spike 2.**

The `/api/litellm/credentials` route (`server.js:1277`) that returns `LITELLM_API_KEY` to the browser in local mode is **closed**: the LiteLLM `/ui` iframe already auto-logs in via a server-set cookie; the credentials route is replaced by that cookie path, aligning local mode with the already-correct remote mode.

**Why over (keep `process.env`, restart on key change):** `process.env` is read once at boot; a rotated key requires a full restart. `dsh-credentials-local` resolves per-request and hot-reloads the file — a key change reaches the next call with zero downtime. This is exactly the "official plugin for apikey management" the user asked for; it already exists, the host just doesn't use it.

**Why over (a host-side secrets manager / vault):** YAGNI. `.credentials.yaml` + `dsh-credentials-local` is the official, already-installed mechanism. A vault is a new dependency for a problem dsh already solves.

**Alternatives considered:**
- *Write keys to `settings.yaml` inline.* Rejected: `dsh-credentials-local` exists specifically to keep keys out of the general settings doc and to resolve them per-request with 0600 perms — using it is the official path.

### D4 — Chat attachment via the Composer paperclip, reusing `/api/documents`

**Decision:** Add a paperclip affordance to `Composer.tsx`. Clicking it opens the native file picker (`<input type="file">`); selecting a file uploads it via the existing `POST /api/documents` (FormData → multer, the path that already works in-browser per `DocumentsPage.tsx:107–161` and `documents-api.ts:39–44`), and on success the outgoing prompt references the ingested document (by id or a short citation token the server expands into the context).

**Why over (a new upload endpoint + a new file store):** The ingestion path already exists and already persists to the SQLite project DB. A second store is unrequested duplication; the ponytail ladder's rung 4 (already-installed dependency solves it) applies.

**Why over (embed the file inline in the prompt as base64):** Bloats the WS frame and the prompt token budget; reusing the documents path keeps the file in the RAG store where it can be re-referenced across turns.

**Decision on the citation shape:** the prompt carries a lightweight reference (e.g. a `@doc:<id>` token or a documents-api-returned short link); `server.js`'s prompt handling expands it so dsh sees the document content in context. Exact token grammar is an implementation detail scoped in `tasks.md`; the constraint is "no new server storage, no new dependency."

### D5 — Remove the dead workdir picker (no replacement)

**Decision:** Remove the Sidebar "Working Directory → Change" control entirely (`Sidebar.tsx:134–164`) and the `rebuildAgentForWorkdir` throw site. The i18n string `"文件夹选择仅在桌面应用中可用"` and its locale siblings are removed. `pickWorkdir` stays in the Electron preload (harmless; not surfaced) but the web UI no longer references it.

**Why over (hide behind a feature flag instead of remove):** Dead-in-both-layers code is a maintenance trap; the user explicitly chose Remove. The active-session cwd is an `initialize` argument with no runtime setter — a documented ceiling, not something to paper over with a disabled control.

### D6 — Persist remote agent turns via `recordMessage()`

**Decision:** `streamRemoteChat` (`server.js:615–654`) calls `recordMessage()` on turn completion, mirroring the local-turn path (`chat-history.js:104–117`). The user turn is already appended on `prompt`; the assistant's final aggregated text is recorded on stream end.

**Why over (leave broadcast-only, document as v1):** The comment at `server.js:818–819` already calls it a v1 ceiling. Closing it is a one-call addition to the existing persistence path, and it removes a real data-loss bug (close the browser mid-remote-turn → dangling user message). Falls inside "overall optimization."

## Risks / Trade-offs

- **[Risk] Spike 1 fails — `--patch` overlays aren't HMR-watched.** → Mitigation: `dshUpdateMcp` detects the unavailable hot-swap (a feature probe at startup, or the first mutation observes no tool-registry change) and falls back to the serialized `restart()` path. Either way the overlap-corruption bug is fixed by the mutex. The design is spike-outcome-agnostic; only the *win size* changes.
- **[Risk] Spike 2 fails — `settings.yaml` hot-reloads keys but not the `llm-pi-ai:` model list.** → Mitigation: key rotation still works (per-request resolution via `dsh-credentials-local`); only new-model-discovery still needs a restart. Documented as a partial ceiling, not a failure.
- **[Risk] DB-skill materialization desyncs from the DB** (a write succeeds in SQLite but the `SKILL.md` rename fails). → Mitigation: the `SKILL.md` write is the source of truth for what the agent sees; on write failure the DB row is marked dirty and a reconciliation pass retries. The DB remains the durable store; the materialization dir is rebuilt from it on startup (idempotent).
- **[Risk] Hot-reload latency** — dsh's Chokidar debounce + plugin processing may take 100s of ms; a user who saves an MCP server and immediately prompts may hit the old tool set for one turn. → Mitigation: the `dshUpdateMcp` promise resolves only after a confirmation signal (tool-list re-fetch or a short settle delay); the UI shows "applying…" until then. Same pattern the existing `restart()` already needs.
- **[Risk] `.credentials.yaml` write races the Chokidar watch** — a key rotated mid-request. → Mitigation: `dsh-credentials-local` resolves per-request, so a request already in flight uses the key it fetched; the next request sees the new one. No corruption, just a one-request boundary.
- **[Trade-off] The materialization dir is a new runtime artifact** under `PLATFORM_DATA_DIR`. → Accepted: it's gitignored, rebuilt from the DB on startup, and far cheaper than the restart-per-edit it replaces.
- **[Trade-off] Model switching still restarts.** → Accepted: documented ceiling (Non-Goal). The freeze on a model switch is infrequent and dsh resumes the conversation from disk.

## Migration Plan

The change is backward-compatible at the config layer — the same `mcp.json` / `agents.json` / `.env` sources feed the same generators; only the *write targets* shift from boot-only to live-watched, and the *reload mechanism* shifts from `restart()` to watch-seam edits.

1. **Spike first (tasks 1–2).** Both spikes are live runtime checks against a running dsh: spike 1 (patch HMR) and spike 2 (settings model-list hot-reload). Their outcomes gate whether `dshUpdateMcp` retires `restart()` entirely or keeps it as fallback, and whether model-list additions appear without restart. No application code is written before the spikes resolve.
2. **Config hot-reload (tasks 3–6).** `dshUpdateMcp` (mutex + in-place patch write + hot-swap-or-fallback), DB-skill materialization, credential-store routing, `/api/litellm/credentials` leak closure. Each is independently shippable; each preserves the old path as fallback where the spike is uncertain.
3. **Local-file affordance (tasks 7–8).** Composer paperclip + prompt reference expansion. Reuses `/api/documents`; no backend storage change.
4. **Consistency + cleanup (tasks 9–11).** Remote-turn persistence, workdir-picker removal, `pi`→"Find Data Technology" rename + stale-artifact sweep.
5. **No data migration.** SQLite tables (`extension_configs`, `custom_skills`) are unchanged; the materialization dir is derived from them and rebuilt on startup. `.credentials.yaml` is created from `process.env` on first run if absent (the existing `writeLlmProfile` pattern).

Rollback: each task's diff is self-contained. Reverting `dshUpdateMcp` restores `dshRegenMcp` (the old restart path still exists as the fallback). Reverting the materialization reverts to startup-only DB-skill loading. No schema migration to undo.

## Open Questions

1. **Spike 1 (gating): RESOLVED — HOT-SWAP AVAILABLE.** Cordis-source inspection confirms `cordis-plugin-hmr` watches `config.root = ["."]` (the profile directory) and `cordis-plugin-include` refreshes its entry tree on file change. Editing `~/.dsh/profiles/platform/mcp.patch.yml` in place triggers a hot-swap (dsh-mcp-client disconnects/reconnects the affected server, no process restart). dshUpdateMcp uses hot-swap as the primary path; `restart({mcpPatchPath})` is retained only as a documented fallback for unreconcilable configs. Gated behind spike 1 success.
2. **Spike 2 (gating): RESOLVED — HOT-RELOAD AVAILABLE (dsh side); host selector needs a re-read.** `dsh-settings-file` watches `settings.yaml` and `publish(doc)` on change; `dsh-llm-pi-ai`'s `installSettingsSection` `onChange` callback re-runs `ensureRegistrationFacts()` (`registration.replace(routes)`) and `ensureDirectory()` (`directory.replace(entries)`) from a fresh `profiles()` read — so a changed `llm-pi-ai:` model list propagates to the live LLM adapter routes + model directory **without a process restart**. `registerModelDiscovery` is wired live too. Caveat: server.js's `getAvailableModels()` sources the selector from the in-memory `dshModels` array (populated once at boot from `writeLlmProfile()`), not from dsh's live registry — so for a new LiteLLM model to appear in the UI selector, `writeLlmProfile()` must be re-run after the settings change (it re-discovers from `/v1/models` and rewrites `settings.yaml`, which dsh then hot-reloads). Task 5.2 routes model-list changes through `writeLlmProfile()` rather than a manual `settings.yaml` edit.
3. **Citation token grammar (implementation-detail):** Should the Composer reference an attached document as `@doc:<id>` (server expands into context), a short link, or inline the title? Scoped in `tasks.md`; the constraint is no new server storage / no new dependency. Default lean: `@doc:<id>` expanded server-side, matching how `/skill:` tokens are already expanded.
