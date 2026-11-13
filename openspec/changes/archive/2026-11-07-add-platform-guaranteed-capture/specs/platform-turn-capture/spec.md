# platform-turn-capture Specification

## Purpose

把「记得住」从纪律文本的恳求升级为平台的担保：壹座全部对话面（web chat、社交 bot、智语房间）的每个回合收尾，由平台侧向 fd-memory `/observe` 上报一条 `turn_outcome` L0 observation——agent 自觉写 note 降位为 L1 观点层补充，记忆的 L0 底座由基础设施兑现。fire-and-forget、失败零影响回合。

## ADDED Requirements

### Requirement: chat 回合平台捕获

web 主聊天每个回合收尾时，平台 SHALL fire-and-forget 上报一条 `turn_outcome` 事件至 fd-memory `/observe`，落 owner（u/<email>）根 default project，metadata 一等字段至少含 `{harness:"yizuo", lane:"chat", sessionId, agentId, outcome, durationMs}`。tap SHALL 接在 `finishTurn` 的双载体（定义处与包装处）语义收尾点上，outcome 取值 ok/error/aborted。捕获 SHALL NOT 改变 finishTurn 的既有输出与广播（`done`、usage、sessions 刷新逐字节不变）。

#### Scenario: 正常回合落 L0
- **WHEN** 用户在 web 主聊天完成一个成功回合
- **THEN** owner 根 default project 出现一条 L0 observation，metadata.lane=chat、outcome=ok，digest 可召回

#### Scenario: 失败与中止同样落底
- **WHEN** 回合以 error 或 aborted 收尾
- **THEN** 同样落一条 L0 observation（outcome 对应），健康叙事不缺失败回合

### Requirement: bot 回合平台捕获

社交 bot（WeCom/Feishu/Telegram/公众号）每个回合收尾时，平台 SHALL 以同契约上报 `turn_outcome`（lane:"bot"，metadata 含 botId、chatKey），落 bot 部署 owner 的 person 根。正文 SHALL 遵守截断纪律（入站消息前 N 字符为 title 原料、final text 摘要为 body，不落工具输出与原始事件），且不与 bot 回复门禁语义冲突（被门禁扣住的回合同样落底，outcome 照实）。

#### Scenario: bot 回合落底
- **WHEN** 一个 bot 回合完成并投递回复
- **THEN** owner 根出现 lane=bot 的 L0 observation，含截断后的对话原料

### Requirement: 智语房间回合房间域捕获

智语房间的分身回合收尾时，平台 SHALL 上报 `turn_outcome`（lane:"zhiyu"，metadata 含 roomId、memberRef、outcome），落**房主 person 根的房间名下 project**（与集群 cron 的 room-id project 同构）——房间的多方对话 SHALL NOT 沉淀进任何成员的个人 default 根，与「值守分身不将其主人私人记忆带入空间」的隐私方向互为镜像（房间内容也不进私人根）。round-router 的 answered/passed/failed 三分支 outcome 照实上报。

#### Scenario: 房间回合落房间工程
- **WHEN** 一个分身在房间中应答（或过/失败）
- **THEN** 房主根的房间 project 落一条 lane=zhiyu 的 L0 observation，成员个人根不受影响

### Requirement: 失败即丢与回滚杆

捕获 SHALL 沿 SDK observe 客户端契约：不 await 进回合关键路径、有界超时、失败只计不抛、不重试。env `CELL_MEMORY_OBSERVE_TAP=0` SHALL 全关三面 tap（字节等同回滚），owner 令牌不可用时 tap 静默丢弃（fail-open 与舰队捕获同契）。

#### Scenario: 记忆服务不可达
- **WHEN** fd-memory 不可达时回合收尾
- **THEN** 回合正常完成，tap 丢弃并计一条观测计数，无重试风暴

#### Scenario: 回滚杆
- **WHEN** `CELL_MEMORY_OBSERVE_TAP=0`
- **THEN** 三面零 /observe 请求，回合输出与关闭前逐字节等同

### Requirement: 蒸馏接替语义不受影响

tap 落下的 L0 observation SHALL 走 fd-memory 既有 observation 页型与蒸馏管道（L0 由页型派生），与人工/agent 写入的 note、L2 事实在蒸馏消费时同权；tap 产生的 observation MUST NOT 被 echo 去重误吞 agent 主动写的更正 note。

#### Scenario: tap 底座与 agent 观点共存
- **WHEN** 同一会话中平台 tap 落了回合 L0、agent 又主动写了更正 note
- **THEN** 蒸馏消费两源，更正接替旧结论，回合 L0 作为过程叙事保留
