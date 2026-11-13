# Proposal: add-fleet-architect-edges

## Why

NL 面(§15.17/18)已能编「结构」(岗位树/节奏/目标),但编导代数第一波已上产——orchestration 段、dispatch/handoff 边、mode 预制图都在生产跑了,架构师还只会建 cron 舰队。用户说「组一支主管式舰队」「抓取完交给撰稿」时,应编译为 mode/edges 而非「还不支持」。本 change 把边语法接进 draft/apply 全链,补齐 NL 面对第一波代数的表达力。

## What Changes

- **draft 接受 `fleet.orchestration`**:mode/constraints/edges 进草稿;校验链=先虚拟应用成员操作(建/改/删),再对**终态成员集**跑 `validateOrchestration`(边引用的岗可在同一草稿里新建——链式表达合法);errors/warnings 原样分流进 diff。
- **diff 呈现边**:mode、每条边(kind/from/to/args)、约束,与岗位操作同列逐行;含 supervisor 模式的隐式全对提示(读时展开,不落库)。
- **apply 透传**:create 模式 orchestration 随舰队落库(生而全队暂停惯例不变);edit 模式成员操作后 updateFleet orchestration;apply 重校验含图校验(漂移含边漂移如实报错)。
- **种子 v2 续版上架**:架构师 persona 提示词补边词汇(主管式/流水线/接棒/派发许可的措辞与边界——含「删除带边的岗位会连带清边,需单独确认」),`packId NoBBXkvxZnJNHlCrAwWp-w` 续 v1.1(§15.15 续版配方)。

## Capabilities

### New Capabilities

(无)

### Modified Capabilities

- `agent-fleet-architect`: MODIFIED——草稿校验需求扩至 orchestration 段(虚拟终态成员集上图校验、同草稿新建岗可被边引用、diff 呈边、apply 重校验含边漂移);三段分离与批准纪律不变。

## Impact

- **代码**:`server/fleet-architect.js`(draft 校验链+diff+apply 透传,复用 `validateOrchestration`/`expandedEdges` 零新规则);种子文件 v1.1;续版铸造脚本(一次性)。
- **测试**:`test-fleet-architect.mjs` 补边用例(带边建队/同草稿建岗+引用/环拒/编辑加边/apply 边漂移);十三套回归零新增红。
- **兼容性**:无 orchestration 的草稿行为逐字节不变;出片随下一列车(与派生顺序修正同车)。
- **非目标**:不编第二波边(event/fanout/rounds 环);不做结构化批准工具;不改驾驶舱。
