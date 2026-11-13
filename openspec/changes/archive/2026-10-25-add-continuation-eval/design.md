# add-continuation-eval — Design

> 真源：`docs/memory-architecture-v2.md` §10/§12（评测三指标、v4 门）、ADR-0030 决策 5（没有评测的迭代是盲改）。S0 生产调查（2026-10-25）：442 页 L2、认领率 21%/8%、主 chat 零调用、集群 hook ① 仅注入标题。模具：`scripts/eval-distill.mjs`（scratch root + 真调度器 + 真 sidecar）。

## D1 三臂而非两臂

无记忆 vs digest 只能证明「有没有用」；标题臂把**生产现状**（集群 hook ① 的 `- title（date）` 列表）钉成对照组，回答「目录卡够不够、差多少」——S1（把标题升级为内容）与 S3/S5（digest）的取舍由这组差值裁决。标题臂不设门：无论它多差，生产注入线的立项依据只看 digest vs 无记忆。

## D2 渲染器：`src/digest.ts` 纯函数，检索同源

- 输入：`{ items: 召回条目[], handoffs: open 交接[], budgetTokens, now }`；输出：渲染块字符串。无 IO、无网络——单测覆盖预算截断、标注、forget/expires 排除（spec 场景逐一钉死）。
- **检索不在渲染器内**：digest 臂的召回调用调度器候选检索同一模块（向量优先、关键词兜底），参数差异仅 top-k（默认 k=5；生产候选 top-8 不动）。评测不得另造检索——否则评测结论对生产召回无外推力。
- 放 `src/`（进镜像、无行为面变化）而非 scripts：S1/S3/S5 直接 import 同一渲染器，「原型即产物」，杜绝两套格式漂移。

## D3 场景构造协议（一次性脚本 + 人工复核）

`scripts/mk-continue-scenes.mjs` 从指定生产 root 导出：取一个会话边界的 L0 观测序列 + 该边界前已存在的 L1/L2 页（`updated_at` 截断）→ 过 `sanitize.ts` 同款脱敏 → 产出场景骨架（前史快照、来源标注）。**续作任务与期望背景集合人工撰写**（脚本只搬数据，不编任务）：期望背景集合 = 判定「本可知道」的基准，逐条对应前史中的事实。覆盖 spider-heal / wx-alpha / mission-planner 三 project × ≥4 场景 = ≥12。脱敏复核状态字段未置 `reviewed` 的场景被评测入口拒绝。

## D4 被评 agent 的模拟边界：纯 LLM 首回合，不跑真 harness

被评对象 = 新会话 agent 的**首回合响应**（拿到任务 prompt + 可选注入块后的计划与下一步声明）。用词元车道直连 chat 调用模拟（无 dsh、无工具执行）：测的是「背景在场与否」的对照效应，工具执行的成败噪声故意排除。被评模型钉扎 lane 主力（跑分时记录模型名与温度，进基线档）；换被评模型 = 新基线序列，不与旧序列混比。

## D5 judge：双指标、盲评、结构化输出

- 一次 judge 调用评一份 transcript，输出 JSON：`{re_derivation: 1-5, first_step: 1-5, evidence: [...]}`——重推导度（5=零重推导）与首步正确性（5=下一步与期望背景完全一致），依据段引用 transcript 原文。
- 判定基准 = 场景自带期望背景集合（judge prompt 附上），不让 judge 猜。
- 盲评：三臂 transcript 打乱臂名（A/B/C 随机映射，映射表只在本地运行记录里）。judge 与被评模型分开实例调用（同车道不同调用序列），judge 模型钉扎并记入基线档。
- 人工抽检：每轮全量抽 ≥3 场景 × 3 臂人工核 judge 分，偏差 ≥2 分的 judge prompt 修版须重跑全量（运行手册条款，不做工具）。

## D6 硬门（v4 解锁门）——数字定死

场景级配对（同场景 digest vs 无记忆，平局不计负）：

- **门 1（重推导度）**：平均分差 ≥ **0.5**（5 分制）且配对胜率 ≥ **70%**
- **门 2（首步正确性）**：平均分差 ≥ **0.5** 且不劣率（胜+平）≥ **70%**

两门同时过 = 过门（S3/S5 立项依据）；任一不过 = 不过门，分数入档作迭代对照。n ≥ 12 场景才可出裁决（场景不足时脚本拒绝判门）。裁决仅凭场景级分数明细可复算（spec 钉死）。

## D7 成本口径与护栏

每场景 = 3 臂 × (agent ~3k tok + judge ~3k tok) ≈ **18k tokens**；全量 12 场景 ≈ **220k**，一轮网格敏感性（k∈{3,5} × 预算∈{800,1500}，只跑 digest 臂增量）再加 ~80k。硬上限：单次全量运行 ≤ **600k tokens**（与蒸馏日预算同量级，独立记账、不复用蒸馏额度）；超限即中止并落档。所有调用走词元车道既有凭据（`MEMORY_LLM_*` 口径），token 消耗逐调用记录进基线档。

## D8 与 CI / eval-distill 的关系

- 渲染器单测（纯函数）与场景入口校验（脱敏复核门）进 CI 零 LLM 档。
- 三臂评测本身必然 LLM——**不进 CI**，按需跑（引擎/检索/渲染变更后、v4 门裁决时），与 eval-distill 的 LLM 档同纪律。
- 与 eval-distill 并列独立脚本，共享模具组件（scratch root、TokenStore、StoreRoot 构造），不共享判定逻辑。

## D9 落档形状

`fixtures/eval/continue-baseline.json`：数组 of 运行记录 `{ran_at, scenes_version, agent_model, judge_model, per_scene: [{scene, arm, re_derivation, first_step, tokens}], verdict, thresholds}`。版本化进仓（脱敏 transcript 不进仓——只进分数与依据段引用偏移，原文留在运行机本地）。

## D7' 回滚与风险

零生产面：不改服务路由/存储/部署；fd-memory 镜像虽含渲染器但无调用方。回滚 = 不跑。最大风险是**外推力**：纯 LLM 首回合证明的是背景效应，不等于真 harness 端到端收益——过门后的 S3 落地仍须以生产认领率/续作观测复核（两段验证，别把实验结论当生产结论）。
