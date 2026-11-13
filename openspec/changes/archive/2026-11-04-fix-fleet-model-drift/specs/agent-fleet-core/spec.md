## ADDED Requirements

### Requirement: 显式链岗位每阵强制模型断言

post 声明了显式链（model/fallbackModel 任一非空）时，回合起点 SHALL 无条件重新断言 runtime 默认模型——不复用 `ctx.session.model.id === target` 早退，以免与被外源改写过的 child 选择漂移重合。断言实现 SHALL 引擎会重启（initialize）或 live 切换（有 model/set RPC 时），两者都必须向 child 显式写入目标模型。**无显式链的岗位（cron/preset 默认）沿用既有早退优化**，不向 runtime 写任何模型。

#### Scenario: 显式链岗位遭受外源漂移后住院

- **WHEN** post 声明了 deepseek-v4.1-flash 链，而 child 会话被其他车道写入过 qwen3.8-flash
- **THEN** 下一阵 normalizeModelForJob 强制重新断言 deepseek，回合请求头 model 恢复 deepseek

#### Scenario: 无显式链岗位不开销

- **WHEN** 一个 cron-only 岗位无 model/fallbackModel 声明
- **THEN** 回合起点不作任何模型断言，沿用之前 child 状态

### Requirement: memberTurnEvents detail 增 modelMismatch 事实列

当请求头模型与岗位决议模型不一致时，该阵的 member_turn_events.detail SHALL 记录 `modelMismatch: { declared, resolved, observedHeader }`；一致时不得写入。该列 SHALL 是观测来源（不可推断），以便 veracity/运维可直接判读。

#### Scenario: 模型不一致被钉下一行脚注

- **WHEN** 某阵 runtime 实际发出 model=qwen 但链声明 deepseek
- **THEN** 该阵 detail.modelMismatch.model 分别为 declared=deepseek 与 observedHeader=qwen，运维能与 error 联合定性「漂移」

### Requirement: 模型不可用失败触发自愈重断言

当回合归因为上游模型拒绝（HTTP 400 `model_not_available` / `INVALID_MODEL` / `cannot find model`）且岗位存在显式链，cron-runner SHALL 在原中途尝试完成后追加**一次强制重断言重新 spawn + 重走整条链一次**；若一次就 recover，结局记 ok 且 detail.modelRectified=true；若重走仍败才按现口径记 failed。

#### Scenario: 中毒态一键自愈

- **WHEN** 上一阵外源写过 qwen，使本阵首次以 qwen 拿到 400 model_not_available
- **THEN** 引擎强制 reinitialize 到声明模型重跑一次，结局 ok 并在 detail 注明自愈事实
