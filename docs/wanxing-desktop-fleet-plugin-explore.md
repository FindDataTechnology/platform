# 萬星桌面舰队插件 调研底稿（桌面版=客户主要执行平台线）

> 2026-10-15 用户拍板立项；同日 grill 三轮十问全裁。
> **状态：四切片全部实施+验收收口（①-④）**——本文是后续 change 的单一
> 事实源。伞文档关系：产品计划归 `facet-wanxing-roadmap.md`，运行底座机制层归
> `wanxing-multi-harness-runtime-explore.md`，本文只管**萬星能力落到桌面版**这一片。
> 调研基线：本仓生产代码实证（supervisor/ electron/ agent-runner/ gateway/）+
> fd-wanxing fleet-observer 源码 + 桌面发行树（dist-opensource）逐目录核对。

## 命题（用户原话拆解）

1. **桌面版必须能指挥上百个 agents**——桌面是相当多客户的主要执行平台，萬星核心
   能力不能只在云端。
2. **萬星=桌面可选插件**——客户选择安装，就获得「网上的能力」（市场拉包、部署、
   舰队管理）。
3. **能与外部部署的萬星 agents 交流**——「只要建立好协议」。
4. 用户定调：**这是萬星必须要做的一个事情**（非可选）。

## 核心调研结论（一句话版）

**万事俱备，只差一个开关。** agent-runner（萬星执行宿主）的全量代码 + dsh 安装矩阵
已经随桌面发行版分发（`dist-opensource/platform/agent-runner/` 完整、predist 链含
`install-dsh-matrix.mjs`），桌面 Supervisor 的服务描述符机制原生支持多后端管理
（历史上管过 LiteLLM/Postgres/OpenConnector，现为 `enabled/optional/start/dependsOn`
+ 健康探针 + 自动重启退避 + 优雅降级）。缺的只是：一个 `agent-runner-js` 描述符、
一个 Preferences 开关、一个舰队 UI 页、以及外部互通的入站通道决策。

## 现状事实（逐项代码实证）

### 桌面版底座：描述符机制就是插件挂点

- `electron/main.js` 零业务逻辑：构造 `Supervisor` → 等 server-js 健康 → 开窗。子服务
  环境经 `agentEnv`（resolveEnv + settings.json + first-run bootstrap）注入。
- `supervisor/descriptors.js`：`getDescriptors()` 返回描述符数组，每项
  `{ id, kind: node|http-external, transport: http-port|stdio-rpc|none, enabled,
  optional, start: {cmd,args,cwd,env}, url/healthPath, dependsOn }`。
  `optional: false` 失败阻断启动，`optional: true` 优雅降级（`unhealthy` 不致命）——
  **插件「装了才启、坏了不拖垮主应用」的语义是现成的**。
- `supervisor/lifecycle.js`：依赖序启动、退出退避重启（1s→15s）、`restart(id)` 单服务
  重启（Preferences UI 已在用）、反向序停机。

### agent-runner：萬星执行宿主，单机原生

- 单入口 `agent-runner/index.js`：boots inert → 轮询 registry（`poll()` →
  `manager.reconcile()`）→ **deploy/pause/resume/destroy 全由 registry 条目驱动**
  （reconcile 收敛），本地无需编排器。
- 每 agent 一个 dsh child（私有 DSH_HOME、runner 级模型）+ A2A 独立端口
  （`agentPortFor` base 8791 span 32）。
- 驻留面（上百 agents 的资源答案）：warm-zone budget（RSS 采样逐出）、rhythm 自
  回合、day rollover、external-context reap、workspace quota——**「上百 agents」=
  注册上百、节奏化驻留，不是全量常驻**。
- pod 密度档（`AGENT_RUNNER_POD_MODE`，默认 solo）：单进程双成员 RSS 216MB 生产
  实证（dsh-pod-adapter）；共宿键=pack，跨 owner/pack 硬禁共宿。
- fleet 上报：`AGENT_RUNNER_FLEET_URL/TOKEN` → observer `POST /ingest`
  （Bearer ingestToken，单端点，EVENT_KINDS 白名单）+ pod 密度自报。
- dsh matrix boot gate：无 install root 时 skip——桌面 bundled dsh 需以
  `DSH_MATRIX_INSTALL_ROOT` 指向发行树内矩阵（predist 已装）。

