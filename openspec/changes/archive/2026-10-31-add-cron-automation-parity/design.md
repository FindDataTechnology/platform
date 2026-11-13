# Design: add-cron-automation-parity

## Context

见 proposal.md - Why。现状约束（代码核实）：`CronJob` 已是 `{type: recurring|once|manual, cron, when, tz}` + `history[]`（含 state/tokens/missed），WS `cron_*` 消息族与 `server/cron-mcp.js` 四工具（create/list/pause/delete）在产；UI 已渲 `history.at(-1)`；补跑（downtime catchup）与未完成收口在产且本刀不碰。ZCode 参照的关键纪律：相对延迟由宿主真实时钟锚定（自算绝对时刻一旦过期会静默滚一年）；interval 的真值是规则不是被凑出来的 cron；update 保 id 与历史。

## Goals / Non-Goals

**Goals**：三形态调度 + update + 执行史面，一次到位；旧任务记录零迁移。
**Non-Goals**：执行引擎/队列/补跑语义、cron 表达式解析器重写、日历组件。

## Decisions

**S1 · schedule 表示：在既有字段旁加可空 `interval:{number,unit,phase?}` 与 `maxRuns`/`runs`，不重写 job 形状。**
备选=统一抽象成 scheduleRule 大改造：否决——`cron`/`when` 两字段已广播在 WS 事件与 pack 模板各处，重写波及面大于收益。旧记录缺新字段 = 现语义（cron/once），读侧判 kind 时 cron 优先、interval 其次。

**S2 · interval 的发生序列 = 锚点 + k×步长；锚点=创建接受时刻（服务端时钟），runs 计数持久。**
备选"以上一次实际完成时刻起算"否决：失败重试与 run-now 会让序列漂移，"每 3 天"会变成"看运气"。带 phase（钉每日时刻）的 day/week 级 interval 按 job 的 tz 评估日历相位；纯 minute/hour 级与 tz 无关。maxRuns 收口在调度器判 `runs >= maxRuns → completed`，run-now/重跑完成也计数（口径=完成执行次数，spec 已钉）。

**S3 · 相对一次性：表单与 MCP 只提交延迟，服务端锚定；UI 预览仅作显示近似。**
杜绝客户端算死 wall time（ZCode 坑）。延迟单位=分钟（整数，上限 525600=一年），「N 小时后」表单换算了分钟数提交。解析结果落 `when` 绝对时刻持久，重启恢复不二次锚定。

**S4 · update 面：id/历史/暂停态保留；可改 name/prompt/schedule/maxRuns；执行目标（preset/session 绑定）不可改。**
换目标=换任务语义，删建更诚实。schedule 变更后 next-run 依 S2/新表达式重算；改 maxRuns 低于已跑数则即刻 completed。

**S5 · 执行史面纯读现有 `history` 条目（store 已随 `cron_*` 广播携带），不新增端点。**
展开区按时间倒序；missed 条目与其补跑执行同列（引擎已有【补跑】标记语义，UI 如实渲）。

## Risks / Trade-offs

- [调度器主循环要认三种 kind，漏一支=任务静默不跑] → 单测以 kind 全矩阵出闸（cron/interval/once-absolute/once-resolved × 暂停/恢复/重启）。
- [runs 计数与历史条目的口径漂移（run-now 计不计）] → spec 已钉"完成执行计数"；历史条目 kind 字段做单一判据，勿另设计数器。
- [phase+interval 跨夏令时漂移] → day 级以下 interval 不引日历运算；day/week 级用既有 tz 库（Intl）算相位，与 cron 同工具面。
- [MCP create 描述变长，模型乱传组合] → 结构化错误沿用「Invalid schedules return structured errors」条款，非法组合（once+maxRuns、cron+interval）指名拒绝。

## Migration Plan

加可空字段即前向兼容；部署顺序=服务端（调度器认新 kind）→ mcp 工具面 → 表单 UI。回滚=回退代码，带新字段的旧 job 对回退后的读面是未知 kind → 回退前用 cron_list 清点新形态任务（预期窗口内极少），如实告知后删建。

## Open Questions

无（phase 交互深度、历史区样式均可在 apply 期定，不改 spec/任务拆解）。
