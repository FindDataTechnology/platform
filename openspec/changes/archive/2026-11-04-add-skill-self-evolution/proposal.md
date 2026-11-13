# add-skill-self-evolution

## Why

「让 AI 自己迭代」是路线（`docs/roadmap-agents-native-teams.md` §5）的能力底座，分三层：
团队自迭代（`fleet-owner-iteration` 已在产）、skills 自进化（**缺**）、平台自迭代（远期）。
现状是：agent 的技能库（custom_skills + 物化热载）只能由人增改——一个回合里踩出的好路径
（怎么把某类任务做对）随会话结束就散了，下一次同样的任务从零摸索；而**评测科学门**
（`memory-eval`：隔离 scratch root、同模型同温、judge 盲评、臂匿名）与**零 LLM 观测面**
（capture）都已建制——AI 自我进化的两块基石齐了，缺的是把它们接成「提议→评测→人批→热载」的闭环。
参照对象：hermes agents 式「自己总结、自己进化 skills」。

## What Changes

- **提议（agent 提，不直接生效）**：回合收束后 agent 可经工具 `skill_propose` 产出**技能候选**——
  name/description/body（SKILL.md 形状）+ 依据（来源回合、该候选解决过什么、适用边界）。
  候选落候选 store（新表），**永不直接写 custom_skills**；与既有同名/同主题 skill 相关时
  SHALL 标记 `supersedes`（指向既有 skill 名），晋升时以 lineage 记录而非覆盖历史。
- **评测门（AI 证据，非 AI 终审）**：候选晋升前 SHALL 过技能 A/B 对照——同场景、同模型同温、
  隔离 scratch root、臂名对 judge 匿名（全部沿 `memory-eval` 的既有 harness 纪律），
  臂=无该 skill vs 携该 skill（supersedes 候选另加旧 skill 臂）。门判据=携 skill 臂
  judge 盲评不劣于对照臂且差异可解释；评测报告随候选存档（原件留档纪律）。评测是证据，
  **人接受是晋升的终审**（双钥匙纪律，沿 blueprint judge 的「模型判绿是证据、主人签字是终审」）。
- **晋升（人批后热载）**：门过+人接受的候选 SHALL 经既有 custom_skills CRUD 物化
  （`skill-materialize.js` 热载，零重启）；supersedes 候选晋升时旧 skill 保留 lineage 记录
  （audit 列），正文被新版本取代但历史可溯。人 SHALL 可随时驳回候选（驳回即终结、留审计）。
- **预算与频控**：提议走 per-owner 日预算门（沿打标车道既有纪律）；同任务重复候选 debounce；
  候选 store 有上限（防薄候选堆积，沿蒸馏 fact 上限同款纪律）。
- **边界（不可违反）**：候选只影响 owner 自己的用户级技能；agent SHALL NOT 提改运行时、
  安全边界、权限、他人/pack 自带技能的候选（pack 技能 originPackId 面不可自进化）；
  `skill_propose` 不携带任何执行语义（提了不做，做完才算）。

## Capabilities

### New Capabilities

- `skill-self-evolution`: 技能候选的提议、A/B 评测门、人批晋升与 lineage——AI 自进化技能的闭环。

## Impact

- **server**：新表 `skill_candidates`（迁移 v+1：id/name/description/body/evidence/supersedes/
  status(候选|过门|已晋升|已驳回)/eval_report/created_at）；新工具 `skill_propose`（进既有工具面
  注册，无执行语义）；候选 CRUD/评测触发/晋升路由（owner 鉴权）。
- **评测**：复用 fd-memory 评测 harness（隔离 scratch root、同源 judge、臂匿名）——paas 侧新增
  「技能臂」装配器（场景任务 prompt + 臂注入差异），评测运行沿隔离 root 纪律不触生产数据。
- **前端**：Extensions→技能面增「候选」区（列表/评测报告查看/接受/驳回）；i18n 五语言。
- **测试**：提议预算/debounce、A/B 装配（臂隔离与匿名）、门判定（平局/劣化不晋升）、晋升物化与
  lineage、驳回终结、pack 技能不可提改。
- **不影响**：memory-eval 的记忆三臂（臂形状不动，harness 复用）、pack 技能供给链、
  skill 包上传、action-gate。