### 协议面：三条现成，一条要定

| 通道 | 协议 | 状态 |
|---|---|---|
| 桌面 runner ↔ 公网 registry | `GET /api/agents`（Bearer registryToken）+ `/api/skills/{path}/content`；部署=reconcile | ✅ 现成（纯 HTTP 出站） |
| 桌面 runner → 远程 observer | `POST /ingest`（Bearer ingestToken）+ spool 重试 | ✅ 现成 |
| 本地 agents → 外部 agents | A2A 出站委托（delegation-a2a，深度上限环断 ADR-0013） | ✅ 现成 |
| 外部 agents → 本地 agents | 需入站可达；家庭 NAT 后不可直连 | ❌ **要定**（见未决 #1） |

- A2A 面形状（`agent-runner/a2a.js`）：每 agent `GET /.well-known/agent-card.json` +
  `POST /`（JSON-RPC `message/send|message/stream`）；paused 显式应答 `-32010`
  （永不超时永不冷启）；`AGENT_RUNNER_BACKEND_TOKEN` 门。
- 设备身份先例（`gateway/app-auth.js`，add-device-pairing-auth）：bind-code + app
  token → `resolveUser` → cell 路由。「桌面 ↔ 云端」的身份协议形状可直接复用到
  「桌面 runner ↔ 远程萬星实例」。

### 桌面 UI 现状

`web/src/pages/`：Agents/Packs/Tasks/Models/… 无舰队页。舰队视图目前在良机 console
（fd-wanxing wanxing-web OpsView，切片⑤ 刚上 cells 区）与 paas-admin——**桌面版要
新造一页**，数据源用本地 runner（不依赖远程 console）。

## 与云端萬星的职责切分（沿用 ADR-0008 进程边界）

桌面插件启的是 **agent-runner**（萬星执行宿主），不是 gateway（用户 cell 宿主）——
桌面已有自己的 cell（server-js）。管理动作走 registry（部署面），监控走 observer
ingest（只读上行），**桌面 runner 永不向本地之外的平面开入站控制口**。

## 切片序列（grill 后定稿）

| # | 切片 | 内容 | 验收 |
|---|---|---|---|
| ① | 本地舰队宿主 ✅ 2026-10-15 | descriptors 加 `agent-runner-js`（optional、默认 disabled）+ Preferences「萬星舰队」面板（开关+registry/fleet/模型 env）+ `DSH_MATRIX_INSTALL_ROOT` 指发行树矩阵 + 独占 runner_id（sticky、离线永不重派）；生命周期 v1=跟随退出 | **已验**：探针 7/7（stub registry→seat 条目拉起→真 dsh child→A2A 真回合回复「就绪」→SIGTERM 排空）；单测 6/6+回归 82/82；change `add-desktop-fleet-runner` |
| ② | 桌面舰队 UI + 市场页 ✅ 2026-10-15（范围收口） | 舰队页（live 五态+budget+目录只读，经 cell 代理零新凭据）+ 托盘驻留（关窗跑定时/退出 drain）。**「部署到本机」挪③**：部署通道的正确形状=console 部署目标选本机机位（=③设备面）；硬做需把 x-facet-token 服务间凭据下发桌面（可伪造任意转发身份，不可接受） | 探针 4/4（live 透传/只读投影/两降级态）+单测 5/5+typecheck 绿+五语 1332×5+web build 绿；change `add-desktop-fleet-console` |
| ③ | 远程互通·监控上行+设备管理 ✅ 全片 2026-10-15（三刀） | 第一刀：desktop 自报+调度三处短路+上行 env。第二刀：配对协议（facade 设备面+ingest 转发+桌面 pair）+E2E 3/3。第三刀：**部署链解锁**——deployHandler seatGrant HMAC 验签（归属校验在 facade、单一信任根=共享 secret、公网无票全 403）+console「桌面机位」tab（列表/在线态/铸码/吊销）+DeployWizard 目标下拉；条目 loopback 占位 origin+`desktop_seat` 标记（分发-only，A2A 入站=④） | 三刀累计：探针 6 项全绿+paas 62/62+17/17+fd-wanxing 144/144+web build 绿 |
| ④ | 远程互通·信箱协议 ✅ 2026-10-15 **全片完** | facade 信箱面（投/拉/回投/查，per-seat 凭据挂 fleet 前缀）+a2a desktop_seat 拦截（send 投箱+排队回执/stream 拒绝）+runner 轮询器（拉→本地真回合→回投）；未托管 agent 立即失败结算 | E2E 探针 3/3：外部投递→真 runner 真回合回复「**信箱就绪**」→回投→查询取回；facade 150/150+paas 77/77 |

