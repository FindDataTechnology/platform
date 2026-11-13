# Proposal: add-harness-adapter — agent 级 HarnessAdapter 接口 + 第二 harness（ACP 基线）

## Why

萬星 serving 底座目前只有一个 harness：dsh。用户命题（docs/wanxing-multi-harness-runtime-explore.md
命题 1/2）要求「萬星部署运行 agent 的底座不只是 dsh，还要包括主流 AI harness」，且「谦面 pack
兼容部署在不同主流 harness 里」。

调研已定调（底稿「架构定调」节）：**抽象缝是下沉不是发明**——`agent-runner/child.js` 的
`clientFactory` 注入点已经把协议面（initialize / prompt / request / subscribe）封装成
一小块；`compose.js` 已是「one composition pipeline, two execution targets」。但今天这块
缝没有名字、没有形状约束、没有第二个实现，且 dsh 专用细节（`preset/set` 泊靠、pod wire 会话
命名空间、`session.status` idle 语义、`platform/stream` 帧）与协议面混在同一个类里——
第二个 harness 进来时会把这些 dsh 语义泄漏进通用路径。

同时，**第二 harness 的接入成本已被上游生态压到很低**：ACP（Agent Client Protocol）已是
事实标准，dsh 原生 ACP profile 已实证（合同⑬），且主流 harness 都有现成 ACP 适配器
（npm 实查：`@zed-industries/claude-code-acp` 0.16.2、`@zed-industries/codex-acp` 0.16.0，
均为 stdio ACP agent，`@agentclientprotocol/sdk` 已在仓依赖里）。機群侧的自报面也已备：
`runner_stats` 心跳已带 `models` 名单（add-deploy-roster-gate），加 `harness` 维度是同一
形状的纯增量；`agent_runners` 表与 `runnerId` 部署路由（add-runner-fleet-sharding）已上线。

本 change 是调研底稿切片序列的 ③。①（合同⑩-⑭）与 ②（DshPodAdapter）已完结归档。

## What Changes

1. **HarnessAdapter 接口**（新模块 `agent-runner/harness/`）：agent 级契约——`spawn` /
   `turn(sessionId, text, {agentKey?})` / `stop` / `pid` / `capabilities()`；返回形状与今天的
   `AgentChild` 内部调用面一一对应，**dsh 实现（`DshHarnessAdapter`）包装现有
   `HarnessClient` 路径，行为字节级不变**。接口是 agent 级：pod 密度、wire 会话命名空间、
   泊靠 preset/model 都是 dsh 实现的内部细节，不进接口（底稿硬约束）。
2. **ACP adapter**（`AcpHarnessAdapter`）：以 stdio 驱动任意 ACP-speaking agent 二进制
   （`--acp`/`agent acp` 之类由 descriptor 声明），映射 ACP 方法到接口：
   `initialize` → ACP `initialize`；会话懒建 → `session/new`（cwd 绝对路径）+ 
   `session/set_config_option`（模型）；`turn` → `session/prompt` + 等 `stopReason`；
   取消 → `session/cancel` 通知；用量 → ACP 线 `usage_update` 通知（合同⑬已实证存在）。
   第二 harness 本体 = **claude-code-acp**（npm 包，镜像内置），descriptor 可声明
   `harness: "acp-claude-code"` 与启动命令。
3. **runner 自报 harness 能力**：心跳 `runner_stats` 增 `harness` 字段（字符串数组或单值，
   纯增量，缺失=未知降级开放）；部署路由沿用 `runner_id`（既有机群表与选址逻辑零改动），
   **部署门增 harness 维度**：descriptor 声明的 harness 不在目标 runner 自报集合内时拒绝并
   指名（与 model roster gate 同形，缺失/未知降级开放）。
4. **镜像与机群**：claude-code-acp 进 dsh-runner 镜像（或其独立镜像线，按体积与依赖审计定，
   design D3 拍板）；`agent_runners` 行按 harness 标注（note 或新列）；生产验证 =
   同 pack 的一个 agent 跑 dsh、另一个跑 claude-code，各自 A2A 面正常回合。
5. **合同扩展**：dsh-contracts ⑰「ACP adapter 映射面」——用本地 fake ACP agent 钉住
   adapter 的方法映射与错误路径（不依赖外部 claude 凭证）；真 harness 的端到端走生产验证段。

### 与 ② 的关系

pod 与 harness 正交：pod 是 dsh 的密度档，ACP adapter 是「一进程一对话」形状的 harness
（底稿明言 Claude Code/Codex 本质 solo 形）。本 change **不动 pod 代码路径**，只在
adapter 选择处增加分派。

## Capability Map / Spec Deltas

| Spec | Delta | 内容 |
|---|---|---|
| agent-runner | ADDED | 「A runner drives agents through a harness adapter」：接口契约、harness 分派、descriptor 声明、行为不变性 |
| agent-runner | MODIFIED | 「One dedicated runtime child」harness 维度（dsh 之外的第二实现同为合法 child 宿主） |
| harness-adapter | ADDED（新 capability） | adapter 接口的独立事实源：方法面、capabilities 自报、错误与生命周期语义、ACP 映射表 |
| dsh-runtime-bridge | ADDED | 「The bridge's live-control surface is dsh-specific」：泊靠/流通道/工具门是 dsh 深度面，adapter 接口不承诺它们（能力探测降级） |
| agent-runner | MODIFIED | 「A runner hosts only the entries assigned to it」+ harness 自报与部署门（roster gate 同形） |
| dsh-contracts | ADDED | 合同⑰ ACP adapter 映射面（本地 fake ACP agent） |

## Non-Goals

- **谦面 pack 物化器**（切片④：manifest→各 harness 布局落盘）。
- **萬星管理面统一**（切片⑤，含未决问题 1/2/3）。
- **pod 与 ACP 的组合**（ACP harness 一进程一对话；不做多会话共宿）。
- **Codex 线**：codex-acp 存在但不在本次验证范围（接口留下即可接）。
- **第二 harness 的多租户深度面**（工具 allowlist 强制、会话级工具门）——ACP 面只有
  MCP 注入与权限请求，深度控制按 design 如实收窄并记录。

## 验证口径

- 单测：adapter 接口一致性（dsh 与 ACP 两实现跑同一组契约测试）、ACP 映射单测（fake
  agent 进程）、harness 自报与部署门。
- 合同⑰两轮绿（真矩阵树 + 本地 fake ACP agent；dsh 侧 ①-⑯ 不回归）。
- 生产眼见：同一 pack 两个 serving agent，一个 `harness: dsh`（pod 或 solo）、一个
  `harness: acp-claude-code`，各自 A2A 回合成功；runner 心跳带 harness 字段；错配部署
  （harness 不在 runner 集合）被部署门拒绝。
