# desktop-fleet-runner Specification

## Purpose
把桌面发行版变成萬星舰队里的一个本地机位：agent-runner 预装但默认禁用，经 Preferences 开关启用；启用后以持久化的独占机位 id 运行、只托管显式 tagged 给它的部署条目；经六位配对码绑定到 console 身份换取 per-seat 上行凭据，吊销即 401；对云端调度控制循环隐形（遥测可见，但永不被重派、回收或选址）；ops 与 A2A 监听收紧到 127.0.0.1；进程生命周期隶属应用会话；默认同 pack 共宿 pod；外部 agent 的任务经萬星门面信箱异步入站、由 runner 纯出站轮询执行并回投。

## Requirements

### Requirement: 萬星插件预装禁用

桌面发行版 SHALL 预装 agent-runner 的全部运行代码，且默认禁用：未启用时 supervisor
不启动任何 runner 进程。启用 SHALL 经 Preferences 设置开关持久化到 settings.json，
并在应用重启后生效。

#### Scenario: 默认安装不启 runner

- **WHEN** 应用以默认设置启动
- **THEN** supervisor 将 `agent-runner-js` 标记为 disabled，不派生任何 runner 进程

#### Scenario: 开关启用后 runner 起来

- **WHEN** 用户在 Preferences 打开萬星舰队开关、保存并重启应用
- **THEN** supervisor 启动 `agent-runner-js` 且其健康探针转绿

#### Scenario: 插件失败不挡主应用

- **WHEN** runner 进程启动失败或持续不健康
- **THEN** supervisor 将其标记 unhealthy 并记录，主应用（对话 cell）照常可用

### Requirement: 机位身份独占

启用萬星插件时，桌面 runner SHALL 以持久化的独占机位 id 运行：id 首次生成后存
settings.json，此后每次启用沿用。runner 的默认分片 id SHALL 显式设为与机位 id 不同
的值，使桌面只拉取 descriptor 显式 tagged 给该机位 id 的部署条目。

#### Scenario: 云端 untagged 条目不上桌面

- **WHEN** registry 持有无 `runner_id` 标记的条目（云端默认机位的分片）且桌面 runner
  轮询
- **THEN** 桌面不托管这些条目

#### Scenario: tagged 条目被桌面拉起

- **WHEN** registry 持有 `runner_id` 等于桌面机位 id 的条目且桌面 runner 轮询
- **THEN** 桌面托管该条目并按部署描述符起 runtime

#### Scenario: 机位 id 跨重启稳定

- **WHEN** 插件停用后再启用
- **THEN** runner 沿用同一机位 id，其名下条目不换归属

### Requirement: 机位配对与吊销

桌面机位 SHALL 经六位配对码绑定到 console 身份：console 侧铸码（短时、单次），
桌面侧凭码核销换取 per-seat 上行凭据（facade 公开 ingest 转发面），凭据由 cell
server 直接持久化、不经渲染层转交。吊销 SHALL 删除机位登记使下一次上行即 401。
服务间内部凭据 SHALL 永不下发桌面——桌面只持有自己的 per-seat token。

#### Scenario: 配对闭环

- **WHEN** console 用户铸码、桌面在设置面输入该码
- **THEN** 机位绑定该用户，上行 URL/token 落入 settings.json，runner 重启后经
  facade 转发面上报（observer 收到 `desktop: true` 的 runner_stats）

#### Scenario: 吊销即时断链

- **WHEN** console 用户吊销某机位
- **THEN** 该机位的 per-seat token 在下一次 ingest 即 401，其 registry 条目仍
  sticky 等待（调度器永不重派桌面机位）

#### Scenario: 配对码单次且限形

- **WHEN** 同一码被重复核销或 runnerId 非 desktop- 形状
- **THEN** 核销拒绝（401/400），码不可复用

### Requirement: 桌面机位对云端调度隐形

桌面 runner SHALL 可配置向 fleet observer 上行遥测（`runner_stats` 携带
`desktop: true` 自报）；未配置上行时对 board 彻底不可见。云端调度控制循环 SHALL
在一切控制决策中排除桌面机位：其心跳过期不触发条目重派（关 app ≠ 机位死亡），
其被 board 剪除不触发孤儿回收（条目等待回归），其永不作为重派或自动选址的
目标机位。监控可见性与调度控制权分离——board 能看见桌面机位，控制循环不能动它。

#### Scenario: 关闭应用不触发重派

- **WHEN** 桌面 runner 离线（应用退出）超过云端 stale 阈值且云端存在健康 runner
- **THEN** 该机位名下的 registry 条目不被修改，仍指向桌面机位等待回归

#### Scenario: 上行自报使调度排除生效

- **WHEN** 桌面 runner 上行 `runner_stats`（payload 含 `desktop: true`）且其 id
  不带 desktop- 前缀（自定义机位名）
- **THEN** 该机位不出现在调度循环的健康目标集合中，自动选址永不落在它上面

#### Scenario: 机位被 board 剪除后条目仍等待

- **WHEN** 桌面机位长期离线被 observer 从 board 剪除，其名下条目仍 tagged 该机位
- **THEN** 孤儿回收不接管这些条目（即便机位在机群表有登记行且已过宽限窗）

### Requirement: 桌面监听收紧到回环

