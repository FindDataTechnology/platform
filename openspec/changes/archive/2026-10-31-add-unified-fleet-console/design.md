## Context

前案与既建制（全部在产）：

- **配对**：`gateway/app-auth.js` — steward 设备（Ed25519 + 六位绑码），bindings 存
  `app:<deviceId>`（kind/label/pubkey/email），`devicesFor` 已有 web 管理面；
  `stewardFromToken` 是唯一 steward 鉴权入口。
- **上报门**：`gateway/cell-report.js` — steward 凭据唯一可开的门，shape 白名单
  （presence/manifest 两类），relay 到 FLEET_INGEST_*（未配置=202 degrade-open）。
- **桌面收敛环**：`server/local-agent-feed.js` 的 `local_fleet_deployments` 表
  （agent_path/pack_id/agent_id/enabled/config_overrides）+ 部署写面三闸
  （可部署/幂等 reused/容量 409）；runner 按 feed 收敛——**期望集=本地表**是现成机制。
- **上行客户端**：`supervisor/steward-reporter.js` — pair 文件=显式开启，环形缓冲
  cap100，401 自焚。
- **FleetPage**：本机集群区（可写）+ 云席位区（只读桥）；live 端点五态 + 部署条目
  两个读端点已在。
- **spec 锚点**：`cell-lifecycle`（presence/manifest 上行、居住策略、销毁协议）、
  `device-pairing-auth`（steward kind「恰好一个上报门」）、`desktop-fleet-console`
  （本地写面闭环）。

## Objective / Non-Objective

**做**：云机器名册 + 期望态拉取（本地手动赢）+ cell_detail 明细上行 + web 机器段 +
健康哨。**不做**：实时控制通道、平台远程写机器、内容类上行、非配对机器入册、
OpsView 改造（姊妹仓零改动）。

## Decisions

### D1 来源语义：source 钉死（local-manual-wins 的实现基座）

部署表加 `source` 列（`manual` | `cloud`，默认 `manual`）。规则三条：

1. 期望态合并只推进 `source='cloud'` 的条目；`source='manual'` 的条目合并永碰。
2. 用户在 FleetPage 对 `cloud` 条目做任何手动动作（stop/start/remove/deploy 同路径）
   → 该行 `source` 翻为 `manual`（**手动领养即本地赢，从此时起云端期望不再追它**）。
3. supervisor 部署期望条目时带 `source=cloud`；拒绝（容量/不可部署）不落地、计数回写。

为何不用时间戳仲裁：时间戳在时钟漂移/离线补缓冲场景下会产生静默覆写；source 是
显式状态机，行为可枚举可测试。

### D2 合并执行走信标握手（单写者律，apply 时依实证修订）

**apply 核实结论**：steward 与 cell 本就共 dataDir，且 steward 读 cell 侧事实走的是
**只读直开 SQLite**（`readBeaconManifest` 开 `fleets.db?mode=ro`）——进程间握手走
文件信标是既有惯例，不需要也不应该给 steward 铸造新的 cell HTTP 凭据。故合并链改为：

1. steward 拉取期望态 → 原子写 `fleet-desired.json`（dataDir，{version, entries, pulledAt}）
2. **cell 是本地部署表唯一写者**：cell 内合并循环（boot 时既有 `convergeLocalCluster`
   旁 + 60s 节拍）读信标，按 D1 规则经自己的 store 函数合并（容量/幂等闸原样复用）
3. 合并结果（version_seen + 结构化拒绝）写回 cell 自著的 `fleet-detail.json` 信标

零新凭据、零跨进程 HTTP 写、两条信标各只有一个写者。source 语义在 cell 合并代码里。

### D3 拉取门自 scope：凭据即身份

期望态读取端点与上报门同域（`gateway/cell-report.js` 旁），同一 `stewardFromToken`
鉴权；**不接受 body/query 里的 deviceId**——目标机恒等于 token 内 `did`，跨机读取
在构造上不可能。响应携 `version`（期望表每次编辑自增）+ 条目数组（与本地部署行同形：
pack/agent/enabled），supervisor 存 last-synced version 供日志与调试（本期不做增量
diff，全量小到无谓优化）。

