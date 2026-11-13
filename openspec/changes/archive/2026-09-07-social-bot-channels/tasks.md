## 1. Storage + registry

- [x] 1.1 `db.js`: `bots` table (id, type, name, enabled, credentials JSON, created_at); idempotent migration
- [x] 1.2 `server/bots.js`: `initBots({ db, bridge, publicBaseUrl })` — loads enabled bots, builds adapter instances, mounts nothing yet; start/stop per bot; every adapter failure isolated (log + disable-not-crash)
- [x] 1.3 Adapter interface + registry: `server/bots/adapter.js` exports `{ verifyWebhook, parseMessage, sendText, credentialFields }` contract + a shared self-check runner

## 2. Session-aware event pump (pre-existing single-session assumption lifted)

- [x] 2.1 `dsh-bridge.js`/`dsh-events.js`: notifications carry session id — route web-session events through the existing broadcast path unchanged; non-web sessions route to a registered per-session collector (`registerSessionCollector(sessionId, handler)`)
- [x] 2.2 Bot turn runner: prompt → collect final assistant text (assistant/message) until session.status idle → `sendText`; error mid-turn → short error reply; per-chat queue serializes turns within a chat, chats run in parallel
- [x] 2.3 Session id derivation `bot-<botId>-<sha1(chatKey)16>`; verify dsh resumes a bot session across bridge restarts (model switch mid-bot-chat)

## 3. Adapters (one platform per task, each with its official-doc-verified verify/parse/send + self-check)

- [x] 3.1 `telegram.js`: sendMessage + webhook mode + getUpdates polling fallback (when no public base URL); BotFather-token config
- [x] 3.2 `feishu.js`: URL challenge echo, encrypt_key AES-GCM decrypt, event v2 → im message, tenant_access_token cache/refresh, im/v1/messages send
- [x] 3.3 `wecom.js`: echo-verify AES(GBK) decrypt, XML text parse, corpid/secret access_token cache, message/send
- [x] 3.4 `wechat-oa.js`: token+timestamp+nonce signature check, XML text parse, 48h customer-service send
- [x] 3.5 Self-checks: each adapter exposes a `main` block proving verify+parse on a captured/synthetic official payload (assert-based, no framework)

## 4. HTTP surface + guards

- [x] 4.1 `POST/GET /api/bots/webhook/:botId/:secret`: per-bot secret match → adapter verifyWebhook (echo replies for platform challenges) → parseMessage → guards (length cap 4k, per-chat rate bucket 10/min) → `BOTS_ALLOW_TOOLS` posture → bot turn runner; 403 on any auth failure (no content logged)
- [x] 4.2 Config REST: `GET/POST/PATCH/DELETE /api/bots` (+ `/api/bots/:id`), credentials masked in responses, per-adapter credential validation on save, admin-gated under forward_auth; webhook URL string in responses
- [x] 4.3 `POST /api/bots/:id/send { chatKey, text }` — admin-gated proactive send
- [x] 4.4 forward_auth exemption list: webhook routes exempt from X-Forwarded-Email (platform-verified instead); documented in code + spec

## 5. UI

- [x] 5.1 `web/src/lib/bots-api.ts` typed client
- [x] 5.2 `/bots` page: list + create/edit dialogs per type (credentialFields-driven forms), enable toggle, webhook URL copy, delete confirm — pattern follows AgentsPage/ExtensionsPage
- [x] 5.3 Sidebar nav entry + routes + locales ×5 (`check:locales` green)

## 6. Verification

- [x] 6.1 Covered by `scripts/test-bots.mjs` (`npm run test:unit`) rather than the Playwright fast project: real Express routes + real bots module against a stub dsh bridge, so the full webhook→verify→parse→guards→prompt→sendText path runs with no LLM. Config CRUD, wrong-secret/unknown-bot/disabled-bot 403s, and a synthetic telegram update driving a turn with the sendText call recorded.
- [ ] 6.2 Manual against real platforms (one account each): telegram (BotFather sandbox), feishu demo app, wecom test corp, wechat-oa test account — challenge verify + one round-trip each; record findings in this change's design addendum
- [x] 6.3 Guard check: oversized message rejected; rate-limit triggers; `BOTS_ALLOW_TOOLS` unset → tool calls absent from bot turn
