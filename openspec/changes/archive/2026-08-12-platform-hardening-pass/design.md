# Design - platform-hardening-pass

## 1. Concurrency gate (Cluster B)

### The race
`isStreaming` is the single guard that decides whether a second prompt `steer`s
into the in-flight turn or starts a fresh one. It is set inside the SDK's
`agent_start` event handler (`server.js:510`), which fires **asynchronously
after** `session.prompt()` has already yielded at its first `await`. So between
"prompt A calls `session.prompt()`" and "agent_start sets `isStreaming = true`"
there is an event-loop window in which prompt B's `if (isStreaming)` check sees
`false` and takes the non-`steer` branch - starting a second concurrent turn on
the same shared session.

### Fix
Set `isStreaming = true` **synchronously** on the non-`steer` path, immediately
before `await session.prompt(...)` (both the normal and skill branches). The
check-and-set is two adjacent synchronous statements with no `await` between
them, so it is atomic with respect to the event loop: a second prompt that
interleaves at A's `await` necessarily sees `isStreaming === true` and steers.

The `agent_start` handler's `isStreaming = true` becomes a harmless no-op
(idempotent); its `streamedTextThisTurn = false` reset is preserved.

### Design choice: steer (preserve) vs. reject vs. queue
The existing `chat-streaming` spec already mandates `steer` for concurrent
prompts, and the code branches on it deliberately. This change **preserves**
steer - it only fixes the race that made it unreliable. Rejecting or queueing
would be a larger behavioral change and is out of scope; the desktop-vs-platform
direction question (does multi-user need per-connection sessions?) is left open.

### Failure-path interaction
`finishTurn()` is idempotent (`if (!isStreaming) return;`). Today, if
`session.prompt()` rejects before `agent_start` fires, `isStreaming` stays
`false`, `finishTurn()` no-ops, and **no `done` is broadcast** - the UI can
wedge. Setting the flag synchronously means the catch's `finishTurn()` now
reliably resets state and emits `done`, which matches the existing
"failed turn re-enables the UI" requirement. This is a strict improvement.

### Why not a separate `promptInFlight` flag
Tempting, but `isStreaming` already carries the "turn in flight" semantic that
the steer branch reads. Introducing a second flag invites them to drift apart.
One flag, set synchronously, is the minimal correct fix.

---

## 2. Remove baked-in API key (Cluster C)

### Current state
`server.js:36`:
```js
const VOLCES_API_KEY = process.env.VOLCES_API_KEY || "ark-24959dea-...";
```
The fallback is a real, billable key. It is in git history and bundled into
shipped installers.

### Change
```js
const VOLCES_API_KEY = process.env.VOLCES_API_KEY?.trim();
const volcesEnabled = Boolean(VOLCES_API_KEY);
```
- `initAgent`: build `agentProviderFactory` only when `volcesEnabled`.
- `buildAndBindSession`: `extensionFactories` becomes
  `litellmEnabled ? [litellmExtension] : (volcesEnabled ? [agentProviderFactory] : [])`.
  An empty array means no chat provider; the SDK still creates a session (model
  resolves to `null`/SDK default) and the server stays up.
- `resolveDefaultModel()` already returns `null` when no authed model exists;
  `buildAndBindSession` already logs "No default model resolved; falling back to
  SDK default". No change needed there.

