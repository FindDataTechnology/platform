# Proposal: extend-dsh-contracts-020-capabilities

## Why

萬星多 harness 运行层调研（docs/wanxing-multi-harness-runtime-explore.md，2026-10-14）定调：DshPodAdapter（1 进程:N agents）、短期/常驻统一生命周期、ACP 统一缝都建立在 dsh 0.2.0 的多 agent 能力面上（ctx.agents 原语 / subagent 服务槽位池 / preset 注册表会话级选择 / ACP profile / MCP sidecar 进程级共享）。这些能力目前**没有任何合同钉住**——ADR-0007 的版本跟随（每 3-4 周跳最新绿 rc）对它们是盲跳；上游正活跃迭代（DS Bot 已实测 0.2.1-alpha.1），一旦 rc 改形，切片②③会在实施中途才发现地基塌了。

## What Changes

- dsh-contracts 套件新增**合同⑩-⑭**（五条，与既有九条同流程：候选模式、独立执行、独立报告、任一 fail 退出码非零）：
  - **⑩ preset 会话级选择与组合隔离**：多 preset 声明、两会话各选不同 preset、各自组合生效（per-session persona 的上游地基）；未知 preset 在会话发布前失败回滚；
  - **⑪ per-agent 工具裁剪作用域**：`agent.ctx.tools.restrict` 按 agent 收窄工具面且不影响同进程兄弟 agent（DS Bot 实战手法）；
  - **⑫ subagent one-shot 派发**：one-shot 子代理跑完即收、per-child agentOptions 覆写生效、槽位池超限以 `ACTIVATION_LIMIT_REACHED` 拒绝（短期 agent 形状+准入语义）；
  - **⑬ ACP 会话面**：`--profile acp` 提供 create/resume/list/close、模型+effort 选择、submit/cancel；**并如实记录计量面形状**（usage/token 事件在 ACP 上可得与否——切片③接口基线的决定性输入）；
  - **⑭ MCP sidecar 进程级共享**：同一进程 N agents 消费同名 MCP server 时 sidecar 进程数恒定（pod 内存分摊的结构断言）。
- 合同 runner 新增**进程内探针插件**模式（test-only patch 行注入，经 `@deepseek-ai/*` 直引仅限 scripts/ 名单内文件——dsh-adapter-boundary 纪律）：ctx.agents/subagent 服务/preset 注册表是进程内 API，现有 stdio RPC 面够不到，⑩⑪⑫经探针断言。
- **活体测量**（测量脚本+数字落 research doc，非合同）：M2 pod 内存叠加曲线（N 活跃会话 RSS 曲线，假 LLM+大上下文播种近似）；M1 并发回合叠加在合同⑨基础上补吞吐形状记录。
- ⑬ 顺带回答未决问题 #2（ACP 与平台协议分工）的实证半边。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `dsh-contracts`：新增「0.2.0 多 agent 能力面合同族（⑩-⑭）」需求（五条合同+场景）；「六条 v1 合同」与「活控制合同」需求不动；「套件接入镜像冒烟与矩阵变更 PR」需求的零改动接入承诺由既有措辞覆盖（合同清单新增 SHALL NOT 要求修改接线方）。

## Impact

- **改动的代码**：`scripts/lib/dsh-contracts/contracts.mjs`（合同注册+探针插件物化）、`scripts/dsh-contracts.mjs`（如需 runner 参数扩展）、`dsh-profile-template/`（探针插件文件，test-only、不入生产 profile——或经 scratch 物化注入，design 定）；测量脚本新增 `scripts/measure-dsh-pod-shape.mjs`（名字 design 定）。
- **不动的**：生产 profile 组合、agent-runner、桥的运行时行为——本片零生产面变化，纯验证面。
- **兼容**：合同⑨的 rc.2 已知限制（并发收尾不收敛）不重开；新合同各自独立报告，不与⑨的 flaky 耦合。
- **风险**：⑬ 依赖剪后树含 `dsh-acp`（已核：prune.json 只剪 libreoffice-kit+dsh 自带 UI，ACP/subagent/preset 包都在出货树）；⑩⑪⑫ 依赖探针插件经 cordis patch 注入的装载路径与 platform-sdk-server 同型（合同⑤已钉此机制）。
- **非目标**：per-session preset 的桥接线（`preset/set` RPC）属切片② DshPodAdapter；headless profile 合同后置（非切片②③承重项）； HarnessAdapter 接口抽象属切片③。
