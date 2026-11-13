## ADDED Requirements

### Requirement: 词元的非 chat 模型能力含嵌入且与 chat 入口同源

萬星·词元的非 chat 模型能力 SHALL 含嵌入（embedding）。嵌入经 OpenAI 兼容
`/v1/embeddings` 入口暴露，与 chat 入口同源（经 chat 网关族的鉴权、调度与账本
链路），而非 rerank/audio/websearch 三车道的 LaneAdapter 链路；其专属契约
（模型与维度、上游池、价目、上游钉扎）由 capability `ciyuan-embedding-lane`
规定，本 capability 不重复规定。

#### Scenario: 嵌入入口与 chat 同源

- **WHEN** 调用方请求 `POST /v1/embeddings`
- **THEN** 该请求经 chat 网关族的鉴权、调度与账本链路处理，而非三车道的
  LaneAdapter 链路

#### Scenario: 嵌入用量入既有账本

- **WHEN** 嵌入请求成功计费
- **THEN** 用量进入与 chat 同一账本体系（key 消费窗口、余额、用量面板），
  计费单位按 token（而非三车道的按次/按时长/按字符）

#### Scenario: 三车道既有契约不受嵌入影响

- **WHEN** 嵌入能力上线
- **THEN** rerank / audio / websearch 三车道的协议形状、计量单位与账本归属
  保持不变，本 capability 的既有需求与 Scenario 不需重新验收
