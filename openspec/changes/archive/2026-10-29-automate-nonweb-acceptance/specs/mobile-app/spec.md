# mobile-app delta — automate-nonweb-acceptance

## ADDED Requirements

### Requirement: 聊天内图表围栏渲染（echarts）

移动端 Markdown 渲染器 SHALL 把 `echarts` 语言围栏的内容按 JSON 解析并渲染为图表组件，与 web 端聊天图表的语义一致；解析失败、内容非对象、或流式未闭合的围栏 SHALL 回落为代码块渲染（不出现空白或崩溃）。其余语言围栏保持代码块。

#### Scenario: 合法 echarts 围栏渲染为图表
- **WHEN** assistant 消息包含内容为合法 echarts option 对象的 `echarts` 围栏
- **THEN** 该围栏 SHALL 渲染为图表组件，且同一围栏 SHALL NOT 同时渲染为代码块

#### Scenario: 非法内容回落代码块
- **WHEN** `echarts` 围栏内容不是合法 JSON 或不是对象
- **THEN** 渲染 SHALL 回落为代码块，消息其余部分照常渲染

#### Scenario: 流式未闭合围栏不炸
- **WHEN** 消息以未闭合的 ``` 围栏结尾（流式中）
- **THEN** 尾部内容 SHALL 按代码块渲染且不抛错，后续增量到达后按终态重渲染

### Requirement: 图表落定状态原生可断言

图表组件 SHALL 把自身落定状态暴露为可被端到端脚本读取的原生标识：加载中 / 渲染成功 / 回落代码块三态互斥。渲染成功（图表库完成 setOption）时 SHALL 进入成功态并保持；渲染失败或确认超时 SHALL 进入回落态并展示原始 option 文本。

#### Scenario: 成功态可断言
- **WHEN** 图表在设备上完成渲染
- **THEN** 组件 SHALL 暴露「成功」状态标识，且「回落」标识 SHALL 不存在

#### Scenario: 回落态可断言
- **WHEN** 图表库不可达或 setOption 抛错
- **THEN** 组件 SHALL 在确认窗口内进入「回落」状态标识并渲染原始 option 文本