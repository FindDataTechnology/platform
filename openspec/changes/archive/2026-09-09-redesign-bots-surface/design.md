# Design — redesign-bots-surface

## D1 — Layout: platform grid first, configured bots below

```
/bots
+--------------------------------------------------------------------+
|  社交机器人                                                    [+]  |
|                                                                    |
|  +-----------+ +-----------+ +-----------+ +-----------+          |
|  | [TG icon] | | [FS icon] | | [WX icon]  | | [OA icon] |          |
|  | Telegram  | | 飞书       | | 企业微信    | | 微信公众号  |          |
|  +-----------+ +-----------+ +-----------+ +-----------+          |
|  点击图标 → 以该类型预开添加弹窗                                    |
|                                                                    |
|  已配置:                                                            |
|  +----------------------------------------------------------------+|
|  | [TG icon] 客服机器人            [switch] [edit] [delete]        ||
|  | webhook URL ...                              [二维码]           ||
|  +----------------------------------------------------------------+|
+--------------------------------------------------------------------+
```

The platform tiles come from the existing `/api/bots` `types[]` descriptor
(the single source for the credential form), extended with a `qr` capability
field:

```js
{
  type: "telegram",
  credentialFields: [...],
  qr: { strategy: "telegram-me", labelKey: "botsPage.qr.tgHint" }
}
// wechat-oa: { strategy: "wechat-qrcode" }
// feishu/wecom: { strategy: "manual", field: "qrUrl" }
```

No new registry: `BOT_TYPES` already drives both the server descriptor and
the form. Brand icons are four small self-authored inline SVGs (lucide has no
brand set; no icon dependency is added).

## D2 — QR resolution is server-side; the browser receives a URL + SVG

`GET /api/bots/:id/qr` →

```json
{ "strategy": "telegram-me", "url": "https://t.me/acme_bot",
  "hint": "在 Telegram 中打开链接并点击 Start",
  "qr": "<svg …>" }
```

- Credentials never cross to the browser: `getMe` (Telegram) and
  `qrcode/create` (WeChat OA) are called server-side with stored secrets.
- QR generation uses the zero-dependency `qrcode` npm package, returning an
  inline SVG the dialog renders in an `<img src="data:image/svg+xml,…">`.
  One new dependency, server-side only; the frontend stays library-free.
- Resolvers are failure-isolated like every other adapter call: upstream
  errors / unsupported account types produce
  `{ strategy: "manual", error }` — the dialog shows the manual-link input
  and the reason instead of breaking bot management.
- Telegram/WeChat resolutions are fetched on demand per QR-panel open (the
  panel is an infrequent admin action and both lookups are one cheap API
  call); no caching, no schema change.

WeChat OA permanent QR: `POST cgi-bin/qrcode/create` with
`action_name: QR_LIMIT_STR_SCENE`, then
`https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=<urlencoded>`. Only
verified/subscription-capable service accounts accept the call; the error
message from WeChat is surfaced verbatim in the hint area and the manual
fallback opens.

## D3 — Manual link as a declared credential field

For feishu/wecom (self-built apps have no API-mintable user-facing QR), the
type descriptor adds a non-secret field `qrUrl` ("用户入口链接", the
operator pastes the app/admin-console URL end users should open). It flows
through the existing credential form + PATCH merge with zero schema/UI
plumbing, and the QR endpoint renders it. Telegram/wechat-oa hide this field.

## D4 — States the dialog must show

| State | UI |
|---|---|
| unsaved bot | credential form only; QR section appears after save |
| resolving | spinner, no layout jump |
| resolved | SVG QR + URL + per-platform steps + copy button |
| fallback | reason text + manual URL input (save → re-resolve) |
| disabled bot | QR still viewable, with a "已停用" note |

## Out of scope

- QR-login of the bot's own account (wechaty-style personal WeChat) — new
  adapter class, explicitly separate.
- Per-chat invite links, analytics, scan counts.
- Editing credentials flow itself (unchanged; blank = keep stored).
