# 简报 · fleet 回合可靠性（给 `fix-overflow-attribution` / cron-runner 线）

> 2026-11-10。全部为 fd-prod 只读取证。**不含任何代码改动建议以外的动作**；
> 我不碰 `cron-runner.js`（那条线今天改了三轮）。本文只给证据、判据、和“改完怎么验”。

## 一、先说不要被哪些数字误导（这两条我先信过、后被推翻）

| 常见读法 | 实际 | 错在哪 |
| --- | --- | --- |
| 「近 6h 60% 回合失败，平台坏了」 | 那是 04:00–06:00 上游 503 事故窗；**48h 稳态撞墙仅 9%**（69/761） | 窗口 |
| 「失败率＝故障率」 | 压力类失败里 **78%（116/149）已报过数**——是“跑完被掐断”，不是“跑挂” | 没拆两半 |

判据纪律：报失败率必须同时给**时间窗**和**是否已报数**，否则会吓人也会骗人。

## 二、硬证据（可复核）

### 2.1 撞墙画像（48h，全 cell）

```
撞墙 110 条
kind:     turn_budget_exceeded 86 / context_overflow 24
model:    deepseek-v4.1-flash 99 / glm-5.3-flash 11
均 compactions 4，均 steps 12
lastTool: (无)28 · report_status 14 · bash 13 · read 11 · memory_handoff_begin 6 · edit 5 · skill 5
```

`lastTool` 前两名里有 `report_status` 和 `memory_handoff_begin`——**多数回合是在收尾阶段撞墙的**，
与“78% 已报数”一致。

### 2.2 `attributionFor` 从未拿到输入（这是一个确定的缺陷）

`server/cron-runner.js:481` 的 `attributionFor({priorCacheRead, contextWindow})`
是专为回答“历史累积 vs 单轮过大”写的，要求两个输入都非空：

```js
if (priorCacheRead === null || priorCacheRead === undefined) return {};
if (contextWindow === null || contextWindow === undefined) return {};
```

**全仓没有任何调用方传过这两个参数。** `attributeFailureAndSalvage`（518）签名里有、
默认 `null`；唯一调用点（1081）传 7 个实参，恰好漏了这两个。

实测：**110 条撞墙记录的 `detail.cause` 100% 是「未判定」**。

对照实验：

```js
attributionFor({priorCacheRead: 100000, contextWindow: 128000})
// -> {"cause":"history_accumulation","priorCacheRatio":0.78}   会判定
contextPressureDetail("...context pressure", {compactions: 4, reported: true})
// -> {kind:"turn_budget_exceeded", contextPressure:true, compactions:4, reported:true}
//    没有 cause —— 生产就是这个形态
```

**数据源是有的**：`member_turn_events.usage_cached_input`，48h 内 48% 的行有值（最大 222720）。
所以这是纯接线活，约十行。

建议接线方式（仅供参考，不替你定）：

```js
const prev = /* 同一 session_id 上一轮的 usage_cached_input */;
await attributeFailureAndSalvage(ctx, {
  ...,
  priorCacheRead: prev ?? null,
  contextWindow: contextWindowFor(model) ?? null,
});
```

**验收判据**：110 条撞墙里 `cause` 非空比例显著 > 0，且
`history_accumulation` 与 `single_round_too_large` **两桶都出现**。
只出一桶 = 判据口径写错了，不是修好了。

### 2.3 岗位的两种“自认工具故障”（不是模型胡编，是合理误推）

六条上产后决策项里三条是误报，机制已实证两种：

| 机制 | 实例 | 客观核查 |
| --- | --- | --- |
| **转述错误** | 常务岗：“`decision_queue` / `escalate` 均报 `this agent is not a member of any fleet`” | 该话术唯一出处 `server/fleet-reports.js:151`，属 **`report_status`** |
| **规律类推** | CEO：“试 `m_1792719144128_akv3fj` 与 `m_akv3fj` 均返回 not a member，探活失败” | 真实 id 是 `m_1793223622441_akv3fj`；前者 = 舰队时间戳 + 常务岗后缀，**不存在** |

其余岗位 id 确实是 `m_1792719144128_*`（与舰队同期创建），只有常务岗和外联部是后来加的、
时间戳不同——所以模型的类推**在规律上是对的，只是那一例是例外**。

这不是“模型乱编”。要治的是**报之前先验一次**：
探活前用 `fleet_members` 确认 id 存在；转述工具错误时带工具名原文。

## 三、我做过但**不建议**往下走的（省你时间）

| 试过 | 结果 |
| --- | --- |
| 给 prompt 加“步数≤N”降撞墙 | **全量无效**：有上限 117 回合 9%，无上限 747 回合 10% |
| 把“报过数仍记 failed”改成已交付 | 不该改：`cron-runner.js:1108` 注释写明是有意的（`the round STAYS failed (it did not finish) but the fleet gets the data it was going to get anyway`） |
| 用内容正则分“业务/自我诊断” | 口径不可靠：会把“跨线等另一条线的产出”误杀（实测 6 条里误杀 2 条） |
| prompt 加 escalate 措辞提产出 | 全库 7.9×，但收窄到已启用舰队后只有 2.8×，落在“无效”区间 |

## 四、一句话交接

**fleet 回合现在有两个独立问题**：①（确定的缺陷）`attributionFor` 没接线，所以至今无法
区分“会话攒太多”还是“单轮太大”——而这两种的治法相反；②（可靠性）岗位遇到异常先发
“基础设施坏了”而不是先查事实，已实证两种误报机制。

第 ① 条是十行接线活，判据在上面；第 ② 条要的是“报前先验”，我没有可靠的改法建议。
