# memory-recall-card Specification

## Purpose

让「我记得…」从看不见的注入变成用户可见的开场卡：会话打开时把 owner 根的 digest 回显给该会话的 viewers——「越用越懂你」的承诺可见、可校、可纠；digest 注入契约不变，回显是旁路只读副本。

## ADDED Requirements

### Requirement: 会话打开记忆回显

会话打开时，服务端 SHALL 以该会话 owner 的记忆根读取 digest（空 query 形态），经 WS 事件 `memory_recall` 发给该 session 的 viewers；事件 SHALE 含 `{type, sessionId, block, sources?}`，block 为 fd-memory 服务端渲染的预算内文本（不得二次加工或截断拼装）。digest 失败或为空 SHALL 静默不发（无卡），任何失败不阻塞会话打开。

#### Scenario: 有记忆的新会话
- **WHEN** owner 根有历史记忆的用户打开一个新会话
- **THEN** 该 session 的 viewers 收到 `memory_recall` 事件，block 含最近 handoffs/L2/notes 的预算渲染行

#### Scenario: 无记忆或服务不可达
- **WHEN** owner 根为空、或 fd-memory 不可达、或读超时
- **THEN** 无 `memory_recall` 事件，会话正常打开

### Requirement: 开场卡渲染与纠错入口

ChatPage SHALL 在有 `memory_recall` 的新会话消息流顶部渲染可折叠「开场记忆」卡：正文直出 block 文本（保留行结构），来源徽标行级可见（harness 语义沿用），卡尾提供到 `/memory` 的纠错入口。卡 SHALL 可折叠且折叠态持久于会话内；旧会话（无事件）不渲染卡。digest 注入 prompt 的既有契约不变——回显卡不改变任何回合的 prompt 字节。

#### Scenario: 卡渲染与入口
- **WHEN** 收到含非空 block 的 `memory_recall` 事件
- **THEN** 消息流顶部出现可折叠卡，行级呈现 block，卡尾有 /memory 入口

#### Scenario: prompt 字节不变
- **WHEN** 回显开关开或关
- **THEN** 任意回合发出的 prompt 逐字节相同（回显纯旁路）

### Requirement: 回滚杆与零行为等同

`CELL_MEMORY_RECALL_UI=0` SHALL 全关回显（零 fd-memory 读、零 WS 事件、前端无卡）；开关打开而记忆不可用时的行为 SHALL 与关闭时用户可感知面等同（无卡）。

#### Scenario: 回滚杆
- **WHEN** `CELL_MEMORY_RECALL_UI=0` 时打开会话
- **THEN** 零 digest 读、零 `memory_recall` 事件，会话打开路径与关闭前逐字节等同
