# Design — add-fact-reconcile-and-subject-normalization

## Context

- 生产首日（2026-10-22）实证：经验层 reconcile 健康（不重复 ADD），事实层 extract-only——每批 1-2 条薄 fact 互不合并；三根预算首日打满（~1.11M tokens，其中冻结坐标档案回填已由调优版 sha-7576187 止血：兜底需预算余量、批量 120）。
- S1 发现 3：subject 硬键在中文自由短语上漂移（2 例实测），与 Hy-Memory 自身把 `HY_FACT_SUBJECT_GATE` 默认关闭的理由一致。
- 引擎面已核实：`WorkingFactReconciler._parse_ops(text) -> {draft_idx: [fact_id…]}`（staticmethod、宽松解析，与我已包裹的 `_parse_ops` 修复同形）；`build_fact_reconcile_prompt` 模块级纯函数。

## Decisions

### D1 事实层 reconcile：映射语义 = 关联即合并

- sidecar 在 experience reconcile 之后对 fact 草稿跑事实层：`build_fact_reconcile_prompt(fact_drafts, fact_candidates)` → `provider.complete(max_tokens=2000, audit_stage="distill_fact_reconcile")` → 修复版 `_parse_ops`。
- 映射 `{draft_idx: [fact_id…]}` → 该 draft 落一条新 fact 页、`supersedes = 关联的 fact_id 列表`（并列合并多条薄记录）；无映射的 draft 按限流 ADD。候选 = 既有 fact 页（`distillCandidates` 已含 fact kind，sidecar 按 kind 拆分喂两路 reconcile）。
- 引擎的 fact reconcile 不产出 ADD/SKIP 指令——「无关联」即 ADD，语义比经验层简单，不需要复刻指令映射。

### D2 subject 双路判定：等值在先、LLM 判定殿后、可审计

- `normalize_subject(s)`：lowercase、NFKC 全半角归一、剥首尾标点与空白、压连续空白——python 纯函数（pytest 直测，S1 机器标识符 7/7 用例作夹具）。
- 等值不过 → 对「draft.subject vs 候选 subject 集」发起**一次** LLM 判定：以边界补丁向 fact reconcile 提示词尾部注入判定节（要求输出 `{"subject_matches": [{"draft": i, "fact": "id", "same": true}…]}` JSON 节），复用 json_repair 解析路径；判定行进 `llm_calls`（stage=`distill_subject_judge`），审计可还原每次判定。
- 判同 → 视同关联（并入 supersedes）；判不同 → 各自独立。**不改写产物 subject**（判定只影响归并）。
- 成本：每批至多一次额外调用（~1-2k tokens），计入既有预算护栏。

### D3 薄 fact 限流：上限 2 + 审计 warning

- `FACT_MAX_PER_DISTILL = 2`（env `DISTILLER_FACT_MAX` 可调）：reconcile 后按 confidence 降序取前 2 条落盘，其余以 `{stage: "fact_cap", warning: "dropped N fact drafts"}` 记入 llm_calls——与 C2 语言钉 warning 同一审计通道，无静默丢弃。
- 限流发生在 reconcile 之后：被合并的 supersedes 页不占上限（它们是「替换」不是「增量」）。

### D4 评测 v1.1 与验收

- LLM 档 `distill-scenes.json` +2：同主体两段（→ 单 fact supersede 链，断言 `facts 计数 ≤ 增量 1`）；S1 漂移对（→ 判同归并，断言 superseding fact 存在且两 phrase 各自页面不并存为活页）。
- python 测试：normalize_subject 表驱动（含 S1 7 个机器标识符逐字对 + 2 个漂移对走 mock LLM 判定）；fact 限流 drop 审计。
- 生产验收：滚 sidecar 后观察首批含 fact 的蒸馏——supersedes 链眼见、`distill_subject_judge` 审计行、预算增幅 ≤ ~10%。

## Risks / Trade-offs

- [误并：不同主体判同] → 评测漂移对钉住 + supersede 链可追溯、可 forget 单页恢复；判定提示词要求给出理由字段（进审计）。
- [判定调用放大成本] → 每批一次、仅等值不过时发起；预算护栏照算。
- [fact reconcile 引擎行为漂移] → pin 版本不变；`_parse_ops` 已是宽松解析 + 修复包裹，抗性同经验层。

## Migration Plan

仅 sidecar 镜像（`BUILD_DOCKERFILE` 池切换配方，用完还原）；无状态、cursor 语义不变、无需停机。回滚 = 回滚 sidecar 镜像 tag。fd-memory 服务零改动。

## Open Questions

（无——embedding 车道未就绪属 v2.2 前置，已单列登记，不影响本刀。）
