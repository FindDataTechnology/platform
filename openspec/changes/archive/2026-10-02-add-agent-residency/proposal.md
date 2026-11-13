# Proposal: add-agent-residency

## Why

Agent 服务的运行模型今天是 serverless 式：消息驱动冷启动、闲置 30 分钟回收（ADR-0004 的 runner 即如此）——agent 只会**应答**，不会**上班**。Agent 平台程序（切片 ①，承 ADR-0010）要把部署上来的角色变成驻留的数字员工：进程不因闲置回收、上下文跨天连续，并可按声明的工作节奏自主行动（平台注入的自主回合，非进程内自由循环）。探察已定关键数：空闲 dsh child 实测 18–54MB，规划按 64–96MB/agent，4GB 节点 ≈ 50 resident——500 agent 包络成立但贴上限，温区与内存预算是一等机制而非优化项。

## What Changes

- **驻留生命周期（P1+P2 默认）**：runner 对已部署 agent 不再闲置回收；上下文跨天连续。内存按 host 预算管理：超预算的 agent **退温区**（进程回收、状态落盘、下次触达秒级热起），不驱逐、不丢态。
- **上下文连续机制**：会话按天滚动归档（dsh session 落盘保留），活动 context 每日摘要续接（「昨日纪要」注入新会话头）；每日纪要 + 会话归档推送到可配置的外置目标（默认 host 本地卷，可挂 NFS/对象存储）——host 死亡损失 ≤ 1 天（Q13 决策）。
- **工作节奏（serving.rhythm）**：服务契约新增可选节奏声明——日程与事件源清单，作者在 pack 创作时声明默认，部署者部署时在 deployment descriptor 覆盖生效（付钱的人定闹钟）。声明性数据，仍禁 model/endpoint/credential 字段。
- **自主回合**：runner 侧节奏调度器按生效节奏注入回合——每个自主回合是发起方为 agent 自身的任务，排队/并发约束与现有 bounded concurrency 一致，可观测、可暂停、可计量（计费接线留给 ③，本片打计量点）。无节奏声明 = 只应答不自主。
- **暂停（Pause）一等生命周期**：退温区 + 停止注入一切回合 + registry 条目标记 paused（调用方收到明确「已暂停」错误而非超时）+ 消耗归零 + 一键恢复；部署者主动停用与平台急停共用同一机制。undeploy 语义不变。
- **资源画像入配置**：runner 增 host 内存预算与 resident 上限配置（探察数：64–96MB/agent 规划、~50/host@4GB）；deployment descriptor 预留主机亲和孩子段（分片钩子，调度器本身不上）。

## Capabilities

### New Capabilities

- `agent-residency`: 驻留域语义——驻留生命周期（不回收、跨天连续）、温区（预算超限的降级与秒级热起）、上下文滚动与昨日纪要、工作节奏声明与部署者覆盖的生效语义、自主回合（平台注入、可观测可暂停可计量）、暂停/恢复对运行时的含义。

### Modified Capabilities

- `agent-runner`: 「Child lifecycle is bounded and queued」——idle-reap 不再是已部署 agent 的默认归宿（退为温区机制的一环），bounded concurrency/queueing 不变；自主回合成为 A2A 流量之外的新回合来源（系统注入，同一排队面）。
- `pack-authoring`: 「Agents are persona entries」——服务契约段新增可选 `serving.rhythm`（日程/事件源清单，声明性，禁区字段不变；缺省即无自主）。
- `a2a-agent-serving`: 「Deploy action composes registry-native assets」——deployment descriptor 携带生效节奏（部署者可覆盖作者默认）；新增暂停/恢复为一等生命周期动作（registry paused 标记、调用方明确错误、平台急停复用）。

## Impact

- **Code**: `agent-runner/`（manager 生命周期改造：温区状态机、内存预算、节奏调度器、自主回合注入、pause 通道；config 增预算项）、`lib/pack-manifest.js`（serving.rhythm 校验）、`lib/agent-serving.js`（descriptor 组装带 effective rhythm + pause 状态写 registry）、registry 轮询面（paused 标记）、web 部署详情（节奏显示/覆盖、暂停/恢复按钮；ops 急停入口可后置 ③）。
- **Ops**: runner host 需可配置归档目标卷；内存预算初值依探察数（64–96MB/agent），上线后按 Linux 实测复调；DEPLOY.md 增温区/节奏/暂停 runbook。
- **决策依据**: ADR-0010（驻留=生命周期、自主=权限、平台注入回合）；探察记忆 agent-residency-explore-facts（内存实测、registry token、sub2api——后两者主要喂 ②③，本片只用内存数）。
- **切片衔接**: ② add-agent-delegation-a2a、③ add-agent-platform-ops（计费/私有 pack/准入/console）不动；自主回合的计量点在本片打好，③ 接 sub2api 按 key 结算。

## Non-goals

- 跨 agent 委派与市场发现（切片 ②）。
- sub2api 计费接入、私有 pack、自助准入、fleet 控制台（切片 ③）；驻留租金仍免收（容量上限当闸门，ADR-0011）。
- 多 host 调度器/k8s（只留 descriptor 亲和钩子；Q5 决策）。
- 进程内自由循环（ADR-0010 否决项，永不）；A2A push notifications、文件类 artifacts（沿 a2a-agent-serving 既有 non-goals）；per-agent 模型选择。
