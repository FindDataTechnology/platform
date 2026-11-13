# memory-portal-ui Delta Spec

## ADDED Requirements

### Requirement: 记忆浏览的分层与节奏

记忆面板 SHALL 以分层结构呈现：持久记忆（durable）与情景记忆（episodic）分组呈现，各组有可读分组标题与层级徽章（状态词表或中性徽章），MUST NOT 以同一节奏的等高卡片瀑布穷举全部记忆；时间信息 SHALL 可扫读（时间戳分档：今日/本周/更早）；标签 MUST NOT 使用词表之外的即兴色（如紫色）。

#### Scenario: 分层可辨

- WHEN 面板同时存在持久与情景记忆
- THEN 两类记忆以分组标题分隔，且每个条目的层级徽章说明其归属

#### Scenario: 标签不越词表

- WHEN 任意记忆条目渲染标签
- THEN 标签颜色来自既有中性/状态词表，无第二强调色
