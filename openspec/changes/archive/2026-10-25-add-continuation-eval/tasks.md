# add-continuation-eval — Tasks

## 1. digest 渲染器（fd-memory `src/digest.ts`）

- [x] 1.1 实现 `renderDigest({ items, handoffs, budgetTokens, now })` 纯函数：handoffs 通知段最先保留、L2 条目按优先级截断、每条带 layer/confidence/日期标注、forget 与 expired 条目排除（输入侧即拒）
- [x] 1.2 单测钉死 spec 四场景：预算硬截断保 handoffs 段 / 被忘条目不进块 / 标注齐全 / 截断优先级顺序（进 CI 零 LLM 档）

## 2. 场景构造与脱敏（fd-memory `scripts/mk-continue-scenes.mjs` + fixtures）

- [x] 2.1 导出脚本：从指定生产 root 按会话边界切前史快照（L0 序列 + 边界前已存在的 L1/L2 页），过 `sanitize.ts` 同款管线，产出场景骨架带来源 root/project 与 `review: pending` 标记
- [x] 2.2 人工撰写续作任务与期望背景集合（脚本不编任务）；三 project（spider-heal / wx-alpha / mission-planner）× ≥4 场景，逐场景人工脱敏复核置 `review: reviewed`
- [x] 2.3 评测入口校验：`review != reviewed` 或场景数 <12 时拒绝运行（单测钉死入口门）

## 3. 三臂 harness（fd-memory `scripts/eval-continue.mjs`）

- [x] 3.1 模具复用：scratch root + TokenStore + 真调度器装载前史，digest 臂召回走调度器候选检索同模块（仅 top-k 参数差异，默认 k=5）
- [x] 3.2 三臂执行：同任务 prompt 同模型同温度，唯一差异注入块（无 / 标题列表 / digest 渲染）；臂名随机映射 A/B/C，映射表只落本地运行记录
- [x] 3.3 judge 调用：双指标 JSON 输出（re_derivation / first_step + 引用原文的依据段），期望背景集合进 prompt；judge 模型钉扎；逐调用 token 记账，600k 硬上限超限中止落档
- [x] 3.4 聚合与判门：场景级配对比较，按 design D6 双门阈值出裁决；分数明细足以离线复算裁决；结果写 `fixtures/eval/continue-baseline.json`（transcript 原文不进仓）

## 4. judge 校准与运行手册（fd-memory `docs/`）

- [x] 4.1 首轮前人工校准：≥3 场景 × 3 臂人工打分对照 judge 分，偏差 ≥2 分先修 prompt 版本再开全量（记录见 fd-memory docs/eval-continue.md：9 份中 8 份 ±1 内、1 份边缘裁定不修版）
- [x] 4.2 运行手册页：跑法、成本口径、judge prompt 版本记录、人工抽检条款、两段验证边界（实验结论 ≠ 生产结论）

## 5. 全量首轮与裁决入档

- [x] 5.1 全量 ≥12 场景跑通，裁决（过门/不过门）与全部分数入 `continue-baseline.json`；token 总耗记录
- [x] 5.2 （可选，过门后）网格敏感性：k∈{3,5} × 预算∈{800,1500} digest 臂增量跑，定生产默认值——四组跑毕（add-cluster-digest-injection 任务 3.1）：组间差不大于跑次方差，无可分者，维持 5/1500；方差观察（同参数自差 0.6）入 continue-baseline 注记
- [x] 5.3 paas 台账回填：S0 生产调查记录（§15.30：442 页语料 / 认领率 21%8% / 主 chat 零调用 / u/ 根零蒸馏触发 / 蒸馏器自愈与 embed 车道两日宕机复盘）+ 本轮评测裁决
