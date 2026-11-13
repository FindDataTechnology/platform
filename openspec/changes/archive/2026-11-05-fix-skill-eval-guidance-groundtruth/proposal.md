# fix-skill-eval-guidance-groundtruth

## Why

盲评 judge 无政策真值，政策型技能候选结构性地过不了 supersedes 闸：2026-11-05 A2 走查实测（§15.135 补记）——候选臂的「72h 自动升级」等政策条款被 judge 判「无从考证，属臆造政策细节，准确性存疑」，而 old 臂的既有声明反被判可执行；同场景下无指导的 control 臂自创政策值（P0/P1/P3/P4 混杂）却未被同等质疑。技能的价值恰在于携带公司政策等执行模型推不出的信息，而现行 judge 恰恰把这类信息当准确性负债——supersedes promote 腿在该缺口下结构性锁死（8 轮评测、闸四分支全部活体）。

## What Changes

- skill-eval 的 judge 提示词增加**指导文档真值段**：old 臂与 candidate 臂的技能正文以盲标（指导文档一/二，与回答的甲乙丙标签独立洗牌）随判词提供。
- judge 判据增加有据性规则：回答中与任一指导文档一致的政策/事实声明视为**有据**；任何指导文档与任务都不含的声明视为**无据**（准确性存疑）。有据性只解决真值核验，质量仍以完成任务的程度（正确性、完整性、可执行性）评——防「文档越长越占优」的偏置。
- 盲排语义不变：judge 不知道哪份文档属于哪个回答；闸判据（candidate best / tie 不劣于）不变。
- persona-eval 不动（角色重定义流的 judge 判据「符合各自角色定位」天然容忍条款差异，A3 全链已绿，无观察到缺陷）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `skill-self-evolution`: 「supersedes 三臂盲评」相关 requirement 改写——judge 评审输入增加指导文档真值段（盲标），有据性规则入判据；闸判据与双钥匙不变。

## Impact

- 代码：`server/skill-eval.js`（judgeUser 构造 + 判据文案）、单测（提示词构造 + 盲标独立性）。
- 行为影响面：supersedes 三臂评测的 judge 判定质量——政策型候选的新政策声明从「准确性负债」转为「可核验有据」；control 臂的自创政策值同步转为无据（不对称纠正）。
- 验收锚点：§15.135 被拒的 v3 形态候选（政策+条款注记）在新评测算下过闸 promote，`evolution_lineage` 落列、评审面可见。
