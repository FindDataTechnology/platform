## MODIFIED Requirements

### Requirement: bot 入站消息唤醒绑定的岗位

社聊 bot 的入站消息在既有守卫(尺寸/频次)全部通过后,系统 SHALL 额外扫描舰队的 event 边:存在 `from:"bot:<该 bot>"` 的边时,SHALL 为每条边的 to 岗位创建 manual 回合——brief 含发送者与消息原文、`origin.fleet {memberId, depth:0}` 与 `origin.event {botId, chatKey}`,该回合 SHALL 经既有收口产出 source=event 的 O1 事件。

同一信号源在同一会话内的**连发消息 SHALL 合并为一次唤醒**：系统 SHALL 以（信号源，会话）为键、在短窗口内缓冲入站消息，窗口关闭时以**合并后的对话**创建至多一个回合，SHALL NOT 为每条消息各起一回合。窗口长度 SHALL 可配置，且 SHALL 支持取 0 以恢复逐条唤醒的旧语义；窗口未关闭前 SHALL NOT 创建任务。合并 SHALL 如实：合并回合 SHALL 记录其承载的消息条数，正文超长 SHALL 截断并留可见标记，被略去的早期消息 SHALL 在正文中显式说明条数，SHALL NOT 静默丢弃；发言人 SHALL 取最后一位发言人，「被点名」判据 SHALL 为任一条消息命中。不同会话的消息 SHALL NOT 合并。bot 自身的会话回合 SHALL 照常执行(bot 答聊天,岗位异步做舰队事)。护栏:每岗每小时唤醒次数 SHALL 有上限(默认 30,环境可配),超限 SHALL 不建任务并落结构化 O1 事件如实留痕。无命中边的入站消息 SHALL 零扰动。

#### Scenario: 命中唤醒

- **WHEN** 客服 bot 收到一条消息,且某舰队声明了 event 边 bot:客服bot→客服岗
- **THEN** 客服岗起 manual 回合(prompt 含消息原文与发送者),O1 事件 source=event;bot 照常回答聊天

#### Scenario: 护栏超限

- **WHEN** 一小时内该岗被唤醒已达上限又来一条命中消息
- **THEN** 不建任务,落 O1 事件留痕拒绝

#### Scenario: 无命中零扰

- **WHEN** 一条入站消息没有任何 event 边引用该 bot
- **THEN** 不产生任何舰队任务与事件,bot 行为与现状逐字节一致

#### Scenario: 连发消息只唤醒一次

- **WHEN** 同一 bot 在同一会话内于窗口内连发三条消息
- **THEN** 窗口关闭后只创建一个回合，其正文含三条消息内容，且记录承载消息数为 3

#### Scenario: 不同会话不合并

- **WHEN** 同一 bot 在两个不同会话各发一条
- **THEN** 各创建一个回合，互不包含对方内容

#### Scenario: 关闭窗口恢复逐条唤醒

- **WHEN** 窗口配置为 0
- **THEN** 每条消息立即各创建一个回合（与引入本条款前逐字节一致），且不记录承载条数

#### Scenario: 合并正文超长留标记

- **WHEN** 合并后的正文超过既有长度上限
- **THEN** 正文被截断并带可见截断标记，回合仍创建，SHALL NOT 因超长而丢消息

