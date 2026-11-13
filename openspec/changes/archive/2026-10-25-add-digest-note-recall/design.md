# add-digest-note-recall — Design

> 前置实证（§15.31 补记三）：drill 集群第二回合 digest 与第一回合逐字节相同（空块）而首回合写回 note 已在盘——hook ② 写回（L1 note）在 /digest 召回（仅 L2）里不可见，循环开环。

## D1 为什么是「召回扩层」而不是「蒸馏启用」

闭合循环有两条路：A) 让 u/ 根可蒸馏（note→L2）；B) digest 召回直接带 L1 近期 notes。选 B 先行：零 LLM（A 要动调度器 `d-` 守卫 + Distiller 契约加 note 物料 + 预算口径）、单端发布（A 双端）、即时生效（A 要等蒸馏周期）。A 作为后续 change 保留——它是「note 升 L2 的正道」，本 change 的 L1 条目与未来 L2 靠渲染优先级共存，蒸馏启用后同事实经 supersede 收敛。

## D2 组装与排序纪律

`/digest` 组装顺序：L2 候选（hybridCandidates，k 与向量/关键词行为零变化）→ 追加 notes（`recentPages(limit, [project])` 过滤 `type==='note'`，取前 3，新近在前）→ 合并为 items 数组**传入同一渲染器**。渲染器既有预算纪律自然承载排序：handoffs 段最先、数组序即截断序——所以 items 数组内部 L2 在前 notes 在后即可，不改渲染器一行。confidence：notes 无此字段，条目省略置信段（渲染器已容 null）。excerpt：note body 去 section 头切片 400（与 L2 同一卫生规则）。

## D3 计数与诚实形状

响应 `{digest, items, notes, truncated}`：items=L2 命中数、notes=实际进块数（非候选数——截断后如实）。truncated 判定改为「渲染出的条目标注数 < items+notes 候选数」。空 project：两层皆空，块仅 header+handoffs（空则无该段），与现状一致。

## D4 eval 分歧（在案，不回改基线）

接续评测钉的 digest 臂 = L2-only；生产 digest 自此 = L2 + L1 近期 notes。分歧影响外推力的方向是**加法**（生产块信息 ≥ 评测块），且 L1 notes 角色类似评测里的 handoffs 段（同样零 LLM 直采）。评测侧下版本补 note 场景（会话留档含写回 note 的续作）再钉生产形状；本次不重跑、不回改 continue-baseline。

## D5 安全面零变化

notes 与 L2 同 root 同 project，权限/脱敏路径完全复用（/pages 写入时已 sanitize；派生索引剔除忘页）；digest 面鉴权矩阵不动。无新 LLM 调用、无新外部依赖。

## D6 验收（构造测试复刻 §15.31 三的手法）

单测三枚钉 spec 场景。真机：重建 drill 集群跑**两回合**——第二回合的 digest 块必须含第一回合写回 note 的内容（「集群回合 2026-10-25 …」条目带 L1 标注眼见），即开环→闭环的直接证据；跑毕清 drill 残留。台账 §15.33 回填。
