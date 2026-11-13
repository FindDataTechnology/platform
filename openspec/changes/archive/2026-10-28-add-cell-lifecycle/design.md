# Design: add-cell-lifecycle

## Context

现状关键面（踏勘定案，代码坐标按执行时复核）：

- 云端执行体是 `gateway/spawner.js`：cells 为内存 Map，状态 starting/running/stopping/error，
  spawn 仅由流量触发；`CELL_IDLE_REAP_SECS` 闲时回收但持有启用 cron/bot 的 cell 豁免（fd-prod
  设 3600s，舰队时代=全部豁免）；`shutdown()` 滚版杀光全部 cell；销毁路径仅 demo cell
  （进程退出即删数据根）。cell 侧已有需求探针 `GET /api/gateway/jobs`
  （`server/routes/misc.js`，返回 enabledCron/enabledBots 计数）。
- 每个 cell 的定时时刻表持久化在自身数据根 `<dataRoot>/<userId>/data/cron-store/jobs.json`
  （task-engine 的 saveTasks 白名单含 cron/tz/nextRun/enabled 语义）——不拉进程也可读。
- 桌面 supervisor（`supervisor/lifecycle.js`）生来 Electron 无关：headless 入口
  `local-services.js` 已在跑同一实现；Electron main 进程内构造并用 IPC 直包实例。
  桌面发行无 autoUpdater（electron-builder.js 无 publish 配置=重装式分发）。托盘驻留
  （desktop-fleet-console）已解决"关窗继续跑"。"生命周期跟随应用"（desktop-fleet-runner）
  随本 change 改写为隶属 supervisor。
- 配对信道 `device-pairing-auth`（bind 码换绑、设备公钥、一次性挑战登录、console 可撤销）
  已是生产机制；萬星 ingest 观察面（gateway/fleet-cells.js 的 cell_stats 通道）是只读
  上报的先例形态。
- 舰队侧的语义锚点：`fix-fleet-turn-veracity` 给"唤醒即冷启动"提供了 skipped/就绪等待
  语义，本 change 的唤醒环依赖其存在但无代码依赖（并行落地，spec 互引）。

## Goals / Non-Goals

**Goals:**

- 一套生命周期词汇（状态机/居住策略/销毁协议/白名单）单源，云端网关与桌面管家两个
  执行体各自落地，spec 出自 `cell-lifecycle` 一处。
- 云端：持久注册表 + 重启重建需求面（治滚版全黑）+ 值班环按需唤醒（豁免条款退役）+
  销毁路径。
- 桌面：supervisor 常驻化（UI attach / 回退）、自启安装（零 admin、明示）、配对上报
  （默认关、白名单）、存留策略执行、排干更新。
- 两章可并行交付：桌面章①②先行（客户 deadline），云端章随后接续。

**Non-Goals:**

- 云端 standby 接管（桌面数据不出机，spec 已钉死）。
- 桌面管家自更新通道、Phase 3 k8s/PVC 化（机制对 spawn() 实现解耦，届时平移）。
- 萬星 board/console 的 cells 全景 UI 页（本期只到 ingest 事件与注册表读面；
  视图页属于 console 侧后续切片）。

## Decisions

### D1 · 注册表分两层：执行体本地权威 + 观察面派生（不建第三套星图）

权威注册表在执行体本地：云端=网关自有持久库（随 spawner 同进程，重启即读），桌面=
管家数据根旁落盘（`steward` 台账）。跨拓扑的"平台星图"不是新存储，而是从既有上行
（cell_presence/cell_manifest 事件经萬星 ingest）派生的读模型。**取舍**：单写者原则——
cells 从不直接写 board，board 只做窗口派生（与 runner board 同构）；避免了"两处权威"
的对账需求。被否决的备选：facet 侧集中 Cells 表——它要求执行体把生命周期裁决的每次
迁移都远程落账，云端滚版恢复路径反而被外部依赖卡住（重启重建必须离线可用）。

### D2 · 唤醒判决只读持久化数据，零探针

值班环（云端）与管家（桌面）判断"suspended cell 是否到期"只读两处持久来源：注册表行
（策略/上次履约）与数据根 `jobs.json`（cron/tz/nextRun）。到期即拉起——cell 启动后
任务引擎自决（node-schedule 武装下一次 + P2 catch-up 兜住窗口内错过的那一轮）。**关键
推论**：值班环不需要精确到秒，扫描周期取 `min(下次到期)−now` 与固定上限（默认 60s）
的较小者；catch-up 容忍窗（max(2×period, 6h)）是唤醒精度的下限担保。被否决的备选：
拉起 cell 询问列表（把唤醒判决变成冷启动本身，O(N) 进程抖动换 O(1) 读盘，不值）。

### D3 · 云端 spawn/suspend/wake/destroy 全部经 spawner 一处裁决

注册表落账与进程操作收敛在 spawner 模块（它已是 orchestration 的唯一缝——头注释为
Phase 3 预留）。网关其他面（proxy/auth/状态页）只读注册表。状态迁移函数纯化：
`transition(registryRow, event) → {state, actions[]}`，进程副作用集中在行动执行器，
便于 node:test 覆盖全部迁移面（含重启重建、墓碑抑制 spawn、强制销毁护栏）。

### D4 · 桌面常驻形态=既有 Supervisor 类 + 控制面 + 装配缝，不重构

