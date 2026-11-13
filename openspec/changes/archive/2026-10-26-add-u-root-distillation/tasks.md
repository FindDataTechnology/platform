# add-u-root-distillation — Tasks

## 1. 蒸馏器启用面（fd-memory）

- [x] 1.1 `distill-scheduler.ts`：`isDistillableRoot(rootKey, env)`（d- 恒真、u- 看 `FD_MEMORY_DISTILL_U`）；notifyCapture/fallbackScan 两闸换用；fallbackScan 对 u- 根走 `distinctProjects()` 发现
- [x] 1.2 `db.ts`：`notesAfter(project, cursor, limit)` + `distinctProjects()` + distill_state 加 `note_cursor` 列（幂等迁移）；distillOne 合成 note 条目（observation 形状，tool=memory_write_page，summary=标题+400 字摘录）并回写 note_cursor
- [x] 1.3 单测：u- 根入 pending/扫描（开关 on）/开关 off 零行为（字节等同）/note 条目进 items 且 cursor 前进不重蒸馏/日预算护栏覆盖人根/distinctProjects 发现

## 2. /digest deadline 与可观测

- [x] 2.1 `http.ts` /digest：embed 尝试封内部 deadline（3.5s，keyword 兜底照旧 model_note）；served-rung info 日志一行（rung=vector|keyword、items/notes/ms）
- [x] 2.2 单测：慢 embed（>deadline）→ 关键词块照出且 model_note 注明（模拟 6s 侧车）；快 embed → vector rung；日志行断言

## 3. eval 老.note 深度面

- [x] 3.1 fixtures 增 ≥2 个旧.note 场景（背景在同 project 排名 >3 的 note，review:"reviewed"）；harness 增蒸馏前置（EVAL_PREP_DISTILL）与对照渲染；跑门（avg diff ≥0.5 / win ≥70% / 老.note 子集蒸馏臂优于现 digest 臂 ≥1 分均值）；结果入 continue-baseline + runbook 回填

## 4. 出片与真机验收

- [x] 4.1 出片（fd-build-channel 判路 → GHA 池 → relay → ccr skopeo 门）+ GitOps 滚产
- [x] 4.2 真机：aloadtree 根等 fallback 周期眼见 distill 行与 L2 落地 + /digest 老.note 召回眼见；`FD_MEMORY_DISTILL_U=0`（GitOps env 一轮）零蒸馏对照后恢复
- [x] 4.3 台账回填（上线记录 + 观察项：人根 token 用量/L2 产出率/老.note 召回首例）+ 归档
