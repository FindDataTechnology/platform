# Design: add-paper-trading-credentials

## D1 — paste 形，单槽，无配对无续登

与 connector/facet-market 两轨同模式第三次的**最简实例**：服务凭据模型是 `fdt_` 前缀
长命 token（不过期、可吊销即时生效、服务只存 SHA-256），**没有设备配对协议**——
facet-market 的 Ed25519 设备身份与静默续登是为 12h TTL 服务的，这里一概用不上。
模块照 `connector-credentials.js` 裁剪：去掉多槽（slot/patId/setActive）、去掉
best-effort 远端吊销（粘贴响应不携带 token id，无吊销句柄；吊销是用户在服务 Web 的
自助动作）。每个 identity 至多一行，重复粘贴=整体替换并清 stale。

## D2 — 五件套与 refName 一字不差

| 契约件 | 取值 |
|---|---|
| refName | `"paper-trading"`——必须与 registry 条目 `metadata.credential_ref`（对方已 PATCH）一字不差，错一字=门放行后 resolver 查无、server 静默省略 |
| isRef(config) | `config?.credentialRef === "paper-trading"` |
| liveToken(email) | 有行且非 stale → 原样返回 token；否则 null（无过期概念，无异步分支——比 facet-market 的同步契约更简单，liveToken 天然纯同步） |
| markInvalid(email) | 置 stale 返回是否翻转（恰一次重应用，与三条既有轨同契约） |
| staleEvent | `"paper_trading_credential_stale"` |

401 翻面链路（server/dsh-events.js 的 `markCredentialStaleOn401`）完全表驱动：
`refFor` 查到行→markInvalid→WS 广播→profile 重写省略该 server。**注册即整链生效，
dsh-events 零改动**（已核实）。

## D3 — 探活：origin 单源 + advisory + 唯 401 硬拒

- 探活目标不硬编码：从 `mcp.json` 的 `paper-trading` 行读 URL 推 origin（照
  connector 的 `connectorRow()`/`connectorOrigin()`——运维基线是单一事实源，自托管
  者改一行即换靶）。probe = `GET <origin>/api/v1/accounts` + Bearer。
- 判决纪律与 connector 一致：**401=死 token/粘贴错误，硬拒不落行**；200/其他 4xx/
  网络失败/超时照存——服务临时不可用不得阻断保存凭据（探针是 advisory）。
- 入口形状检查：`fdt_` 前缀（对齐 connector 的 `oct_` 检查位）。
- mcp.json 行缺位（自托管未声明）时 paste 仍可用（仅形状检查），凭据链路在 fixture
  里可测——照 connector 的降级语义。

## D4 — 三处同批落地（handoff ⓪ 的闭环纪律）

`pack-store.credentialConnected` 现为二分派（facet-market / 其余→registry）。
装 paper-trading pack 的链路要闭合，三处必须同 change 落地，缺一即断：

1. `paper-trading-credentials.js` 五件套模块；
2. `credentialConnected` 加 `refName === "paper-trading"` 分派（修「错误按 registry
   放行→装好即静默消失」缺口）；
3. `credential-refs.js` 注册表加行。

装包侧其余零改动：`credentialRefForEntry` 已数据驱动（`metadata.credential_ref ??
"registry"`），未连接拒装 409 是既有行为。

## D5 — 路由与面板（镜像 connector 家族）

- `GET /api/paper-trading/connection`：状态投影（connected/stale/updatedAt）+
  `serviceUrl`（服务 Web 指路=注册/登录/铸 token 处；部署配置非机密）。
- `POST /api/paper-trading/connection` {token}：形状检查→probe→存/拒。
- `DELETE /api/paper-trading/connection`：删本地行（无远端吊销句柄，见 D1）。
- 匿名写拒绝（hosted 模式 401 门）与 identity 键（ssoUser/email，auth off=machine
  owner）照 connector 路由逐行镜像。
- 面板 `PaperTradingConnectPanel.tsx`：挂 McpMarketView 市场头（与
  ConnectorConnectPanel/FacetMarketConnectPanel 同列）；粘贴框+状态+断开，复用
  connector 面板交互语言。

## D6 — 消费行：mesh 直连 + 尾斜杠（运维声明）

```json
"paper-trading": {
  "url": "http://cheap6.mesh.finddata.cn:31894/mcp/",
  "credentialRef": "paper-trading"
}
```

- **mesh 直连，不走 registry 网关**：网关 `_forward_headers` 剥客户端 Authorization
  （白名单仅 airegistry-tools），走网关=逐用户隔离失效（与 facet-market 行同例）。
- **尾斜杠必须有**：`/mcp`（无斜杠）POST→405；`/mcp/` 才是端点。configmap 同步走
  GitOps 落库（facet-market 行的带外 apply 被 selfHeal 打回是前车之鉴）。

## D7 — db v29：单槽表

```sql
CREATE TABLE IF NOT EXISTS user_paper_trading_credentials (
  email TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  stale INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
)
```

handoff 草图里的 `active` 列在单槽下恒真，弃之（connector 的 active 服务于多槽选一）。
回滚=DROP TABLE，无数据迁移负担。访问器四个：get / set(替换+清 stale) /
markStale / delete。

## 不做

- 多账户 slot、远端 token 吊销、token 列表管理（服务 Web 已有；要再来一刀时按
  connector-account-picker 模式扩）。
- pack 侧/registry 条目侧任何改动（对方系统已完成：metadata 已挂、pack 已发布）。
- 行情覆盖扩展、策略沙箱等业务面（服务侧能力，与凭据轨无关）。

## Risks / Trade-offs

- [refName 字符串错配 → 门放行后 server 静默省略] → 单测断言 refName 与
  `metadata.credential_ref` 字面相等；v29 迁移与注册表同 PR。
- [探活打错 origin（如误配 registry 网关域）→ 一切 paste 401] → origin 只从
  mcp.json 行推导（D3 单源）；e2e 验收首步即 mesh 自检 `GET /health`。
- [`requiredGroup: "wire-customers"` 组门拦住壹座用户装包] → 对方系统的对称配合项，
  paas 侧不可修；验收前与 finddata 侧确认组授予，属跨系统依赖非本 change 缺陷。
- [尾斜杠丢失（手改 mcp.json/configmap）→ 405] → 部署清单含字面 URL；探活走 REST
  路径不受影响，症状会在 MCP 调用层以 405 显形（可读可排查）。

## Migration Plan

出片→三 deployment 同滚（platform/platform-demo/…… 照 5.x 纪律）→ configmap
paper-trading 行走 GitOps → 生产验收四条（两用户粘贴隔离 / 吊销翻面 / 未连接 409 /
装包 19 工具可用）。回滚：镜像回退+configmap 删行；v29 表留存无害。

## Open Questions

（无——i18n 已定案五语一次做齐，见 tasks 3.3。）
