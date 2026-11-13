# chat-composer-controls — Delta

## ADDED Requirements

### Requirement: Web search toggle chip on the control strip

控制条 SHALL 提供会话级「联网搜索」开关芯片，默认关。开关 SHALL 经服务端 `tools/set` 路径即时生效（免重启），翻转后芯片 SHALL 反映该会话的当前状态；桥未声明 `tools/set` 能力时 SHALL 不渲染该芯片（而非渲染一个不可用开关）。

#### Scenario: 默认关闭

- **WHEN** 用户开启新会话
- **THEN** 联网搜索开关 SHALL 呈关闭态，该会话的 websearch 工具被闸

#### Scenario: 翻开即时生效

- **WHEN** 用户在流外翻开开关
- **THEN** 该会话后续回合 SHALL 可调用 websearch 工具，无重启、无禁发窗

#### Scenario: 无能力不渲染

- **WHEN** 桥能力声明不含 `tools/set`
- **THEN** 控制条 SHALL 不渲染联网开关芯片
