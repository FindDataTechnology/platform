## Why

壹座编排骨架已落地（turnRequest 派生契约、六种编排边、事件唤醒、O1 事件收口），但「谁有权让智能体开工」没有表达位：现行事件唤醒是「命中边即唤醒」（上限内一律建回合），没有发送者身份、没有强度、没有影子档、没有入站去向账。外部 bot 消息是唯一的无人值守准入面——缺授权层，意味着自动化程度越深、风险面越裸。设计宪章 `docs/agent-domain-design-charter.md` §1/§8 已将授权层列为当前最大缺口，本案即其首批落地。

## What Changes

- 事件来源的唤醒回合在创建时记录**不可变授权 mandate**：强度（explicit/inferred）、basis（via=edge 等准入依据）、信号源策略版本戳、触发引用（chatKey/发送者）。
- 入站触发**去向账 disposition**：每个 bot 入站消息有精确终局（admitted / filtered+reason / would-accept / cap-refused）+ 结构化 reason code，拒绝自由文本归因；现行 cap 超限的 O1 留痕并入统一账。
- 信号源**准入表**：按「接收范围 × 发送者身份（名单内/外、bot）× 是否点名 bot」三轴给 cell（explicit/inferred/忽略）；现行行为（命中边=explicit）为默认值，零扰动。
- **影子放量档**：off（默认，= 现行）/ observe（记录 would-accept 不建回合）/ auto（须主人明示开启且该信号源有显式接受规则）。
- **授权三操作**：accept 创建、人停撤销、恢复前重校验失败吊销；策略版本变更通知受影响的在途回合而不撤销其授权。
- worker 池**人优先槽位**：并发满时人的消息/状态查询可用 1 个额外槽，唤醒优先于新启动；cap 0（生产现状）时休眠不可见。
- 非目标：auto 默认开启、研判模型引入、depth>1 多跳、消息总线、改 carrier/tool_risk 执行闸的松紧（宪章 §4 拒绝清单）。

## Capabilities

### New Capabilities

- `agent-turn-mandate`: 事件来源回合请求的授权链——强度与准入表、影子放量档（off/observe/auto）、授权不可变三操作与恢复前重校验、入站去向账。

### Modified Capabilities

- `worker-pool`: 新增人优先槽位要求——人的消息/状态查询可用并发上限外 1 个额外槽，唤醒优先于新启动；cap 0 时行为与现状逐字节一致。

## Impact

- `server/fleet-event-wake.js`：mandate 记账挂点、准入判定接入（默认行为不变）。
- `server/fleet-events.js`：入站去向账的记录位（复用 O1 事件通道，新增入站侧类别）。
- `server/worker-slots.js`：人优先槽位规则。
- 策略与去向账落盘（非 SQL 表）：`<PLATFORM_DATA_DIR>/signal-sources.json`（每 bot 策略，缺省=现行行为）与 `signal-dispositions.json`（每 bot 有界环，默认 200 条，env 可调）。
- 不改：`runPersonaTurn` 执行路径、任务引擎调度语义、bot 自身会话回合、执行闸（carrier/tool_risk）语义。
