## Why

「一个屏幕管所有集群」今天答不上来：云控制台看不到已配对的桌面机器与机上舰队（桌面
上行只有 presence+计数 manifest，且默认关），云上无法给某台机器布置「该部署什么」
（写面完全分家：云管云 cell、桌面 FleetPage 管本地），机器沉默/崩溃环/车道断供无哨。
而桌面收敛环、部署期望集（`local_fleet_deployments`）、设备配对体系（steward kind）、
fleet ingest 观察板全部已建制——缺的只是把期望集的权威源从单机扩展成云指针，以及把
机器明细抬进用户面。这是产品化（客户在云上管自己 N 台机器的舰队）的最后一栋主体工程。

## What Changes

- **云端机器名册**：已配对 steward 设备聚合为「机器」视图（配对元数据 + 活性 presence +
  机器明细摘要）；用户面 web 控制台新增「机器」段，一台机器可下钻到机上 cell/部署条目。
- **期望态拉取（GitOps 式，无控制回程）**：云端持久化每台机器的部署期望集；桌面
  supervisor 定期用 steward 凭据**拉取**并合并进本地部署表；冲突时**本地手动赢**
  （本地表保持，结果经明细上行回写云端），平台永不向机器推送动作、永不远程删机——
  桌面拉、桌面决定，断网照常按本地期望集收敛。
- **桌面明细上行扩容**：新增 `cell_detail` 事件类——per-cell 五态、部署条目（agent 名/
  包名/版本/启用态）、运行时组占用等**纯元数据**，与 presence/manifest 同一 shape
  白名单纪律；prompt、会话内容、工具结果、文件内容 SHALL NEVER 上行；同意文案逐条
  列出新增字段。
- **机器健康哨**：机器视图上浮三类异常——presence 沉默超窗、steward 崩溃环自报、
  期望态与实况持续背离（拉取失败/合并被拒的连续计数）。
- **两层并存**：内部 OpsView（观察板）不动，继续运维深钻；用户面机器段做客户视角。
- **明确不做（防漂移边界）**：实时控制通道（WebSocket 命令/远程执行）；平台侧直接
  改写桌面本地表；上行内容类字段；非配对机器进名册。

## Capabilities

### New Capabilities

- `fleet-machine-console`: 云端机器总控面——机器名册（配对 steward 设备 + 活性 + 明细聚合）、
  每机部署期望态存储与拉取 API（steward 凭据只读）、web 控制台「机器」段（列表/详情/
  期望态编辑/健康哨上浮）。

### Modified Capabilities

- `cell-lifecycle`: 「presence 与需求清单上行」扩容——新增 `cell_detail` 事件类（元数据
  白名单）；新增「期望态拉取与合并」要求——supervisor 定期拉取、本地手动赢、结果回写、
  断网降级不阻塞本务。
- `device-pairing-auth`: steward 设备凭据的授权面从「恰好一个上报门」扩为「一个上报门 +
  一个期望态只读拉取门」；仍然零用户会话登录、零 pack 操作、零对设备的控制动作。
- `desktop-fleet-console`: 本地集群区显示部署条目来源（云端期望态 vs 本地手动）；手动
  动作仍落本地表且优先于云期望态。

## Impact

- **云端**：`gateway/app-auth.js`（steward 门扩第二个只读门）；新 `gateway/fleet-machines-store.js`
  + `gateway/fleet-machines-routes.js`（机器仓 JSON 文件仓照 mp-bindings 惯例 + 名册/期望态/
  健康哨路由，gateway 与 server.js 双入口各挂一份——shared module 同律）；`web/src`（机器段
  新页 + 导航注册——注意 `surfaces.ts` SETTINGS_SURFACES 同注册律）；cell 侧 db.js 迁移 v108
  （`local_fleet_deployments` 加 `source` 列）。
- **桌面**：`supervisor/steward-reporter.js`（期望态拉取写信标 + cell_detail 转运，同环不同道）；
  cell 侧合并循环与 `fleet-detail.json` 信标（cell 是部署表唯一写者，信标握手零新凭据）；
  `web/src/pages/FleetPage.tsx`（来源标注）。
- **观察板（fd-wanxing 姊妹仓）**：零改动——机器明细走既有 fleet ingest 白名单事件，
  OpsView 不在本期。
- **隐私红线（既有律不动摇）**：上行白名单扩容必须过同意文案逐条列出；内容类字段
  永不进白名单；配对吊销即 401 自焚语义不变。
