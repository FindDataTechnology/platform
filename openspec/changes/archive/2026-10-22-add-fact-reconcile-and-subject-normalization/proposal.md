## Why

蒸馏上线首日生产实证了两条事实层（fact）欠账（S1 发现 3/8 在真数据上的兑现）：① **薄 fact 无限累积**——引擎契约是每段轨迹总会写 1 条 fact（S1 发现 8），首日每批 1-2 条互不合并，长跑会把 owner 的 L2 事实层灌成薄记录流；② **subject 覆盖判定不可靠**——S1 发现 3 实锤 subject 作硬键时机器标识符逐字稳、中文自由短语漂移（`cheap-2 deploy/agent-api` vs `cheap-2 上的 deploy/agent-api (namespace serving)`），精确相等会把同一主体当两个。经验层已有 reconcile（UPDATE/SKIP 去重，生产已证不重复 ADD），事实层还停在 extract-only。

## What Changes

- **事实层 reconcile**（sidecar）：接入引擎 `WorkingFactReconciler`（`build_fact_reconcile_prompt` + `_parse_ops` → `{draft_idx: [fact_id…]}` 宽松映射）——draft 关联到既有 fact 即以 supersedes 合并（新页 + `supersedes[]`，旧页原样），无关联才 ADD；与经验层同一「永不删页只 supersede」纪律。
- **subject 规范化双路判定**：先规范化等值（大小写/空白/全半角/标点剥离），不等再经同一车道的一次 LLM 判定（提示词边界补丁注入「same subject?」判定节，产出结构化判定）；两路都不过才判不同主体。判定只影响 reconcile 归并，不改写产物 subject。
- **薄 fact 限流**：单次蒸馏 fact 产出上限 2 条（超出的丢弃并记 `llm_calls` 审计 warning），配合 reconcile 合并抑制事实层灌量。
- **评测 v1.1**：LLM 档加两场景——同主体两段会话 → 单 fact supersede 链；subject 漂移对（S1 原例）→ 判同主体归并。零 LLM 档不动（判定逻辑在 sidecar，python 测试覆盖规范化函数）。
- **明确不做**：embedding 召回（v2.2，车道前置未就绪——词元组不暴露 embeddings，bge-m3 平台不支持）；跨 project / 跨根去重；subject 改写。

## Capabilities

### New Capabilities

（无——落在既有 `memory-distiller` 能力内）

### Modified Capabilities

- `memory-distiller`: 「L2 写入纪律」补事实层 reconcile 语义（关联即 supersede 合并、薄 fact 限流）；新增「subject 覆盖判定双路」需求（规范化等值 → LLM 判定，判定可审计）。

## Impact

- fd-memory `distiller/engine.py`：事实层 reconcile 接线、subject 规范化与判定补丁、fact 限流（~150 行）；`distill.test` 无零 LLM 增量（判定在 sidecar）。
- 评测：`fixtures/eval/distill-scenes.json` +2 场景，`eval-distill.mjs` 断言扩展。
- 出片：仅 fd-memory-distiller 镜像（fd-memory 服务无改动）；滚 sidecar 即生效（无状态，cursor 语义不变）。
- 风险：LLM 判定多一次调用/批（~1k tokens，预算内）；误并（不同主体判同）→ 靠评测场景钉 + supersedes 链可追溯可 forget。
