# Tasks — redesign-bots-surface

## Server

- [x] 1. Add `qrcode` dependency (`package.json`) and a tiny
  `server/bots/qr.js` helper wrapping SVG generation (URL validation:
  http/https only, length cap).
- [x] 2. Extend each adapter's registry descriptor with a `qr` strategy:
  telegram → `telegram-me`, wechat-oa → `wechat-qrcode`, feishu/wecom →
  `manual` (+ add the non-secret `qrUrl` field to their
  `credentialFields`).
- [x] 3. Telegram resolver: `getMe` via the stored token →
  `https://t.me/<username>`; map API errors to typed failure states.
- [x] 4. WeChat OA resolver: access token (reuse the existing token
  helper) → `qrcode/create` (`QR_LIMIT_STR_SCENE`) → showqrcode URL; map
  unsupported-account/API errors to the manual fallback state.
- [x] 5. `GET /api/bots/:id/qr` in `server/routes/bots.js`: 404 unknown,
  per-strategy resolver, `{ strategy, url, qr, hint, error? }`, failure
  isolated (never 500s the management surface).
- [x] 6. Include the `qr` descriptor in `GET /api/bots` `types[]`.

## Web

- [x] 7. `web/src/components/bots/BotPlatformIcons.tsx`: four small
  self-authored inline brand SVGs.
- [x] 8. `BotsPage` redesign: platform tile grid
  (`data-testid="bot-platform-tile"`) opening the add dialog preselected;
  configured-bot list kept with brand icons + existing controls.
- [x] 9. BotForm dialog: QR panel
  (`data-testid="bot-qr-panel"`) shown after first save — resolving
  spinner, QR SVG + URL + copy + per-platform hint, manual fallback with
  the `qrUrl` field; no layout jump between states.
- [x] 10. `bots-api.ts`: `getBotQr(id)` typing + states.
- [x] 11. i18n strings for all new UI in en + zh-CN bundles.

## Verify

- [x] 12. e2e (`e2e/bots-surface.spec.js`, data-testids from the spec):
  grid renders four tiles; tile opens typed add dialog; QR panel states
  (resolved via route stub, missing-link manual prompt, upstream-error
  fallback); unknown bot 404; existing CRUD + masking assertions still
  pass.
- [x] 13. Run full fast e2e suite + `npm run web:build`; manual check
  against one real Telegram token if available.
