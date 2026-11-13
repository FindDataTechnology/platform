## ADDED Requirements

### Requirement: A turn that produces no assistant output settles as a failed turn

采集器 SHALL 把「会话转 idle 且本回合未收集到任何 assistant 文本」的回合按**失败回合**结算：child.turn 以结构化错误拒绝（错误码 -32005，消息言明回合无任何输出），而非以空文本成功返回。该语义 SHALL 对全部回合来源一致生效（A2A message、rhythm self-turn、rollover digest）。由此，计量行 SHALL 记 `ok:false`、turn_ended 事件 SHALL 带 `outcome:"error"`、A2A 面 SHALL 返回 JSON-RPC error（send）/`event: error`（stream）——下游计费按既有 outcome 语义自动免单。产生过文本的回合（含其后再次转入 idle）SHALL 维持既有成功结算，行为不变。

判定 SHALL 以「assistant 文本」为准（trim 后为空即零输出）；usage 缺席 SHALL NOT 作为判定输入（本 dsh 版本 usage 恒缺席——生产 700/700 ok:true 行 tokens:null 实证）。

#### Scenario: 零输出 idle 回合按失败结算并免单

- **WHEN** 一回合内 dsh 未产生任何 assistant 文本便会话转入 idle（如模型解析失败的静默空返）
- **THEN** child.turn 以 code -32005 拒绝；计量行记 ok:false；turn_ended outcome=error；A2A message/send 返回 JSON-RPC error（HTTP 200）；facade 判 outcome:error → waived 零计费

#### Scenario: 正常回合行为不变

- **WHEN** 一回合产生 assistant 文本后转入 idle
- **THEN** 成功结算、计量 ok:true、A2A 返回既有 result 形状——与升级前不可区分

#### Scenario: 自报失败的 LLM 回合维持既有错误码

- **WHEN** 一回合以 finish chunk reason.kind=error 结束（上游 5xx/429 已自报）
- **THEN** 维持既有 -32003 结算路径（与零输出 -32005 区分归因），计量/免单语义同上

#### Scenario: 全部回合来源同纪律

- **WHEN** rhythm self-turn 或 rollover digest 零输出转入 idle
- **THEN** 同按 -32005 失败结算；scheduler 既有错误处理吞下（不楔死节奏循环）
