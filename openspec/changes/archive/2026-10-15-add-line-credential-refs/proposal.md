# Proposal: add-line-credential-refs

## Why

五线操作面收官挂账（C3.1 + C2.1 + lex ref）：wire-ops-mcp（31896）、lex-ops-mcp（31897）、
wanxing-ops-mcp 的 turn 工具（31895）都已生产在跑，但壹座侧没有凭据轨道——用户要手动
带 ID token/caller key。按家族模式（connector-credentials/facet-market-credentials）补齐
三个 ref，让"AI 操作各线"的凭据与检索同等待遇（粘贴即连接/静默铸/注入/401 翻面）。

## 机制核查（2026-10-15 实证）

| ref | 凭据 | 机制 | 壹座侧形状 |
|---|---|---|---|
| `wire-customer` | Logto ID token（aud=wire SPA i0oxdswqxv4x7te99iukv，短命） | **浏览器 PKCE+prompt=none 静默铸**（同租户会话已实证：首次需一次交互授权，此后静默发 code→token 端点换 ID token）；aud 不匹配问题实测存在——壹座后端不可代铸 | 静默铸+短命缓存+过期即重铸（无 12h 终牌问题——随时可重铸） |
| `lex` | Logto ID token（aud=lex SPA 91kqy7xgs9dstnr0i2qyu） | 同上（lex auth/config 公开 client_id+scopes） | 同 wire-customer |
| `wanxing-caller` | caller `sk-`（sub2api，长命） | **粘贴**（面板自铸，token.finddatatech.cloud） | connector 家族粘贴原样 |

## What Changes

- 新模块 `line-credentials.js`：按线（wire/lex）存 ID token 缓存（token+exp）+ wanxing-caller
  存 `sk-`（长命）；`liveToken`（wire/lex 过期前 10min fire-and-forget 静默重铸——重铸在
  浏览器端触发，服务端只回缓存）/`markInvalid`（wire/lex 401→清缓存等下次浏览器重铸；
  wanxing 401→stale 提示重贴）；投影 token-free。
- db 迁移 v29：`user_line_credentials`（email, line PK；token, token_exp, stale, updated_at；
  wanxing-caller 复用同表 line="wanxing-caller"）。
- `credential-refs.js` 注册三 ref。
- 路由 `server/routes/line-credentials.js`（家族同款）：`GET /api/lines/:line/connection`、
  `POST /api/lines/:line/credential`（wire/lex 收浏览器铸的 ID token；wanxing-caller 收 sk-
  粘贴）、`DELETE`（断开）。
- **浏览器静默铸** `web/src/lib/line-mint.ts`：PKCE+prompt=none→code→token 端点→POST 后端；
  首次 consent_required 时降级弹一次该线登录窗（授权一次后永久静默）。设置面板 MCP 市场
  区加两卡（柏讯/识律）+萬星 caller 粘贴卡。
- **注入语义**：wire-ops/lex-ops MCP 行的 Authorization 注入（mcp.json 基线加 wire-ops/lex-ops/
  wanxing-ops 三行 credentialRef）；**wire/lex ID token 短命（~10min-1h）——liveToken 返回
  空时省略 server 行并在浏览器打开该线页面时自动重铸**（增量语义：与 facet-market 的
  后台静默续登不同，ID token 的重铸由浏览器会话驱动；spec 声明该差异）。

## Capabilities

### New Capabilities

- `line-credentials`：三线凭据 ref 契约（静默铸/粘贴/注入/翻面/短命 ID token 的省略-重铸语义）。

### Modified Capabilities

（无）

## Impact

- 壹座 web（两卡+一粘贴卡）、db v29、mcp.json 基线三行、credential-refs+2。
- 各线零改动（aud/token 全由各线自己的 Logto app 签发——不破坏上游权威）。
