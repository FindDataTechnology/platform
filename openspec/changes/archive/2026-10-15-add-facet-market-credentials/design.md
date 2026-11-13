# Design: add-facet-market-credentials

## D1 — 不存终牌，存设备身份

市场平台 app token = JWT（exp=iat+12h），过期即废。模块按 identity 恰好持有一台设备
`yizuo-facet-market-<emailHash>`：Ed25519 密钥对（私钥仅存本库+内存，永不出现在任何响应/
日志）、配对态（facet 侧账号 email、pairedAt）、token 缓存（含 exp）。铸造流程照
device-pairing-auth 协议：`POST {market}/api/app/challenge` → Ed25519 签
`deviceId:nonce`（UTF-8，base64url）→ `POST {market}/api/app/login` → token。
公钥格式=raw 32B base64url（43 字符，服务端 PUBKEY_RE 强制）。

## D2 — 同步契约下的异步铸造

credential-refs 的 `liveToken(email)` 是同步契约（resolveCredentials 同步循环）。解法：

- `liveToken`：缓存 token 且 exp 余量 >10min → 直接返回；余量不足 → 返回现有值（可能为
  null）**并 fire-and-forget `ensureFresh`**（下次写入即拿到新值）。
- `ensureFresh(email)`：per-identity 串行 promise 锁——挑战槽单占用（app-auth 一 device
  一 slot，挑战即替换），并发第二 login 必 401；锁内 challenge→login→缓存。
- 吊销语义：login 401 `binding_required` → stale=true、清缓存（面板提示重新配对）；
  网络/5xx → 不动缓存（照存纪律：探针故障不当凭据失效）。

## D3 — 401 翻面与恢复

`markInvalid(email)`：清 token 缓存、stale=true，返回状态是否翻转（恰一次重应用——与
registry/connector 同契约）。恢复路径：下一次有效 profile 写入触发 liveToken→缓存空→
ensureFresh 静默重登成功 → stale 清除 token 回来（**自动恢复**）；若 binding 被吊销则
重登 401，保持 stale，等用户重新配对。stale 时 liveToken 返回 null（该 server 被省略）。

## D4 — pack-store ref 数据驱动

`pack-store.js` 安装 registry 来源 MCP 时：`credentialRef = entry.metadata?.credential_ref
?? "registry"`；连接门槛同理分派（facet-market→本模块 status.connected；registry→现行）。
facet-market-mcp 条目的 metadata 由运维 PATCH（一次动作，随本 change 上线清单）。

## D5 — 配对路由与面板（镜像 connector 家族）

- `GET /api/facet-market/connection`：状态投影（connected/paired/stale/tokenExpiresAt
  /facetAccount/pairedAt）+ `facetUrl`（指路：facet 设置页生成绑定码；部署配置非机密）。
- `POST /api/facet-market/pair` {code}：6 位绑定码校验→（复用或新生成）设备密钥→
  `POST {market}/api/app/pair`（失败 401/400 原样透传给面板）→ 首枚 token 即刻验证存缓存。
  重复配对=同 identity 重绑（旧 deviceId 交由 facet 侧设备管理页吊销，本地整体替换）。
- `DELETE /api/facet-market/connection`：删本地行；best-effort `DELETE
  {market}/api/app/bind/:deviceId`（带现有 token）。
- 面板：设置→MCP 区新增「谦面市场」连接卡（绑定码输入框+状态+断开），复用
  ConnectorConnectPanel 交互语言。

## D6 — 市场基址

`FACET_MARKET_URL`（默认 `https://facet.finddatatech.cloud`）。**不得**沿用
`FACET_BASE_URL`——生产实证它是 k8s service 注入的同 pod facet 内部服务基址
（http://127.0.0.1:3200），而设备配对协议+面板指路都在市场公网域上。2026-10-14 修正。

## 不做

- 多市场/多账号 slot（市场身份唯一；要再来一刀时按 connector-account-picker 模式扩）。
- 壹座侧设备列表管理（facet 设置页已有）；token 明文给前端（永不）。
