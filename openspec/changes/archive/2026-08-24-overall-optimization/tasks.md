## 1. Spikes (gate the hot-reload wins)

- [x] 1.1 Spike 1 — patch-file HMR: analyzed cordis-plugin-hmr + cordis-plugin-include source; confirmed `--patch` overlays inside HMR watch root trigger refresh() → hot-swap available. Recorded into design.md Open Question 1.
- [x] 2.1 Spike 2 — settings model-list hot-reload: analyzed dsh-settings-file + dsh-llm-pi-ai source; confirmed the llm-pi-ai onChange callback re-registers adapter routes + model directory live (no restart). Recorded into design.md Open Question 2 (with the host-selector re-read caveat).

## 2. MCP hot-reload + serialization

- [x] 3.1 Add a single-flight mutex + debounce around MCP patch mutations in `server.js` (the overlap-corruption race at `server.js:365`); concurrent REST calls SHALL queue, not overlap. Applies to both the hot-swap path and the restart fallback.
- [x] 3.2 Replace `dshRegenMcp()` (`server.js:367`) with `dshUpdateMcp()`: write entries **in place** into `mcp.patch.yml` (temp+rename, preserving the existing atomic write) so `cordis-plugin-include`/`hmr` can hot-swap; no `dshBridge.restart()` on the primary path.
- [x] 3.3 Implement the restart fallback in `dshUpdateMcp` for when hot-swap is unavailable (spike 1 = fallback, or an unreconcilable config shape): fall back to the serialized `restart({mcpPatchPath})` path. Probe hot-swap availability once at startup.
- [x] 3.4 Resolve `dshUpdateMcp`'s promise only after a confirmation signal (tool-list re-fetch or a short settle delay) so the UI's "applying…" state clears only when the new tool set is live.

## 3. DB-skill hot-reload (materialization)

- [x] 4.1 Add a materialization directory under `PLATFORM_DATA_DIR` (gitignored runtime artifact) for DB custom skills as `SKILL.md` files; add it to `writeSkillsPatch`'s `customSkillDirs` (`dsh-profile.js:277`) so `dsh-skill-filesystem` Chokidar-watches it.
- [x] 4.2 On DB skill create/update/delete (`extension-store.js` skills CRUD, `/api/extensions/skills*`), write/rename/delete the corresponding `SKILL.md` atomically (temp+rename) so the Chokidar watcher picks up the change live — no `restart()`.
- [x] 4.3 On startup, rebuild the materialization dir idempotently from the `custom_skills` table (DB is the durable store; the dir is derived). On a write failure, mark the DB row dirty and retry in a reconciliation pass.

## 4. Provider credentials via hot-reloaded stores

- [x] 5.1 Route upstream keys (`LLM_API_KEY`, `LITELLM_API_KEY`) to `.credentials.yaml` (0600 perms), hot-reloaded by `dsh-credentials-local` and resolved **per request**; update `dsh-profile.js` `writeLlmProfile` to write the credential store, not just `settings.yaml`. Create the file from `process.env` on first run if absent.
- [x] 5.2 (Gated on spike 2) Route model-list changes (new LiteLLM model) to the `settings.yaml` `llm-pi-ai:` section so `dsh-settings-file` hot-reloads it. Spike 2 = hot-reload available; implemented `refreshDshModels()` + `POST /api/models/refresh` (re-runs `writeLlmProfile` → settings.yaml rewrite → dsh hot-reload, no restart; active model untouched, selector refresh broadcast).
- [x] 5.3 Close the `/api/litellm/credentials` browser leak (`server.js:1277`): remove the route that returns `LITELLM_API_KEY` to the browser in local mode; the `/ui` iframe's server-set cookie auto-login already covers local mode.

## 5. Local-file attachment (Composer paperclip)

- [x] 6.1 Add a paperclip affordance to `Composer.tsx` (native `<input type="file">`); on select, upload via the existing `POST /api/documents` FormData path (`documents-api.ts` `uploadFile`, the path that already works in `DocumentsPage.tsx`). No new endpoint, no new server storage.
- [x] 6.2 On upload success, inject a reference token (`@doc:<id>`, default per design Open Question 3) into the Composer input so the outgoing prompt references the ingested document; allow multiple attachments.
- [x] 6.3 In `server.js` prompt handling, expand `@doc:<id>` tokens server-side into the context dsh sees (mirror how `/skill:` tokens are already manually expanded before `session.prompt()`). No new dependency.

## 6. Chat-history consistency

- [x] 7.1 In `streamRemoteChat` (`server.js:615–654`), call `recordMessage()` (`chat-history.js:104–117`) on remote turn completion so catalog `agent-remote` turns persist to the SQLite mirror like local turns — closes the dangling-user-message bug on browser close/reopen.

## 7. Cleanup

- [x] 8.1 Remove the dead workdir picker: delete the Sidebar "Working Directory → Change" control (`Sidebar.tsx:134–164`), the `rebuildAgentForWorkdir` throw (`server.js:507–514`), the `set_workdir` WS case (`server.js:1005–1025`), and the workdir i18n strings across all locales. Leave `pickWorkdir` in the Electron preload (harmless, unsurfaced).
- [x] 8.2 Rename the i18n assistant display name from `"pi"` to **"Find Data Technology"** across all 5 locales (en/zh-CN/es/fr/ja) in `composer.placeholder` and `turn.assistantName`.
- [x] 8.3 Sweep stale `pi`→dsh migration leftovers: comments referencing deleted `public/app.js` (Composer.tsx, useChatStore.ts, useWebSocket.ts), the `AGENT_RUNTIME` branch language in `catalog.js:15`. The `.pi/` directory is git-tracked agent tooling (mirrors `.claude/`), not app runtime — left in place (deletion is a separate repo-visible decision).
- [x] 8.4 Gate `window.__chatStore` behind `import.meta.env.DEV` (`useChatStore.ts:337–339`) so the Zustand store isn't globally readable/mutable in production. (The e2e consumer that needed it in the prod build is gone, so the "deliberately not gated" rationale is stale.)
