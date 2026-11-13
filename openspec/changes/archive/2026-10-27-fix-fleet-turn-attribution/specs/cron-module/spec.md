# cron-module Delta

## ADDED Requirements

### Requirement: 模型车道按身份键控熔断与降级重试

模型车道 SHALL 以**车道身份**为熔断与降级的判定单元:车道 id SHALL 由该车道实际使用的 provider 派生(`providerId|baseURL|凭据指纹` 的哈希前缀,MUST NOT 含明文密钥)。当日 cell 内全部模型解析到同一 provider 时,行为自然退化为 cell 级;未来 per-agent/per-岗位 车道配置落地时,各车道 SHALL 自动获得独立熔断,本机制 MUST NOT 因车道拓扑变化而需要语义迁移。

熔断 SHALL 采用滑动窗:窗口内(默认 10 分钟,可配)该车道模型上游失败达阈值(默认 5 次,可配)即开窗一段冷却期(默认 10 分钟,可配),并提供总闸(默认开)。开窗期内触发的舰队成员回合 SHALL 被**跳过**而非失败——记 skipped 回合事件、不消耗模型预算、不计入岗位连续失败;在岗派生照常推进。窗口内出现成功调用 SHALL 立即关闭熔断(半开探测即成功)。被跳过与熔断状态 SHALL 在管理面可见(车道 id、开窗截止时刻、窗口内失败数)。

上游失败(5xx/连接类,快速失败)时,若该岗位模型解析链存在未试候选,SHALL 以下一候选模型**重试一次**(同回合内),并在回合 detail 记 `degradedTo`;重试仅限上游类失败且回合启动未超过短窗(默认 60 秒)——超时与工具类失败 SHALL NOT 触发重试。链上全部候选耗尽 SHALL 如实失败。

#### Scenario: 单车道退化为 cell 级

- **WHEN** cell 内全部岗位解析到同一 provider 且 10 分钟内该 provider 连续 5 次上游 5xx
- **THEN** 该车道熔断开窗,后续节奏回合被跳过并记 skipped,窗口结束后下一回合正常执行

#### Scenario: 多车道各自独立

- **WHEN** 两个岗位分别配置不同 provider(key/baseURL 各异),车道 A 上游持续 5xx 而车道 B 正常
- **THEN** 仅车道 A 熔断;车道 B 的岗位回合照常执行,互不影响

#### Scenario: 成功即关闸

- **WHEN** 熔断开窗冷却结束后的第一个回合成功
- **THEN** 熔断关闭,计数清零

#### Scenario: 明文密钥不落日志

- **WHEN** 任意车道事件与熔断日志输出
- **THEN** 只出现车道 id 哈希前缀与 baseURL,不出现 key 材料

#### Scenario: 降级重试一次

- **WHEN** 岗位声明模型链 [A, B],回合以 A 启动后 20 秒收到上游 502
- **THEN** 本回合换 B 重试一次并继续完成;detail.degradedTo=B;若 B 也失败则回合如实失败

#### Scenario: 超时不触发重试

- **WHEN** 某回合因预算超时结束(非上游快速失败)
- **THEN** 不发生模型重试,回合按既有超时语义记 failed + detail 归因
