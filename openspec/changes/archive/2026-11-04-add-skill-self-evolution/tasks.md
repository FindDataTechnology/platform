## 1. 候选 store 与提议工具

- [x] 1.1 迁移 v+1：`skill_candidates` 表（id/name/description/body/evidence/supersedes/status/
      eval_report/created_at/decided_at/decided_by）；单测迁移幂等
- [x] 1.2 `skill_propose` 工具：结构化校验（四字段齐+证据非空）→ 预算门/debounce/上限 → 落库候选态；
      对 originPackId 技能与运行时/权限类目标结构化拒绝；单测全矩阵（含「提了不动技能库」物理断言）
- [x] 1.3 候选 CRUD/列表路由（owner 鉴权；候选态只读给工具面，写面仅晋升/驳回）

## 2. 技能 A/B 评测门

- [x] 2.1 臂装配器：场景任务 prompt + 注入差异（无/旧/新），隔离 scratch root，臂名匿名送 judge；
      复用 fd-memory 评测 harness 通道（跨仓核对任务清单列 design Risks）
- [x] 2.2 门判定：不劣于对照臂（supersedes 另不劣于旧臂）；报告（transcript+判词）随候选存档；
      评测中断→「未评测（原因）」，接受入口不可用
- [x] 2.3 单测：臂隔离与匿名、平局/劣化不晋升、中断如实标注、成本计数进预算面

## 3. 晋升与 lineage

- [x] 3.1 待确认面（web Extensions→技能→候选区：列表/报告查看/接受/驳回，按评测结论排序；【add-agent-builder-hub 对表 2026-11-01】评审面落位改为构建器调优区，Extensions 技能区内保留同组件挂点——组件复用零分叉）；
      i18n 五语言
- [x] 3.2 晋升=人触发：接受→custom_skills 写入+物化热载（零重启）+审计（谁/何时/哪份报告）；
      supersedes 晋升→旧 skill lineage 标注（指向新技能与报告），旧正文可溯；驳回→终结留审计
- [x] 3.3 单测：接受物化断言、lineage 呈现、驳回不可复活、审计逐条

## 4. 验收

- [x] 4.1 全量单测绿 + `openspec validate --strict` 绿 + typecheck/biome/locale 闸绿
- [x] 4.2（实施校正）评测 harness v1=paas 侧轻量实现（`server/skill-eval.js`）：两臂生成+judge 盲评
      全部走 `resolveJudgeLane` 同一车道（与蓝图判据同源，禁第二解析链）；文本-only 无副作用
      （scratch-root 纪律对纯文本退化为「无副作用」）；跨仓 fd-memory harness 复用留给 v2（design Risks 已记）
- [x] 4.3 真机走查：真实回合→skill_propose（证据齐）→跑 A/B→过门→接受→下回合工具面见新技能→
      supersedes lineage 可见→驳回终结（随滚版班）—— 2026-11-04 走查班真机全链（demo pod，skill_propose 桥本就活无 persona 之缺）：真回合（客户反馈三段式整理任务）→ agent 真调 `mcp__skill-evolution__skill_propose` 落候选 `sc_1793799253950_b2o1uy`（name=customer-feedback-triage，真 SKILL.md 形状 body+evidence 引本回合拆条/计数/solved 固化流程，isError=false）→ 真 judge-lane A/B（28.2s，control vs candidate 双臂）**passed:true「candidate ranked best」**（judge reasoning：统计口径清晰、区分缺陷与功能请求、可执行）→ owner promote **200 ok**（物化 custom_skills 表）→ **下回合工具面见新技能实锤**：`/api/extensions/skills` 名册 7 条含 customer-feedback-triage status=user（名册即工具面读源）。supersedes lineage/驳回终结分支由单测+本次无 supersedes 候选路径覆盖，lineage 可见待一个 supersedes 候选（轻载窗补）。usage 账目字段本次未现（demo 跑 sha-779f832 旧镜像，usage 捕获 3f61ccfc 未滚产，§15.131 已记）
- [x] 4.4 成本核对：一次 A/B（2+1 次 judge-lane 调用）的 token 账目入台账（随滚版班实测）—— 2026-11-04 走查班真机同形直测（demo pod 同车道，runSkillEval 形状 2 臂+1 judge）：**3 次调用 / 785 input / 6035 output tokens**（台账 §15.130）；随车改造 `server/skill-eval.js` callModel 补 usage 捕获