桌面 runner 的 ops 监听与每个托管 agent 的 A2A 监听 SHALL 绑定 127.0.0.1；host 绑定
SHALL 可经配置注入，云端部署不注入时保持既有 0.0.0.0 行为零变化。

#### Scenario: 桌面全监听回环

- **WHEN** runner 以桌面环境配置启动
- **THEN** ops 端口与全部 agent A2A 端口仅接受回环连接

#### Scenario: 云端零变化

- **WHEN** runner 以不注入 host 配置的既有环境启动
- **THEN** 监听地址与改动前逐字节一致（0.0.0.0）

### Requirement: 生命周期跟随应用

桌面 runner 与其 runtime children 的进程生命周期 SHALL 隶属 supervisor：supervisor 为
内嵌形态（未安装常驻管家）时，应用退出即有序 drain 全部 runtime children 后退出（原有
语义）；supervisor 为常驻形态（`desktop-supervisor` 的 resident form）时，runtime
children 存续于 UI 会话之外，drain 只发生在管家有序停机、排干更新或销毁流程——UI 退出
不再携带停机语义。runner 异常退出时均仍由 supervisor 按退避序列自动重启。

#### Scenario: 退出时排空

- **WHEN** 用户退出应用且 supervisor 为内嵌形态（supervisor 有序停机）
- **THEN** 全部 runtime children 被停止后 runner 进程退出，无孤儿进程

#### Scenario: 常驻形态下 UI 退出不停机

- **WHEN** 用户退出 Electron 应用且 supervisor 为常驻形态
- **THEN** 桌面 runner、其 runtime children 与已排定定时任务全部继续运行，仅 UI 客户端
  脱离

#### Scenario: 常驻形态下管家停机才排空

- **WHEN** 常驻管家收到停机/更新/销毁信号
- **THEN** 其按序 drain 全部 runtime children（含桌面 runner）后退出，无孤儿进程

### Requirement: 桌面默认 pod 密度

桌面 runner SHALL 默认启用 pod 共宿模式（同 pack 的 serving agents 共享一个 runtime
进程），warm-zone 预算与逐出照常生效。

#### Scenario: 同 pack 双 agent 共宿

- **WHEN** 同一 pack 的两个 serving agents 部署到桌面机位
- **THEN** 二者共享一个 pod runtime 进程，各自持有独立监听端口

### Requirement: 座席信箱（外部任务的异步入站）

外部萬星 agent 对桌面机位上 agent 的 `message/send` SHALL 经萬星门面投递到该机位
的公网信箱（facade 中继，queue→deliver→settle 状态机），并即时以排队回执应答
（携带 taskId）；`message/stream` 对座席目标 SHALL 显式拒绝（-32601）。桌面
runner SHALL 以纯出站轮询拉取信箱任务、在本地执行真回合、把结果回投中继存档，
调用方经任务查询端点取回。信箱通道 SHALL 复用座席的 per-seat 凭据（与遥测上行
同 token、同吊销语义）。座席未托管任务所指 agent 时 SHALL 立即以失败结算（不
重试）。

#### Scenario: 外部任务经信箱闭环

- **WHEN** 外部调用方向桌面 agent 发 message/send，桌面 runner 在线且托管该 agent
- **THEN** 调用方即时收到排队回执；runner 轮询拉到任务、本地真回合执行、结果
  回投；任务查询端点可读到结果文本

#### Scenario: 流式对座席拒绝

- **WHEN** 调用方向桌面 agent 发 message/stream
- **THEN** 门面以 -32601 拒绝并说明座席仅接受异步 message/send

#### Scenario: 吊销断信箱

- **WHEN** 机位被吊销后其 runner 尝试拉取或回投
- **THEN** 两端点均 401（与遥测上行同时失效）

### Requirement: 本地 roster 源零配置默认

插件启用（`WANXING_PLUGIN_ENABLED=1`）且 settings 未配置
`AGENT_SERVING_REGISTRY_URL` 时，supervisor descriptor SHALL 把 runner 的
registry 指针注入为 cell 本机 feed 地址（`http://127.0.0.1:<cell port>`，
`local-agent-registry-feed` spec），并注入 first-run mint 的本机 Bearer 令牌。
stock 桌面「开插件即有编目」——不再出现 runner 健康而编目恒空的零目录席位。
外部 registry 配置存在时 SHALL 保持外部指针与本机 seat id 分片纪律，行为与
既有版本逐字节一致。机位身份（`机位身份独占`）与调度隐形
（`桌面机位对云端调度隐形`）要求不受影响。

#### Scenario: stock 桌面开插件即有本地编目

- **WHEN** 一台未配置外部 registry 的桌面首次启用插件并重启
- **THEN** runner 指向本机 feed、以本机令牌拉取编目，`/health` 健康且 agents 来自本机部署

#### Scenario: 外部 registry 配置仍胜出

- **WHEN** settings 已配置 `AGENT_SERVING_REGISTRY_URL`
- **THEN** descriptor 注入保持外部地址，本机 feed 令牌不参与 runner 环境

#### Scenario: 令牌缺失时 runner 如实降级

- **WHEN** 本机 feed 令牌因 settings 受损而不可用
- **THEN** runner 拉取收到 401、以既有「未配置/不可用」语义降级，不崩溃、不阻塞 server-js
