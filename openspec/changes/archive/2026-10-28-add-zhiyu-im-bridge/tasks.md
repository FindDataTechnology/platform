## 1. Binding model & management REST

- [x] 1.1 `bots.zhiRoomId` migration (guarded ALTER) + store helpers (get/set/unset scoped to the bot's owner). Verify: idempotent migration + store unit tests pass.
- [x] 1.2 `gateway/zhiyu/im-bridge.js`: GET/PUT/DELETE `/api/zhiyu/im-bridge/bots/:botId/room`, owner-only with 404-shaped invisibility. Verify: the three binding scenarios in the spec pass.
- [x] 1.3 Audit rows on every binding change (who, when, which room)——v1 = console 审计行（专用 file audit 追加后置，不阻）。Verify: PUT 写明 bot/room/actor 的日志

## 2. Cell-side inbound (IM → room)

- [x] 2.1 `server/zhiyu-im-bridge.js`: pre-hook on the bots.js inbound path — bound bot routes to the bridge (no agent-turn), unbound goes unchanged through the legacy session path. Verify: both spec scenarios pass.
- [x] 2.2 Sender seats: `im_<12 hex of sha1(chatKey:imUserId)>` as ref, `senderName` as display, member meta `im:{platform,chatKey,senderName}`. Verify: the same sender reuses one seat (suite test).
- [x] 2.3 Appending the human row triggers the EXISTING humanMessageHook — no router changes. Verify: room router processes an IM guest message exactly like a web guest message.

## 3. Gateway-side output subscription face

- [x] 3.1 Read-only, bot-scoped event subscription for the cell's forwarder (`after=<seq>` replay), gated to the binding's room. Verify: cross-room subscription is refused (403).
- [x] 3.2 Kind filter: `kind=agent` rows + room_ended/budget_exhausted/needs_you only; meta.im rows never included. Verify: the bridge's own messages never come back.

## 4. Cell-side delivery pipeline

- [x] 4.1 Outbound sendText per platform with seat attribution on the first chunk and honest splitting at the platform's practical cap. Verify: long answers arrive as ordered chunks.
- [x] 4.2 Per-bot last-sent sequence cursor persisted so restarts never duplicate a send. Verify: restart produces zero duplicates.
- [x] 4.3 Outbound bucket 60/min per bot; failures are logged, retried once, and then surfaced as an honest room event. Verify: scenarios pass.

## 5. Visitor continuity & billing

- [x] 5.1 scopeSeed=`room:<roomId>:<senderRef>` lands in dispatch (agent turns from IM see the same visitor-scope shape as web guests). Verify: lane receives it (suite assertion).
- [x] 5.2 Answers triggered by IM guests settle into the seat's deployment billing key with the `-guest` usage-id suffix。Verify: IM guest 与 web guest 同形（member.kind=guest → router 给 usage id 后缀），机制由既有断言（widget 套件 3.2 usageId `-guest`）正面勘误

## 6. Bots surface (UI)

- [x] 6.1 Add the "房间挂接 (room binding)" field on the bot edit card: shows current binding, saves a roomId, unbinds cleanly. Verify: owner can do all three from the panel.
- [x] 6.2 Locales: zh-CN/en proper, es/fr/ja placeholders per repo discipline. Verify: check-locales passes for all five.

## 7. Tests & regression

- [x] 7.1 `scripts/test-zhiyu-im-bridge*.mjs` suite green + all existing zhiyu suites still green. Verify: `node --test scripts/test-zhiyu-* scripts/test-zhiyu-im-bridge*`.
- [x] 7.2 Full-unit regression shows zero new reds (parallel-session artifacts excluded and proven again at the clean commit); web typecheck/biome/locale parity/build all green.

## 8. Release & walkthrough

- [x] 8.1 Snapshot build → four-manifest roll (digests identical); gates stay off until verified, then enabled in ConfigMap with a pod restart. Verify: **sha-56b34db / digest 60f66990 / GitOps ec2fcf8**, four manifests (platform, platform-demo, facet, agent-runner-serving) all on that tag; pod `platform-59d84858f-kbqs7` runs `sha256:60f66990…`; `ZHIYU_IM_BRIDGE_ON=1` set in ConfigMap `platform-config` + `kubectl rollout restart deployment/platform`. In-image proof: `grep -c` in the running container found `owner_email AS ownerEmail` (db.js), `ownerFromRegistry` (gateway/bot-webhooks.js), `reloadBot` (server/routes/zhiyu-im-bridge.js), `sendFailures` (server/zhiyu-im-bridge.js).
- [x] 8.2 Production walkthrough on a **real signed WeChat-OA webhook** (the only webhook platform bot in prod; no Telegram test group exists). Verify, all in the ledger §15.73: (a) a real signed webhook returns 200 and lands in the room as `seq 2 human` with `meta.im{platform,chatKey,senderName}` and seat `im_6c64d841de65`; (b) the bot-scoped read face answers `{"rows":[]}` — no echo of what IM already said; (c) `room_ended` surfaces on that read face so IM is told; (d) the cell then makes a **real WeChat API call** (answered `40003 invalid openid` because the test recipient is fabricated) — the outbound lane is genuinely wired; (e) bounded retry observed live: `attempt 1/3` → `2/3` → `send failed 3x … SKIPPING that answer to unblock the stream`, cursor advanced 0→3, no further attempts; (f) unbind → next signed webhook is a plain `[bots] "test" inbound` with no bridge line, i.e. the legacy path is restored.
- [x] 8.3 `openspec validate add-zhiyu-im-bridge --strict` passes with zero errors; §15 ledger + memory updated.

### Defects this walkthrough caught (all fixed and shipped in the same train)

- **Binding needed a pod restart** (`332d68d9`): the management REST wrote the row but `state.bots` is built at boot, so the inbound hook read `zhiRoomId: null` until restart — violating the spec's "the bot's NEXT group message takes the bridge". Fixed with `reloadBot(updated)` after both PUT and DELETE.
- **Empty machine actor → 401** (`fa306bfc`): `BOT_COLS` never selected `owner_email`, so `bot.ownerEmail` was `undefined`; the bridge sent an empty `x-actor-email` and the gateway answered exactly `{"error":"machine credential required"}`, silently degrading every message to the legacy path. Fixed by selecting the column plus a `CELL_USER_EMAIL` fallback, and by draining non-2xx bodies (an unread body poisoned the keep-alive socket, which is what the log's misleading `fetch failed` really was).
- **Legacy bot webhooks routed to the wrong cell** (`fa306bfc`): with `owner_email` NULL, the gateway's resolver fell back to "first session owner in the cell", which on a mixed-history cell was a DIFFERENT person → webhook delivered to their cell and refused as unknown. Fixed by consulting `cells-registry.db` (the authoritative cell owner) before session inference.
- **Unbounded outbound retry** (`9b1b5e38`): a permanently failing send re-attempted the same row every 2.5 s forever and pinned the cursor, blocking every later answer. Fixed with the design's own retry-three discipline: three attempts, then skip loudly and advance the cursor.

## 9. Follow-ups (NOT this change)

- [ ] 9.1 IM-native @-for-agents (Telegram @bot semantics vs. plain-text parsing) — apply-time decision.
- [ ] 9.2 Guest display refresh when an IM user renames.
- [ ] 9.3 External A2A seats (3B) as the next change.



## Appendix — release-train state as of 2026-10-28

- The snapshot `sha-5e4d680` (source `658552ad`) built fine, but the smoke gate
  refused the image: the container booted and died on
  `ERR_MODULE_NOT_FOUND: /app/server/routes/blueprints.js`.
- Root cause (confirmed): a parallel session merged an `import .../routes/blueprints.js`
  into server.js, but its three source files — `server/routes/blueprints.js`,
  `server/routes/blueprints-db.js`, `server/blueprint-validate.js` — are
  still **untracked** in the working tree, so the clean-clone snapshot
  (tracked files only) cannot contain them. The smoke gate caught it
  exactly as designed; production was never at risk.
- Verdict on ownership: **not this change.** Every file of phase 3
  (im-bridge) is tracked; node-level regressions all pass
  (10/10 suites green including the im-bridge suite itself).
  gate protection did its job.
- Handoff to the owner session: commit the three blueprint files, or revert
  the server.js import — either unblocks the whole release train for every
  session, not just this one.
