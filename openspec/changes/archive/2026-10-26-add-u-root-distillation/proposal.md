# add-u-root-distillation — Proposal

## Why

生产实测（2026-10-25 晚，fd-memory pod 全 owner 普查）：d/ 包根蒸馏健康（L2 151–202/根），**u/ 人根 L2 全部为 0**——蒸馏器两处 `d-` 前缀闸（distill-scheduler notifyCapture/fallbackScan）把人根排除在外。chat 注入上产后人根开始积累 L1（aloadtree 9 notes+39 handoffs、platform-test 6+28），但 /digest 的 L1 段只带**最近 3 条** note：第 4 条起不可达，handoffs 蒸馏后本可成为可检索 L2 的沉淀也全部滞留。这是记忆线最后一个结构性开口：写回有读者（chat/集群注入），但读者只能看到冰山一角。

另一处同场调查实锤：sidecar 单条 query embed 在产延迟 **1.1–4.4s**，/digest 全程挤在 cell 侧 5s AbortController 边缘——digest 档命中是「延迟彩票」（drill 一回合 titles 一回合 digest 的真因）。embed 稍慢即整脸超时掉 titles，eval 验证的 digest 优势在产打折。

## What Changes

1. **u/ 人根蒸馏启用**（fd-memory）：蒸馏器 `d-` 闸放宽至 `u-` 根（部署级开关 `FD_MEMORY_DISTILL_U=0` 一键关闭，默认开）；蒸馏原料增加 **note 页**（合成 observation 形状条目：`tool=memory_write_page`、summary=标题+正文摘录——note 即「用户明示记住的观测」，零侧车跨仓改动）；u/ 根 project 发现走页索引（人根无 observations，现 fallbackScan 的发现路对 u/ 失效）；per-owner 日预算护栏原样覆盖人根（400k/owner/日既有）。
2. **/digest deadline 降级**（fd-memory）：embed 尝试按内部 deadline（~3.5s）封顶——来不及即关键词召回出块（model_note 注明），保证 /digest 在 cell 5s 预算内**必然返回 digest 块**；digest 读面增加一行 served-rung 日志（digest/keyword/model_note），命中率先天可观测。
3. **eval 老.note 深度场景**：场景集增加 ≥2 个背景存于同 project 排名 >3 的旧 note 的场景（现 digest 臂不可达），harness 先对种子根跑真实蒸馏路径再渲染 digest——度量蒸馏带来的老.note 召回增量，门槛照旧。

### Modified Capabilities

- `memory-distiller`：调度需求扩入 u/ 根与 note 原料、部署级开关。
- `fleet-memory`：平台缝 digest 读面需求增 deadline 封顶降级与 served-rung 日志。
- `memory-eval`：新增老.note 深度场景需求。

### Non-goals

- 侧车引擎的 note 原生 kind 契约（sidecar 仓不在本工作区，observation 合成形状已语义诚实；原生契约留后续）。
- chat 回合级蒸馏触发（会话边界上报链路；fallback 10min 扫描对人根粒度足够 v1）。
- claim-rate（handoff begin 29 vs accept 6）行为面优化——属纪律/产品面，另行立项。

## Impact

- **代码**：fd-memory `src/distill-scheduler.ts`（闸门/发现/原料）、`src/db.ts`（note cursor）、`src/http.ts`（/digest deadline+rung 日志）、eval harness 与场景。paas 零改动。
- **出片**：fd-memory 单端。
- **隐私姿态（呈报点）**：人根 note/handoff 内容将随蒸馏进入 LLM 车道——与 d/ 包根今日同车道同服务；per-owner 预算与 `FD_MEMORY_DISTILL_U` 部署级开关随本变更落地。默认开启如需收紧改 env 即可。
- **风险与回滚**：蒸馏产物直进 L2 影响后续召回——由既有渲染器预算/排除纪律与 eval 门槛兜底；开关回零 = 行为字节等同现状（u/ 根回到 L1-only）。