### D4 机器仓落点：gateway 层 JSON 文件仓（apply 时依实证修订）

**apply 核实结论**：D4 原假设「两张新表进共享数据仓（db.js 迁移）」不成立——hosted
拓扑里 SQL 库是各 cell 私有的，gateway 够不着；而平台级状态（bindings）的既建制
就是 **gateway 进程的 JSON 文件仓**（`mp-bindings.json`，原子 temp+rename）。机器仓
照此办理：新 `gateway/fleet-machines-store.js`，`DATA_ROOT/fleet-machines.json`，
单文件结构 `{ machines: { <deviceId>: { lastSeenAt, presence, detail, divergenceStreak,
desired: {version, entries} } } }`。上报门（写 detail/lastSeen）与 web 机器段路由
（读名册/写 desired）同进程各拓扑各挂一份：hosted=gateway/index.js，单进程=server.js
（与 mp-auth/app-auth「shared module, both entrypoints」同律）。db.js 迁移只留
v108：`local_fleet_deployments` 加 `source` 列（cell 私有库）。

### D5 cell_detail 组装：cell 著信标、steward 只读转运

cell 内 60s 节拍（与合并循环同一定时器）原子写 `fleet-detail.json`（dataDir）：
部署条目（含 source）出自本机 DB、五态经既有 runner /health 代理路径取一次、
合并状态（version_seen + 拒绝计数）出自合并循环。steward tick 读该信标（纯文件读，
同 `readBeaconManifest` 惯例）随上行发 `cell_detail`；配对不存在则整段不发生。
cell 侧零新增端点；白名单扩容只发生在网关。

### D6 健康哨：读时派生 + 落时计数

- 沉默：`now - lastSeenAt > 阈值`（env 可配，默认 30min），读时算。
- 背离：detail 落存时对比 desired 表，一致清零、不一致 +1，连击数落仓内；
  阈值（默认连续 3）读时判。
- 自报异常：崩溃环计数/合并拒绝连击直接来自 detail 白名单字段，超阈值上浮。
全部零出站探测（ADR 纪律）。

### D7 同意文案与存量用户

开关仍是一个（上行），`cell_detail` 随同一开关：启用页逐条列出全部字段（含新增）。
存量已开启用户：app 更新后首启弹一次性提示列出新增字段（非硬门——新增字段仍是
零内容元数据，不扩大信任边界）；拒绝者可关开关或配对自焚照旧。

### D8 web 机器段落点

新 `MachinesPage`（列表 + 详情抽屉 + 期望态编辑），导航注册遵守 `surfaces.ts`
同注册律（导航白名单驱动，漏注册即不可见——dsh 插件市场案实证的坑）；i18n 五语言
同批；期望态编辑只落云端表（D3/D4），页面上「待机器领取/已对齐/背离」三态直读
健康哨派生。

## Risks / Trade-offs

- **source 列的状态机漂移**：合并/手动两条写路径都必须维护它——测试矩阵按 D1 三条
  规则全覆盖（手动→云、云→手动、删除后重部署）。
- **detail 快照含部署名/包名**：仍是元数据，但比计数更敏感（暴露用户装了什么包）——
  同意文案逐条列出 + 白名单硬闸（网关侧单测钉死内容类字段剥离）。
- **hosted 双进程共库假设**：若 bindings 实际不共享（核实点），降级方案=上报门与
  期望态门同迁 server 进程（app-auth 单一实现令此为纯搬运）。
- **合并风暴**：期望表编辑后 supervisor 至多一个节拍内生效，无风暴面；但 detail
  上行 + 拉取 + 合并同环时注意单 tick 超时预算（既有 degrade-open 兜底）。

## Migration Plan

cell 侧迁移 v108（`local_fleet_deployments` 加 `source` 列，默认 `manual`），幂等可
重放；gateway 侧机器仓为 JSON 文件（首写自建，无迁移）。存量无数据回填（名册自然
从零积累）。回滚=特征开关关、文件留存无副作用。

## Open Questions

（已全部收口于 apply 前核实：hosted 拓扑 gateway 前门 + cell 私有 SQL 库的结论
已折入 D2/D4/D5 修订。）
