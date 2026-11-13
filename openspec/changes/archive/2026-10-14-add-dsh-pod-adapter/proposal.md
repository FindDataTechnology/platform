# Proposal: add-dsh-pod-adapter — 同 pack 服务 agent 共宿 pod（1 进程 : N agents）

## Why

萬星 serving 面要撑「壹座上数百个 agents」（docs/wanxing-multi-harness-runtime-explore.md 命题 4）。
进程模型算不出这笔账：现状每部署角色一个 dsh 进程（agent-runner 1 agent : 1 child），
地板价 ~100-185MB/进程，300 agents 就是 30-55GB 热内存。M2 活体测量（2026-10-14，
`scripts/measure-dsh-pod-shape.mjs`）已证 pod 形态成立：空闲/温态会话边际内存 ≈ 0，
每 pod 成本是进程地板价、不按 agent 计价——**同 pack 部署的 N 个 serving agents 共宿一个
进程，内存从 N 份地板价摊薄为 1 份**，且 MCP sidecar 进程级共享（合同⑭实证恒一）。

同时，pod 的前置缺口是桥的 per-session persona：dsh 0.2.0 的 preset 注册表原生支持会话级
选择（合同⑩实证），但我们桥的 `agentPresetId` 仍是 initialize 时的进程级单值——单进程
N agents 各持 persona 需要这根线接上（模型选择已有 parked 机制可复用，persona 没有）。

本 change 是调研底稿切片序列的 ②（① 合同⑩-⑭ 已完结归档）。

## What Changes

1. **桥 per-session persona 接线**（dsh-profile-template/platform-preset-bridge.js）：新增
   live method `preset/set {sessionId, presetId}`——parked-only（会话创建是唯一受支持的
   preset mount 点；活会话拒绝并明示「开新会话」）；`#createSessionInner` 解析顺序
   parked → `agentPresetId` → 注册表默认；`platform/capabilities` 上报。
2. **pack home 物化**（agent-runner/compose.js）：`materializePackHome`——一个 home 承载
   pack 全部 serving 成员：N 行 persona preset、skills/MCP 并集（同 pack 名字本就唯一）、
   deployment secrets 并集（同名必须同 ref）、billing key 单写、tool-filter 扩展
   per-preset 段（进程级 guard=并集，成员级 restrict=精确面）。
3. **runner pod 粒度**（agent-runner/manager.js、child.js）：pod 模式下 children 键=
   podKey（pack 部署）；acquire(entry) 定位成员 pod；任一成员描述符变更排水整 pod
   （升级粒度=pack）；paused 成员拒回合但 pod 留守；容量/驱逐/warm-zone 预算按 pod 记账
   （RSS 一份 + pod 地板价）；health 按成员派生。
4. **会话命名空间**：pod 内 wire 会话 id = `<agentKey>--<sessionId>`，同 home 内不同
   成员的会话永不互串；外部上下文 reap（srv-wx-*）改为含匹配以覆盖前缀名。
5. **回合纪律与预算**：pod 在途回合上限可配（默认 1——收尾串行化是**进程级**限制，
   见 design D1 订正），超额排队不失败；成员回合超预算先 `session/cancel`（桥原生），
   不收敛才整 pod 硬停兜底。
6. **配置面**：`AGENT_RUNNER_POD_MODE`（默认 0=solo 零变化）、`AGENT_RUNNER_POD_COST_MB`
   （默认 160）、`AGENT_RUNNER_POD_MAX_INFLIGHT`（默认 1）。
7. **合同⑯**（dsh-contracts）：双 agent 共宿形状合同——per-session preset 选择、成员
   persona/model 互不渗透，跑真矩阵树。

### 判读订正（随本 change 落盘 docs）

调研底稿「结构性解 = 每会话一个 agent 上下文」的读法**不成立**：probe-concurrent-turn-close
的两会话本就各持独立 agent 上下文（stock 与桥的 `createSession` 均为 per-session
`ctx.agents.create`，dsh-matrix 源码实证），收尾照样饿死——**回合收尾串行化是进程级的**。
pod 因此不能承诺成员回合独立收敛，纪律（每 pod 在途上限、默认 1）是设计的一部分而非
权宜；后台续跑（切走不取消）不因 pod 解锁。

## Capability Map / Spec Deltas

| Spec | Delta | 内容 |
|---|---|---|
| agent-runner | MODIFIED ×3 + ADDED | 「One dedicated runtime child」承认 pod 共宿形态；ADDED「Same-pack serving agents may co-host in one pod runtime」（资格门/命名空间/升级粒度/纪律/预算）；「Child lifecycle is bounded and queued」并发单位=child 或 pod；「Turn budgets are enforced with a hard stop」pod 分支=先取消后兜底 |
| dsh-runtime-bridge | ADDED | 「Per-session preset selection parks until the session exists」（preset/set parked 语义、活会话拒绝、未知 preset 晚失败、capabilities 上报） |
| agent-residency | MODIFIED | 「The warm zone demotes under budget」warm-zone 记账单位=child 或 pod（pod 一份 RSS + 地板价；排水 pod=全员降温） |
| dsh-contracts | ADDED | 「pod 形状合同（⑯）」双 agent 共宿隔离钉住（编号避让 restore-assistant-stream-020 已占的 ⑮） |

## Non-Goals

- **端口按 pod**：v1 保留每 agent 自己的 HTTP 监听与端口派生（serving 面/registry 面
  零改动）。「端口按 pod」需要 registry A2A 代理学会路径保持（现 Drops path、一
  agent 一 origin），留待后续切片。
- **HarnessAdapter 接口抽象 + 第二 harness**（切片③）、**谦面物化器**（切片④）、
  **萬星管理面统一**（切片⑤，含未决问题 1/2/3）。
- **solo 模式行为变化**：pod 关闭时字节级不变（默认 0）。
- 密度档策略定案：本 change 只给保守起步（默认 solo、长尾 pack 可选 pod）；「默认翻转/
  按流量晋级」等生产策略待生产实证后再议（未决问题 4 的 v1 答案）。

## 验证口径

- 合同⑯两轮绿（真矩阵树 0.2.0-rc.2，与 ①-⑮ 同 runner）。
- 单测：manager pod 分组/资格门/排水、compose pack 物化、桥 preset/set parked 语义、
  会话命名空间与 reap 含匹配。
- 生产眼见：一个双 serving agent 的 pack 共宿部署——单进程承载双成员、双 persona 各归
  各会话、内存对照（1 pod vs 2 solo children）。