`Supervisor` 类已 Electron 无关（local-services.js 证明）。常驻形态新增的是一个薄
宿主：从包内以 `--steward` 模式启动同一二进制（或独立小入口），构造同一 Supervisor
并挂上控制面 server（Unix socket / named pipe，ACL=属主用户）。Electron main 的改造
收敛在"attach 优先"：发现 `steward.json` 健康→客户端代理 IPC；未发现→嵌入式回退；
发现但不可达→引导修复。被否决的备选：全新守护进程重写（抛弃已验证的健康/重启/日志
语义）与 supervisor 整体提升为服务框架（范围失控）。

### D5 · 配对复用 device-pairing，上行门=唯一授权域

桌面管家经既有 bind 码流程配对（console 出码、桌面输入、公钥登记、挑战登录），设备
kind=`steward`。该身份只开一个门：POST cell_presence / cell_manifest（萬星 ingest 侧
新增事件种，鉴权=device 挑战）；断言 401 之外的任何端点一律拒绝（凭据域最小化——
设备失窃的爆炸半径=伪造 presence，无会话、无 pack、无控制）。私钥入 OS 钥匙串。
被否决的备选：另发 steward 专用 token 体系（第三套凭据=第三个轮换面）。

### D6 · 排干更新以"稳定自启路径 + drain-and-quit RPC + catch-up 兜底"三段组成

无 autoUpdater 的现实下：安装器替换文件前先向控制面发 `drainQuit`（supervisor 排干
children→退出→解锁文件）；自启项指向稳定路径（`/Applications/<app>.app` 或
`%ProgramFiles%\...\steward-launcher`），永不指向版本目录；替换完成后下次登录/显式
拉起新包。窗口内错过的轮次由任务引擎既有 catch-up 全兜（机制已上线，无需新逻辑）。
UI↔supervisor 版本兼容窗经控制面 `protocolVersion`：major 不符显式拒绝，minor 向前
兼容。

### D7 · 墓碑抑制需求面（销毁不是"删行"）

destroyed cell 的注册行不删除而转墓碑：抑制该用户的 spawn（流量到家答 destroyed 态）、
抑制值班环唤醒、保留销毁原因/时间供审计。桌面侧授权在通道生效即刻作废（无论哪路）。
被否决的备选：销毁即删行（丢失"这个用户为什么没了"的唯一来源；卸载重装争议不可查）。

### D8 · 白名单上行 + 同意门 + degrade-open

上行字段白名单逐条写进同意文案（presence：在线/离线、OS、app 版本、protocolVersion；
manifest：舰队/岗位/任务计数与名称标签）；prompt/会话内容/工具参数结构上不存在于
上行管道（schema 层无此字段，防御在形状而非纪律）。开关默认关；平台不可达时本地
环形缓冲带上限或丢弃，绝不阻塞 cell 本务。

## Risks / Trade-offs

- [值班环扫 jobs.json 与 cell 内任务引擎并发写冲突] → SQLite/JSON 读都是原子重写文件，
  读到旧版是唯一失败模式（下一轮扫描自愈）；且 suspended cell 无人写。挂起中的写与
  值班环读之间以"读失败即跳过本轮"降级。
- [唤醒风暴：滚版后大量 cell 同时到期] → 值班环有界并发（默认 4，env 可调）+ 每 cell
  冷却（上次拉起失败 N 分钟内不重试）；`always` 重建与唤醒共用同一并发闸。
- [唤醒后 runtime_not_ready 假失败回流（cold start 紧邻到期）] → 依赖
  fix-fleet-turn-veracity 的就绪等待+skipped 语义；未上 A 的部署形态下值班环延迟一个
  boot-ready 窗口再交火（配置项，过渡桥）。
- [驻留管家的权限观感（常驻=流氓软件联想）] → 明示安装、同意文案三事逐条、零 admin、
  卸载清注册；spec 把"默认不装"写成 floor。
- [Windows 文件锁导致更新失败] → D6 的排干先于换包是硬序；安装器拿不到控制面回应
  （supervisor 卡死）时中止安装并报错，不强行覆盖。
- [注册表 schema 演进] → v1 字段最小集（本 spec 列出的）； schemaVersion 字段自带；
  迁移在网关/管家 boot 时幂等执行。

## Migration Plan

- **云端**：镜像滚动即生效。升级后首个 boot 执行注册表 backfill：扫数据根目录为老用户
  建 `on_demand` 行（cellId=sha256(email) 既有规则，email 从 cell 库读）、武装唤醒。
  `CELL_IDLE_REAP_SECS` 语义进入过渡桥：有注册表后按策略档执行，豁免条款退役。
  回滚=回旧镜像即可（spawn 恢复为流量唯一入口）；注册表库文件遗留无害（旧代码不读），
  新唤醒环随旧二进制自然消失。
- **桌面**：发行版新增 steward 组件与卸载钩子；存量用户默认不变（未安装=manual 世界，
  spec 已钉）。fleet 插件设置内提供安装向导；配对码由 console 侧既有通道签发。
- **数据**：注册表为新增存储，无既有数据迁移；jobs.json 读取只消费既有字段。

## Open Questions

- 值班环扫描周期与有界并发的生产调参值（默认 60s/4 先行，fd-prod 实测后回写台账）。
- 墓碑保留期与审计导出形态（v1 永久保留，导出面后续接 ops-console）。
