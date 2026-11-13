# Proposal: add-paper-trading-credentials

## Why

柏讯模拟交易 MCP（fd-paper-trading，2026-10-14 上牌，19 工具）按调用者的 `fdt_` 长命
token 识别用户、隔离账户——registry 条目已声明
`metadata.credential_ref = "paper-trading"`（对方系统已做完），但壹座侧没有这个 ref 的
resolver：今天装 pack「柏讯·模拟交易套件」（DydB2cal-M9l91IMJYHshA）会因
`credentialConnected` 二分派错误地按 registry 凭据放行，随后 profile 写入时 resolver
缺位把 MCP 服务行**静默省略**（装包"成功"但工具消失，比 fail-closed 拒绝更糟）。
finddata 侧 `paper-trading-facet-pack` change 的任务 3.3 交接文档
（`reports/paas-handoff-credential-ref.md`）已把全部前置事实实证完毕。

## What Changes

- 新模块 `paper-trading-credentials.js`（照 connector-credentials 裁剪为单槽 paste 形）：
  五件套契约——refName `"paper-trading"`（与 registry metadata 一字不差）、isRef、
  liveToken（stale→null，token 长命原样返回，无续登）、markInvalid（置 stale 恰一次
  重应用）、staleEvent `paper_trading_credential_stale`。
- `credential-refs.js` 注册第四条 ref（registry/connector/facet-market 之后）。
- `pack-store.js` 的 `credentialConnected` 加 paper-trading 分派（修「错误按 registry
  放行」缺口——与 ref 模块、注册三处同批落地，缺一装包链不闭合）。
- db 迁移 **v29**：`user_paper_trading_credentials`（email PK, token, stale,
  updated_at；单槽——token 即身份，无多账户维度、无 pat_id、无配对字段）。
- 路由 `server/routes/paper-trading.js`（镜像 connector 家族）：`GET /api/paper-trading/
  connection`（状态+服务 Web 指路）、`POST /api/paper-trading/connection`（paste `fdt_`
  token + liveness probe：GET `<origin>/api/v1/accounts`，唯 401 硬拒，网络失败照存）、
  `DELETE /api/paper-trading/connection`。
- 设置面板 `PaperTradingConnectPanel.tsx`（照 ConnectorConnectPanel 裁剪；挂
  McpMarketView 市场头，与 connector/facet-market 连接卡同列）。
- mcp.json 基线：`paper-trading` 服务行（**mesh 直连**
  `http://cheap6.mesh.finddata.cn:31894/mcp/`，尾斜杠必须——无斜杠 POST→405；
  registry 网关会剥客户端 Authorization，逐用户消费只能 mesh 直连）。

## Capabilities

### New Capabilities

- `paper-trading-credentials`：per-identity 粘贴式 token 存储（只写不读）、连接/断开
  路由与探活、注入语义、401 翻面与恢复（重粘贴）、pack 安装的 ref 分派。

### Modified Capabilities

（无——credential-refs 五件套契约不变，本 change 是第四个注册者；pack 安装的 ref
选择规则已由 add-facet-market-credentials 数据驱动化，此处只是新增一个已知 ref 名，
照该 change 先例不另开 pack-installation delta。）

## Impact

- 壹座 web（面板+i18n）、db（v29）、pack-store（credentialConnected 三分派）、
  credential-refs（注册）、server（路由挂载）、mcp.json（运维声明，非 registry 下发）。
- 对方系统零改动（服务、registry 条目 metadata、pack 均已就绪）；manifest 的
  `requiredGroup: "wire-customers"` 组门在 registry 侧，属对方系统的对称配合项。
- 方式 A（手动填 MCP server + headers）现在即可用，本 change 落的是方式 B 的
  一键体验：token 只存服务端、未连接拒装有指路、stale 自愈。
