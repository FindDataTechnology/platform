# Tasks: add-tier-promotion-candidates

## 1. fd-memory：候选选材与游标

- [x] 1.1 `src/db.ts` 新增 `promotion_cursor` 列的幂等补偿迁移（沿用 `columnsOf` + `ALTER TABLE` 模式，与 `note_cursor` / `tag_cursor` 同款）
- [x] 1.2 `src/db.ts` 新增 `promotionCandidates(project, cursor, limit)`：`type IN ('fact','experience','reference') AND tier='draft' AND updated_at>cursor`，不带 tags 条件
- [x] 1.3 单测：已打 tag 的 fact 仍入选；stable 及以上被排除；cursor 推进后不重复

## 2. distiller：`/promote` 端点

- [x] 2.1 新增 `POST /promote`：入 `{scope, items:[{idx,title,summary,current_tier}]}`，出 `{results:[{idx,suggest_tier,reason}], tokens, errors[]}`，复用 `/tag` 的 repair_json 解析与 token 记账
- [x] 2.2 prompt 约束写死：只能建议 `stable` 或 `不晋级`；`canonical` 一律不返回
- [x] 2.3 单测：解析容忍脏输出；`canonical` 建议被降为 `stable`；上游失败返回结构化错误不抛

## 3. fd-memory：提议落库与不直接晋级

- [x] 3.1 提议存储（`tier_proposal`：proposed_tier / reason / by=ai / at / ignored_at），与 page frontmatter 或独立表二者择一（design D2）
- [x] 3.2 `distill-scheduler.ts` 新增 `promotionPassSafe`：选材 → 调 `/promote` → 落提议；**不改页 tier**；失败只 warn（沿用 `tagPassSafe` 姿态）
- [x] 3.3 封顶纪律在提议落定时强制：suggest `canonical` → 存 `stable`；`tier_origin=human` 的页不生成提议
- [x] 3.4 `FD_MEMORY_PROMOTION_ENABLED` 开关（默认关或开需在实施时定，见 design Migration），关闭时零调用
- [x] 3.5 单测：AI 不直接改 tier；human 位不覆盖；忽略后冷却期内不再提议

## 4. fd-memory：接受/忽略与指标

- [x] 4.1 `src/http.ts` 新增提议读面（owner 视角，列出待确认提议）与接受/忽略动作；接受时改 tier 且 `tier_origin=human`
- [x] 4.2 `src/metrics.ts` 新增 `promotion: {candidates, proposed, accepted, ignored}`，接进 `metricsSnapshot()`
- [x] 4.3 单测：接受后 tier 生效且 origin=human；忽略后冷却生效；指标计数正确

## 5. paas：待确认提议面

- [x] 5.1 成果页 / 记忆面板展示待确认晋升（候选页、当前 tier、提议 tier、理由），支持接受/忽略
- [x] 5.2 tier 徽章与筛选反映最新 tier（复用既有 `parseTier`，勿引入第二套解析）
- [x] 5.3 i18n 五语言（zh-CN / en / ja / fr / es）

## 6. 上产与真机验收

- [x] 6.1 fd-memory 出片 + distiller 出片，GitOps 滚版（`all-services/prod/fd-memory.yaml`，主容器与 initContainer 两处）
- [x] 6.2 paas 出片 + 滚版
- [x] 6.3 真机验：首轮候选数、token 消耗、`/admin/metrics` 的 promotion 计数可见
- [x] 6.4 真机验：接受一条提议后 tier 变更且 origin=human；忽略一条后冷却生效
- [x] 6.5 真机验：AI 产出的提议中不出现 canonical
- [x] 6.6 台账 §15.79 续五 + `docs/memory-architecture-v2.md` 补晋升通道小节
