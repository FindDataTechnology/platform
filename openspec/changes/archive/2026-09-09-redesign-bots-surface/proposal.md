# redesign-bots-surface

## Why

`/bots` is a text list: a type dropdown, generic credential inputs, and a
webhook URL to copy. The four supported platforms (Telegram, 飞书, 企业微信,
微信公众号) have no visual identity, and the hardest part of onboarding —
"how do end users actually reach this bot?" — is left entirely to the
operator. Each platform's answer is a QR code (follow the official account,
open the bot, add the app), which the page neither produces nor explains.

## What Changes

- **Platform icon grid as the entry surface**: `/bots` opens on a grid of
  the four supported platforms with brand icons and names. Clicking a
  platform tile starts the add-bot flow with that type preselected. Configured
  bots render as cards carrying their platform's icon, enable toggle, and
  webhook URL (existing behavior preserved).
- **Per-bot onboarding QR in the config dialog**: a saved bot's edit dialog
  gains a "扫码配置 / 用户入口" section showing a scannable QR plus the
  underlying link and short setup steps, per platform:
  - **Telegram** — server resolves the bot username via
    `getMe` (token never leaves the server) and renders
    `https://t.me/<username>` as a QR.
  - **微信公众号** — server fetches the permanent QR via the platform
    `qrcode/create` API using the stored AppID/secret when the account type
    permits it; failure (unsupported account type / API error) falls back to
    manual link entry with the reason shown.
  - **企业微信 / 飞书** — self-built apps have no API-mintable follow QR; the
    section offers a manual link/image-URL field (the URL copied from the
    admin console) which the server renders as a QR.
- **New endpoint** `GET /api/bots/:id/qr` returning the resolved target URL
  plus a generated QR image (SVG). Credentials stay server-side; failures are
  per-source and never crash bot management.
- **New dependency**: `qrcode` (zero-dependency npm package) server-side;
  the frontend renders the returned SVG, no frontend QR library.
- i18n for all new strings (en + zh-CN); brand-icon SVGs authored in-repo.

## Capabilities

### New Capabilities
- (none)

### Modified Capabilities
- `social-bot-channels`: gains the icon-grid entry surface, the per-platform
  onboarding QR contract, the QR resolution endpoint, and the manual-link
  fallback. Bot CRUD, webhook verification, and credential masking are
  unchanged.

## Impact

- `web/src/pages/BotsPage.tsx` (grid + dialog sections), new
  `web/src/components/bots/` bits (brand icons, QrPanel), `bots-api.ts`.
- `server/bots.js` + `server/routes/bots.js` (QR resolution route + per-type
  resolvers), `server/bots/telegram.js` (`getMe` username lookup),
  `server/bots/wechat-oa.js` (permanent-QR API call), adapters advertise a QR
  capability descriptor.
- `package.json`: add `qrcode`.
- No DB schema change: the manual link for wecom/feishu is a new nullable
  bot-config column/key handled through the existing credentials/config JSON.
- e2e coverage for the grid, dialog QR panel states (resolved / loading /
  fallback), and data-testids.
