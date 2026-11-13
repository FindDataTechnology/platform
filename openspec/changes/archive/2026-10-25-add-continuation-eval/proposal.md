# add-continuation-eval

## Why

记忆架构 v4（spawn 注入 + L3 画像）的门是「评测证明 L2 有效」（`docs/memory-architecture-v2.md` §12），但现有评测只测**蒸馏器质量**（eval v1.2：关键词命中 / 去重链 / 语言门），从不回答「agent 拿到召回后续作是否更快更准」。2026-10-25 生产调查（S0，台账回填）实证弹药已备齐：**442 页生产 L2 语料在库**（wx-alpha 165 / mission-planner 147 / spider-heal 123）、**写读不对称**（交接认领率 wx-alpha 21% / u-aloadtree 8%；壹座主 chat 会话 fd-memory 调用为零）——ambient 注入的价值假设需要一次受控实验裁决，而 v4 注入块（digest）的形状也应在同一实验里定型，避免「先上产再调形状」。

## What Changes

- **三臂接续评测 harness**（fd-memory `scripts/eval-continue.mjs`）：**无记忆 / 仅标题列表（= 今天集群 hook ① 的生产形状）/ 完整 digest（top-k L2 混合召回渲染）**三臂对比；复用 eval-distill 模具（scratch root + 真调度器 + 真 sidecar + 真词元车道）。
- **digest 渲染器**（fd-memory `src/digest.ts` 纯函数，评测与未来注入共用）：硬预算（默认 1,500 tokens）、每条带 layer / confidence / 日期、open handoffs 通知段、forget 与 expired 条目排除——**即 v4 注入块原型**，S1/S3/S5 直接复用。
- **续作场景 fixtures**（`fixtures/eval/continue-scenes.json`）：从生产脱敏转录构造——前史快照（L0 观测 + L1 交接/笔记 + 已产 L2）+ 续作任务 + 期望背景集合。
- **LLM-judge 双指标**：重推导度（是否重推了本可从记忆知道的背景）+ 首步正确性（声称的下一步与期望背景的一致性）；盲评（臂名匿名）、词元车道、模型 pin、token 预算入账。
- **硬门（v4 解锁门）**：digest 臂对无记忆臂的显著性阈值在 design 定死；标题臂作为生产现状基线参照（不设门）。裁决（过门 / 不过门）入档，是 S3/S5 是否立项的依据。
- **明确不做**：任何生产注入（S1/S3/S5 后续 change）、调度器与读面改动、纪律文案、embed 超时调优；不建人工抽样管线（judge 校准的人工环节写进运行手册，不做成工具）。

## Capabilities

### New Capabilities

- `memory-eval`：记忆面评测——接续成功率三臂评测、digest 渲染契约、v4 解锁门的判定与基线入档。

### Modified Capabilities

（无——`memory-distiller`「评测 v1 进 CI」需求不动；本能力是独立的第二评测维度，不是蒸馏器质量评测的扩展。）

## Impact

- **fd-memory 仓**：`src/digest.ts`（纯函数渲染器，~80 行）+ `scripts/eval-continue.mjs`（~300 行）+ 场景构造/脱敏导出一次性脚本 + fixtures；**零服务路由/存储改动，零出片**（渲染器进镜像但无行为面变化）。
- **成本**：全量一轮 = 场景数 × 3 臂 × (agent 首回合 1 次 + judge 1 次) LLM 调用，走词元车道与既有预算口径（量级参照：eval v1.2 基线 77,931 tokens、生产单次蒸馏 17-35k tokens；design 定估算与上限）。
- **paas 仓**：仅 openspec 工件 + 台账回填。
- **风险**：① fixtures 脱敏纪律——生产转录进公开仓必须过 sanitize 同款管线 + 人工复核（本仓已有 EXCLUDE_PATHS 教训在册）；② judge 偏置——盲评臂名 + 双指标分离 + 少数场景人工抽检校准；③ 被评 agent 用纯 LLM 调用模拟首回合（不跑真 dsh）——测的是「背景在场与否」的对照，工具执行噪声故意排除（design D5 定此简化边界）。