①② 是「插件」本体，③④ 是「和外部萬星交流」的协议层。托盘驻留并入②（①先跟随
退出，简单起步）。

## 资源诚实账（上百 agents 的物理边界）

- solo 每 agent 141-200MB 常驻——百级 solo 常驻在桌面不可行，**必须 pod 档 +
  驻留节奏**（温态为主、热态少数；与云端 runner 同一套 residency 机制，无新发明）。
- 端口天花板：每 runner 32 agents（`agentPortFor` span）——pod 模式下端口按 pod，
  天花板随密度解锁（底稿《多 harness》37 行同判）。
- 模型费用：runner 级 provider/model + pack descriptor 覆写 + 白名单门（roster
  gate）已支持；桌面场景建议默认接 sub2api per-agent key（费用可见性七问之一）。
- **验收口径（grill Q6 定案）**：注册/管理上百、温态（驻留 pod 内）约 10-20、
  热态并发 3-5；对外话术「管理上百、智能驻留」。桌面不承诺上百并发热态。

## grill 裁决（2026-10-15 三轮，十问）

| 问 | 裁决 |
|---|---|
| Q1 外部萬星指谁 | v1=同一客户在我们云端的舰队；协议面（observer ingest/A2A/信箱）按任意萬星部署设计；跨客户联邦不在 v1 |
| Q2 插件安装形态 | 预装禁用+开关（代码已在发行树、体积已付）；可下载组件留未来组件市场 |
| Q3 模型费用归属 | BYOK：用户自己的 sub2api/LLM key；平台分成体系不进桌面；企业接平台计费留未来 |
| Q4 桌面两 agent 世界 | v1 分开（chat cell vs runner 舰队）；v2 在 chat 里 @萬星 agent 走本地 loopback A2A（一行 fetch，不返工） |
| Q5 app 关闭行为 | 托盘驻留：关窗→托盘、agents 继续跑（含定时）；菜单退出→drain 全停 |
| Q6 「上百」口径 | 注册/管理上百、温态 10-20、热态 3-5；pod 密度默认开 |
| Q7 选包安装流 | 内嵌市场页为目标（拆到②）；①验收用 API 部署 |
| Q8 外部→桌面交流 | **异步信箱**：任务落公网中继、桌面出站轮询取回——纯出站，零入站通道，NAT 免疫、可审计、与驻留唤起模型天作合；隧道降级为传输层候选；实时流语义对冷态驻留 agent 本不成立 |
| Q9 registry 归属 | v1 锁公网壹座 registry（凭据/白名单/审计的治理面）；env 逃生口不宣传；自建萬星=另一部署走开放协议面交流 |
| Q10 多设备机位 | 每设备一机位（机器名默认）；设备配对/命名/吊销挂良机 console 设备管理面（bind-code 体系第三客户端形态）；桌面舰队页只看本机 |

**自决定案**（技术性无分叉）：凭据沿 settings.json（与 LLM key 同待遇，keychain
不做）；舰队页=桌面精简版（不复刻良机多租户视图）；rhythm 桌面默认关（保温靠 app
可见性，开 budget 逐出+external-context reap）；费用分档（sub2api=金额，裸 key=
usage tokens 标注无金额口径）；断网=reconcile keeping last-good（已驻留继续跑，
新部署等待）。

## 已钉死的事实（不裁自明）

- **桌面机位 sticky 永不重派**：fleet-scheduler 的 dead-runner 接管重派逻辑必须对
  桌面机位短路——客户关 app ≠ 机位死亡，重派=别人机器/云 runner 偷跑计费。
- 术语已入册 CONTEXT.md：**萬星插件**（预装禁用的运行能力组件，≠功能集 Pack）、
  **机位**（registry 机群表一行，条目 sticky 归属）。