### Spec conflict (BREAKING)
The existing `web-chat-server` requirement "Server fails without API key"
mandates `exit(non-zero)` when no key is configured. The codebase convention
(CLAUDE.md: "degrades gracefully when optional config is missing - it always
starts") and the LiteLLM precedent already contradict this. This change
**removes** that requirement and replaces it with graceful-degrade. The dev
`.env` has `VOLCES_API_KEY` set, so local dev is unaffected.

### Documents RAG
`documents.initStore({ baseUrl: VOLCES_BASE_URL, apiKey: VOLCES_API_KEY, ... })`
(`server.js:1991`) receives `undefined` when the key is unset. `initStore` sets
`process.env.OPENAI_API_KEY = apiKey` and builds a LlamaIndex provider; with an
undefined key, indexing/query calls will fail at call time, not at startup. This
is acceptable graceful degradation (documents panel already degrades when the DB
is unavailable). No code change required, but the startup log should note when
the documents RAG is running without a key.

### Packaging
`electron/main.js:71-73` already uses a `sk-xxx-baked-fallback` **placeholder**
(not the real key) when `settings.json` lacks `VOLCES_API_KEY`. Its comment
("use the baked fallback from server.js") was already misleading; after this
change it is simply stale. The desktop app must provision a real key via
`settings.json` (the preferences UI already exposes `VOLCES_API_KEY`). No code
change to electron; the comment can be updated for accuracy.

### Gating decision (surfaced for confirmation)
Graceful-degrade is the codebase convention and the LiteLLM precedent. The
alternatives - hard-fail, or dev-only fallback - were considered and rejected:
hard-fail contradicts the always-starts convention; dev-only fallback still
keeps a real key in the repo (just gated), not fully fixing the leak. If the
operator prefers hard-fail when **no** provider is configured, that is a one-line
change at the end of `initAgent`.

---

## 3. Hygiene (Cluster A)

### i18n wiring
`DocumentsPage.tsx` uses hardcoded English literals throughout; the
`documents.*` namespace (`en/common.json:92-137`) and `composer.uploaded` /
`composer.uploadFailed` (`en/common.json:41-42`) already exist and are in sync
across all five locales (guarded by `check:locales`). The fix is pure `t()`
wiring - no new keys, no locale edits. Each sub-component
(`DocumentsPage`, `IngestSection`, `QuerySection`, `CollectionsSection`) gets its
own `useTranslation()` call. URL-example placeholders (`https://example.com/page`)
stay literal - they are not prose.

### Zustand selectors
Three call sites (`DocumentsPage.tsx:18,166,196`) do `useDocumentsStore()`
with no selector, subscribing to the whole store. `setDocQuery` (query box
keystroke) mutates `docQuery`, re-rendering all three components + the doc tree.
Fix: select only the slices each component reads, using `useShallow` from
`zustand/react/shallow` (v5) for multi-field selectors; actions are stable
references and selected individually (no `useShallow` needed). This is an
internal refactor with no behavior change.

### cron + async rejection gaps
- `cron_remove/pause/resume/run` (`server.js:926-953`): wrap each in `try/catch`
  emitting `{type:"error"}`, mirroring `cron_add` (`:917`). Pure addition.
- `workdirStore.getWorkdir(curId).then(...)` (`:798`): add `.catch` logging.
- `shutdown()` (`:2026`): wrap the `closeMcpClients` await in `try/catch` so a
  rejection does not prevent `process.exit(0)` (or hang).
- `createWebProxy` (`:1714`) and `proxyLitellmUi` (`:1858`): wrap the
  `await upstreamRes.arrayBuffer()` read in `try/catch` returning 502. The
  `fetch` itself is already caught; this covers a response-stream error. (Other
  uncovered async paths in these handlers - e.g. raw body-stream rejection -
  are left; they are rare and out of the named scope.)

### WS reconnect backoff
`useWebSocket.ts:57-66` reconnects on a fixed 2000ms loop forever. Replace with:
exponential backoff `min(30000, 1000 * 2^attempt)` + ±25% jitter, a max-retry
cap (e.g. 20 attempts) after which it stops hammering, and an `online` event
listener that triggers an immediate reconnect (so a laptop wake doesn't wait
for the next timer tick). Reset the attempt counter on a successful `onopen`.
The `cancelled` unmount guard is preserved.

---

## Out of scope (explicitly)
- Per-connection / per-user session isolation (direction-dependent).
- `server.js` file decomposition, route extraction (only if pain is felt).
- Backend unit-test harness (targeted `node:test` for脆 paths is a separate
  change).
- Dependency pinning (`latest` -> caret/exact) - separate change.
- Route-level code splitting in the web bundle - value depends on deploy target.
