# add-mission-planner-pack

## Why

M2 切片②（roadmap：docs/facet-wanxing-roadmap.md；切片① add-mission-definitions 已实施——四元组/状态机/纪元回写契约/成本闸全落，未部署等本切片同窗）。planner 形态已定案 agent 路线：planner = 营运自营 pack agent（spider-heal 同型），消费 ① 的派发契约（brief → writeback），把「一句话目标」拆解成计划并驱动到报告。没有它，任务定义面是无人消费的数据面。

## What Changes

- **planner pack 内容**：persona（拆解/执行纪律+硬约束）+ 四技能：
  `mission-protocol`（brief 解析、GET 轮询/POST 回写五 kind、幂等键纪律、状态机地图）；
  `mission-planning`（目标→≤8 步计划；步骤 agent 必须 search_agents 实查，查无则自行执行，绝不编造）；
  `mission-execution`（步骤串行执行与状态回写；时间窗纪律；失败重试 ≤1；窗口尽/预算尽 → fail 回写）；
  `mission-reporting`（终态报告回写 + bot_notify 通知）。
- **发布/部署脚本**：`scripts/mission-planner-pack.mjs`（spider-heal-pack.mjs 同型：publish 幂等续版 → deploy 带 serving 契约 a2a+rhythm+预算；无 MCP 引用——工具族是标准 preset 面，pack 为纯 persona+技能）。
- **上线**：planner pack 发布+部署（runner 在役），facade 配 `MISSION_PLANNER_SLUG` 随 ① 同窗上线（fd-wanxing 镜像 scs001 线）；生产真 mission e2e（一句话目标 → 计划 → 执行 → 报告 → 成本记账全链）= M2 出口判据的首个实测样本。

## Capabilities

### Modified Capabilities

- `a2a-agent-serving`: 新增一个自营 planner 部署的实例事实（不改变 serving 契约本身）。

## Impact

- **代码**：`scripts/mission-planner-pack.mjs`（新）；`scripts/test-mission-planner-pack.mjs`（manifest 校验+技能正文断言）。
- **生产**：facet 新 pack（private，萬星运营号）；runner 新部署；fd-wanxing facade 环境两键（MISSION_PLANNER_SLUG、WANXING_PUBLIC_BASE_URL）。
- **不做**：夜间车道的 lane 路由与 checkpoint 长程（③）、fleet board mission 视图（④）、跨 mission 并发调度优化。

## Non-goals

- 不改 ① 的状态机与回写契约（planner 是纯消费者；唯一反向输入=① 已补的 GET 轮询面）。
- 不做 planner 的多模型编排（brief 的 model 字段 v1 作为记录透传，不强制切模型——执行模型由部署配置）。
