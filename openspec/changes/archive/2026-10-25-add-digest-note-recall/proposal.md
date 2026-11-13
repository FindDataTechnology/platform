# add-digest-note-recall

## Why

add-cluster-digest-injection 上产后，构造测试的精确反证暴露循环开环：drill 集群第二回合（23:01）拿到的 digest 块与第一回合（22:56）逐字节相同（空块），而第一回合 hook ② 的写回 note 已落盘（`drill-digest-20261025/notes/9c39e1a1.md` 在案）。机理：digest 召回只读 L2（facts/experiences），hook ② 写回的是 L1 note，而 u/ 根被蒸馏器 `d-` 守卫排除——**集群回合的写回永远没有读者，记忆不滚动**。本 change 让 /digest 纳入本 project 近期 notes（L1），零 LLM、fd-memory 单端发布，立即闭合「回合→写回→下轮召回」的生产循环。

## What Changes

- **/digest 召回扩层**：在 L2 候选（hybridCandidates，行为不变）之后，追加本 project 近期 notes 为 L1 条目（recentPages 过滤 type=note，上限 3 条、按新近排序），交同一渲染器按预算截断——排序纪律：open handoffs 通知段 > L2 条目 > L1 近期 notes，预算不够先截 notes。
- **响应形状**：`{digest, items, notes, truncated}`——`items` 仍为 L2 条数，新增 `notes` 计数；`truncated` 覆盖全部层。
- **明确不做**：u/ 根蒸馏启用（note 升 L2 的正道，属调度器+引擎契约 change，另行立项）；跨 project 召回；L1 notes 进 MCP query 面；paas 侧任何改动（ladder 逐字消费 digest，零变化）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `fleet-memory`：「平台缝 digest 读面」需求补 L1 近期 notes 召回与排序/预算纪律（既有四场景全部继承）。

## Impact

- **fd-memory**：`http.ts` /digest 组装处追加 notes 查询与映射（~20 行，渲染器/检索零改动）；单测 +3（notes 进块/L1 标注、预算挤迫先截 notes、忘页不进块）；单镜像出片。
- **风险**：①eval 分歧——接续评测钉的是「L2-only digest」，生产 digest 自此携带 L1 近期 notes；分歧在 design 记录，评测侧后续版本补 note 场景再钉（不回改本次基线）；②note 体积——excerpt 400 字 + 渲染器硬预算双护栏；③与 L2 重复内容（同事实先 note 后蒸馏）——短期共存可接受，蒸馏启用后靠 supersede 收敛。
