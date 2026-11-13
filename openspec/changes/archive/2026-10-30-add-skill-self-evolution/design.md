# Design: add-skill-self-evolution

## Context

闭环的四块基石三块已在：①**观测与蒸馏**（L0 capture 零 LLM、distiller 契约、per-owner 日预算门）
——候选的证据与预算纪律直接沿用；②**评测科学门**（memory-eval：隔离 scratch root、同模型同温、
judge 盲评、臂匿名、「评测是证据」的认识论）——harness 是 fd-memory 仓资产，paas 侧做装配器；
③**技能热载**（custom_skills DB 为真源 + `skill-materialize.js` 物化 + chokidar 热载）——晋升
零重启。④缺的是**闭环本体**：提议工具、候选 store、A/B 装配、待确认面。

参照判例：blueprint LLM 判据的双钥匙（「模型判绿是证据，主人签字是终审」）与 laneError 分界
（「判据没跑成≠通过」）——两条都是真机教训换来的，本 change 直接继承。

## Goals / Non-Goals

**Goals**

- 回合里踩出的好路径可沉淀为技能，且每一格晋升都有评测证据与人的签字。
- 永不删页：supersedes lineage，历史可溯。

**Non-Goals**

- 不做自动晋升（人终审是硬门，放松即违背双钥匙）。
- 不让 agent 提改运行时/安全边界/他人技能/pack 技能。
- 不改 memory-eval 的记忆三臂形状（harness 复用，臂形状是本 change 的新装配）。
- 不做跨 owner 技能市场（候选归 owner；上架走既有 pack 供给链，是另一条路）。

## Decisions

### D1 · 候选是独立 store，不是 custom_skills 加状态列

`custom_skills` 是「在役技能」的真源，物化器直接镜像它——混入候选态会让物化器与工具面必须到处
过滤状态列，一处漏滤就是候选提前生效。独立 `skill_candidates` 表，晋升=单向写入 custom_skills
（一次性动作，有审计），边界物理化。

### D2 · A/B 臂装配走评测 harness 的「场景任务」通道

memory-eval 的三臂对照以「场景任务 prompt + 注入差异」运行；技能 A/B 同构——任务 prompt 相同，
唯一差异是技能面是否携带候选。supersedes 候选升三臂（无/旧/新），judge 一次盲评三份 transcript。
门判据用「不劣于」而非「严格优于」：技能的价值常在稳定性（少踩坑）而非峰值，严格优于会把
等价但更可复用的技能卡死在门外；「劣化不晋升」守住下界。

### D3 · 预算/频控/上限全沿既有纪律，不新造

提议=per-owner 日预算（沿打标车道）、同任务 debounce（沿蒸馏 cursor 语义）、store 上限（沿
蒸馏 fact 上限）——三处都是已验证的「防 AI 自我膨胀」机制，直接继承参数化。

### D4 · 工具面挂载沿工具注册既有缝，无执行语义

`skill_propose` 只写候选 store（纯结构化输入校验+落库），无任何执行/物化调用——「提了不做，
做完才算」由工具面物理保证。

### D5 · pack 技能与运行时面在工具入口结构性拒绝

`skill_propose` 对目标为 originPackId 技能或运行时/权限类「技能」直接结构化拒绝（不是提示词
恳求）——越界面在入口收窄，与 fleet-mcp-hints 的「身份不对 vs 超授权分开」同款纪律。

## Risks

- **评测成本**：A/B 一次=两三臂×场景回合，吃真车道 token——沿评测隔离 root+按需触发（人点
  「跑评测」而非自动跑），且受评测侧既有预算约束；tasks 里有成本核对项。
- **场景代表性**：单场景 A/B 过门≠普适——报告与 lineage 里如实标注「过门场景」，跨场景泛化
  留给后续多场景扩展（本案不做，防漂移）。
- **候选质量噪声**：上限+预算+无证据拒收三道闸压噪声；待确认面按评测结论排序，劣化候选自然沉底。


## Implementation Notes (apply 2026-10-30)

- **评测 harness v1 落在 paas 侧**（`server/skill-eval.js`）：design D2 的「复用 fd-memory harness」
  是跨仓依赖——v1 用 paas 自己的轻量实现守住同样的科学纪律（同任务同车道、臂名甲/乙/丙匿名、
  judge 盲评、"不劣于"门、"评测没跑成≠通过"），跨仓复用留 v2。
- **结构保证落地**：候选在独立 `skill_candidates` 表（v109），custom_skills 只在 promote 单向写入；
  桥子单工具 `skill_propose`（bundle 自激活，loopback 豁免）——评测/晋升/驳回无工具面。
- **坑**：①db.js 导出 getDb()（无裸 prepare），async 路由未捕获的 throw 会让 express 4 请求挂起
  （测试以 pending 挂死暴露）②deserialize 的 eval_report 解析引用错变量——evalReport 恒 null，
  断言逮住。
- web 待确认面挂在技能设置页顶部（候选为空完全不渲染）；评测按钮是主人手势，两臂+judge 共
  2-3 次车道调用（成本随 4.4 实测入台账）。
