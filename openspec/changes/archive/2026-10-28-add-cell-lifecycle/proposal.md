# Proposal: add-cell-lifecycle

## Why

多 agent 产品的地基缺一块：平台对"有哪些 cell 存在、各背着什么需求、该不该常驻、何时该死"
没有任何表达面。三个现役后果：

1. **滚版即全舰队停摆**：网关的 cell 注册面是内存 Map，滚版杀光全部 cell 后，只有用户回访
   才重新拉起——无人值守舰队的回合在用户回来之前全部不发射（catch-up 也救不了，它只在
   cell 启动时生效）。
2. **生命周期没有终点**：账号 cell 无销毁路径（demo 是唯一会死的 cell）；订阅止/闲置
   账号永远是"活着但无需求"。
3. **桌面主战场不可见**：客户主要在自己 Windows/Mac 上跑舰队（2026-10-15 拍板的方向），
   但桌面 cell 本体不注册、关 UI 即全停的现状无法满足"关了软件舰队照跑"的客户需求——
   已有客户等待交付。

需求方：云端章治 1/2（平台自身缺陷）；桌面章治 3（客户驱动的 supervisor 常驻化）。
用户 2026-10-26 grill 三轮 22 问定稿（翻案记录：Q14 墓碑降级为兜底、Q15 改判 supervisor
常驻化全量、Q22 桌面章先行）。

## What Changes

- **引入 cell 生命周期词汇（跨拓扑单源）**：状态机
  `unbound → starting/running ⇄ suspending/suspended → destroyed`，居住策略
  `always / on_demand / ephemeral`，presence/manifest 上行事件，销毁三路协议
  （卸载钩子 / console 撤销→401 自毁 / 沉默墓碑兜底）。词汇一处定义，云端网关与桌面
  管家两个执行体引用。
- **云端章（cell-gateway）**：持久化 cells 注册表（网关本地库）；网关重启时枚举注册表
  重建需求面并重新武装（治滚版全黑）；值班环读挂起 cell 数据根的 cron 时刻表执行
  按需唤醒/静默挂起（"持有 cron 即豁免回收"条款退役，挂起≠定时违约）；新增销毁路径
  （含数据根处置与审计墓碑）。
- **桌面章（desktop-supervisor）**：supervisor 常驻化——进程独立于 Electron UI 存活，
  loopback 控制面供 UI attach（拒绝安装者保留嵌入式回退）；per-user 零 admin 自启
  （macOS LaunchAgent / Windows 计划任务/Run 键，安装为明示步骤并按 Q16 落地存留策略）；
  配对注册（复用 device-pairing 信道）+ presence/manifest 白名单上行（默认 OFF、
  明式开关）；更新时先排干后换包，控制面自带 protocolVersion。
- **明确不做（钉入 spec 防漂移）**：云端付费 standby 接管；平台侧远程删除本机数据
  的能力永远不存在。

## Capabilities

### New Capabilities

- `cell-lifecycle`: cell 生命周期的跨拓扑词汇与裁决——状态机/居住策略/注册表语义/
  唤醒与挂起判决/销毁协议与墓碑。云端章与桌面章的执行体（cell-gateway、
  desktop-supervisor、device-pairing-auth）都引用本词汇，spec 单源。

### Modified Capabilities

- `cell-gateway`: "Cells start on demand and are always-on by default" 被居住策略
  与注册表重写——cell 由注册表驱动 spawn/suspend/wake/destroy；重启重建需求面；
  cron/bot 豁免回收条款被按需唤醒替代。
- `desktop-supervisor`: supervisor 从"随 app 生死的进程内件"扩展为"可常驻、可 attach、
  可按策略看管 runtime"的两个形态；新增自启安装、控制面、存留策略、排干更新语义。
- `device-pairing-auth`: 已配对设备增加 steward（桌面管家）种类用于 presence/manifest
  上行授权；配对设备撤销是销毁协议的 console 侧通道。
- `desktop-fleet-runner`: "生命周期跟随应用" 随 supervisor 常驻化改写为"生命周期隶属
  supervisor"——内嵌形态维持随 app，常驻形态下 runtime 存续于 UI 会话之外，排干点上移
  到管家停机/更新/销毁。

## Impact

- **代码**：`gateway/spawner.js`（注册表/状态机/唤醒环/销毁）、`gateway/index.js`
  （装配与运维面）、`supervisor/`（常驻形态、控制面）、`electron/main.js`（attach
  与回退）、`app/` 发行链（自启安装、卸载钩子）、`server/routes/misc.js`（需求清单
  探针扩展）、萬星 ingest 侧新增事件种的读模型（facet packs 服务）。
- **API**：新增 cells 注册表读面（管理侧）、steward 上行端点、销毁动作；不破坏任何
  现有端点契约。
- **部署**：fd-prod 网关滚动后 cell 需求面自愈（行为变化，需在发布记录写明）；
  桌面发行新增常驻组件与卸载钩子。
- **关联**：与 `fix-fleet-turn-veracity` 语义互锚（skipped 回合是唤醒失败时的诚实
  记录形态）但无代码依赖，两者可并行落地。
