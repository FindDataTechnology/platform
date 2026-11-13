## ADDED Requirements

### Requirement: facade/智语消费同一 digest 读缝

facade 与智语类对客聊天面（网站嵌入、客户房间）SHALL 复用与壹座主聊天同源的 digest 读缝：按会话归属的 owner 读取 digest 注入回合 prompt，同一三档降级与 warn 纪律，任何记忆读面失败不得阻塞回合；游客会话不得获得其 owner 记忆注入，登入住户按本人根生效；tier/tag 语义与 fd-memory digest 对齐（引用名份不拖正文）。

#### Scenario: 万星网站客服位的登入用户接到记忆

- **WHEN** 登入用户在 facade 页开始会话并发送消息
- **THEN** 其本人 owner 记忆以 digest 拼入 prompt，canonical reference 名份可入
- **AND** 该 user 退出后以游客身份接续时，prompt 不再含 owner 记忆

#### Scenario: 记忆读面超时

- **WHEN** digest 召唤超过时限
- **THEN** 回合按降级档照旧发出的 prompt，日志记 warn 一条
