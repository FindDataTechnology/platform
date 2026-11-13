# Design: add-line-credential-refs

## D1 — 一个模块管三线（line 是维度）

`line-credentials.js` 按 line ∈ {wire-customer, lex, wanxing-caller} 分槽；一表 v29
（email, line PK）。ID token 线（wire-customer/lex）与长命粘贴线（wanxing-caller）行为分型：

| 行为 | wire-customer / lex（短命 ID token） | wanxing-caller（长命 sk-） |
|---|---|---|
| 建立 | 浏览器 PKCE 静默铸（首次一次交互授权）→ POST 后端存 | 面板粘贴（token.finddatatech.cloud 自铸） |
| 过期 | exp 前 10min 标记；liveToken 返回 null→该 server 行省略 | 不过期（revocation 驱动） |
| 恢复 | 浏览器会话打开壹座时自动重铸（line-mint.ts 扫描+刷新） | 用户重贴（401→stale） |
| 401 翻面 | markInvalid 清缓存（下次浏览器重铸即愈） | markInvalid→stale（facet-market 同款） |

## D2 — 服务端中介的授权码往返（rev. 2026-10-15：原浏览器弹窗方案在真实页面不可行）

原方案（浏览器弹窗 + 轮询弹窗 `location.href` 抓 code）**在真实页面里永远不可能工作**：
跨域读弹窗 location 必抛 SecurityError（浏览器同源策略），且 wire 的 `auth/config` 端点
无 CORS 头（lex 有 `*`）——首步 fetch 即断。当初的"可行性实证"是自动化层直读地址栏做的，
绕过了同源策略，验证形态与真实页面能力有缝。**修法：整链改服务端中介。**

```
浏览器 GET /api/lines/:line/mint/start
  ├─ 服务端读该线 auth/config（服务端无 CORS 问题）
  ├─ 302 → {issuer}/oidc/auth?client_id={line}&redirect_uri={平台}/api/lines/:line/mint/callback
  │     &prompt=none&PKCE(S256)&state&nonce      （PKCE+state 存签名 cookie）
  └─ Logto 会话静默通过 → 回调平台 origin
        ├─ 首见 login_required/consent_required → 重定向 start?interactive=1（去 prompt=none）一次
        ├─ 校验 state（签名 cookie）→ 服务端 POST {issuer}/oidc/token（code_verifier，无 secret）
        └─ 存 ID token（按调用者身份）→ 302 /settings/mcp → profile 重应用
```

- 两个 client 的 `redirectUris` 各加平台回调（已注册：`…/api/lines/{wire-customer,lex}/mint/callback`）——
  这是同源读的**前提**；Logto 即时生效，无需重启。
- code→token 交换在服务端：无 CORS、token 不经过浏览器 JS、无 client secret（两线 client 均 SPA，PKCE 足够）。
- 失败诚实回落：`/settings/mcp?lineError=<line>`，面板显示一行可读错误；日志不回声上游 body。
- nonce/state 平台自校（state 防伪造回调；nonce 透传给上游 token 交换，验签仍由 wire/lex 做——上游权威）。

## D3 — 注入与 mcp.json 基线

mcp.json 三行（configmap）：

```json
"wire-ops":     { "url": "http://cheap6.mesh.finddata.cn:31896/mcp", "credentialRef": "wire-customer" },
"lex-ops":      { "url": "http://cheap6.mesh.finddata.cn:31897/mcp", "credentialRef": "lex" },
"wanxing-ops":  { "url": "http://cheap6.mesh.finddata.cn:31895/mcp", "credentialRef": "wanxing-caller" }
```

liveToken 短命语义：ID token 过期→server 行省略（壹座 preflight 报 auth-rejected/omit）；
浏览器会话重铸后下次写入恢复。wanxing-caller turn 工具的用户体验：装包后 agent 调 turn
时凭据自动注入——caller key 仍是用户级计费身份（边界结算语义不变）。

## D4 — 路由与面板

- `GET /api/lines/:line/connection`（token-free 投影：connected/stale/expiresAt/line）；
- `POST /api/lines/:line/credential` {token}：wire/lex=ID token（形状校验 JWT 三段+exp 解析）；
  wanxing-caller=`sk-` 前缀校验；存后 reapplyProfile；
- `GET /api/lines/:line/mint/start` + `/mint/callback`：ID-token 线的服务端中介往返（D2 rev.）；
- `DELETE /api/lines/:line/connection`。
- 面板：McpMarketView 加三卡（柏讯/识律=「连接」整页跳 start；萬星 caller=粘贴框+面板链接）。

## 不做

- 壹座后端代铸 ID token（aud 不匹配，实测拒绝——各线 Logto app 的 token 只能浏览器取）。
- refresh token 轨（壹座 callback 现在不收 refresh_token；引入它=改登录链，收益低——
  静默铸已够）。
