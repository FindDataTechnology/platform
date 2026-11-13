# platform-memory-observability — Delta

## MODIFIED Requirements

### Requirement: 内存准入闸与 fail-open

新 cell 驻留（provision）SHALL 在准入检查中查容器内存余量：余量比例低于阈值时 SHALL 拒绝驻留并透出可读原因（当前用量、limit、余量、阈值）；阈值 SHALL 可配（env，缺省保守值）。parked cell 唤醒（park-resume）SHALL 以**投影水位**准入：投影 = 当下用量 + 该 cell 的 last-known 驻留足迹（其上次完整驻留期的 cgroup 实扣合计，park 时点落档）；投影余量比例低于阈值时 SHALL 先驱逐闲置驻留 cell（`last_user_traffic_at` 距今超过现役 reap 阈值者，按闲置时长降序逐个驱逐、逐个复投影，复用既有 park 原语、状态落盘），驱逐后投影达标 SHALL 放行，候选耗尽仍超限 SHALL 拒绝驻留并透出可读原因（含投影值、足迹值、已驱逐清单），拒绝发生在任何进程物化之前。被驱逐者 MUST 仅限闲置驻留——活跃驻留 cell（`last_user_traffic_at` 在 reap 阈值内）MUST NOT 被本闸驱逐。计量缺失、读值异常、足迹档案缺失或陈旧超限时 SHALL fail-open——放行并告警，与既有 carrier 准入闸的降级纪律同构；足迹档案缺失时 SHALL 降级为只看当下用量（现行为）。拒绝与驱逐证据 SHALL 落 durable registry（沿 `last_gate_refusal_json` 扩展投影/足迹/驱逐清单字段）。

#### Scenario: 余量充足放行

- **WHEN** 容器内存余量高于阈值时一个新 cell 请求驻留
- **THEN** 驻留照常发生，行为与本闸未引入前一致

#### Scenario: 余量低于阈值拒绝并给原因

- **WHEN** 容器内存余量低于阈值时一个新 cell 请求驻留
- **THEN** 驻留被拒，响应/事件携带当前用量、limit、余量与阈值的可读原因

#### Scenario: 唤醒投影充足放行

- **WHEN** 一个有足迹档案的 parked cell 被唤醒，当下用量加其足迹后的投影余量高于阈值
- **THEN** 唤醒照常物化，行为与投影判定引入前一致

#### Scenario: 唤醒投影不足先驱逐闲置驻留

- **WHEN** 唤醒投影余量低于阈值，且存在闲置超过 reap 阈值的 running cell
- **THEN** 闲置最久者被驱逐（park、状态落盘），每驱逐一个复投影一次，投影达标即停止驱逐并放行唤醒，驱逐清单可读

#### Scenario: 驱逐后仍不足则拒绝于物化之前

- **WHEN** 唤醒投影余量低于阈值，且所有 running cell 均为活跃（或驱逐候选耗尽后投影仍超限）
- **THEN** 唤醒被拒绝，被唤醒 cell 保持 parked，事件携带投影值、足迹值、阈值与已驱逐清单，且无任何该 cell 进程被物化

#### Scenario: 活跃驻留不被驱逐

- **WHEN** 唤醒投影不足，但全部 running cell 的 `last_user_traffic_at` 均在 reap 阈值内
- **THEN** 不发生任何驱逐，唤醒直接走拒绝路径

#### Scenario: 足迹档案缺失降级为现行为

- **WHEN** 被唤醒 cell 无足迹档案（上产后首唤醒，或 park 于本机制上产前）
- **THEN** 准入降级为只看当下用量的现行判定，放行照常、无告警刷屏，行为与投影机制引入前一致

#### Scenario: 计量缺失 fail-open

- **WHEN** cgroup 或 /proc 计量不可读（路径缺失、值异常）
- **THEN** 驻留放行，系统告警记录计量缺失，不得因计量故障阻断业务

#### Scenario: 计量异常 fail-open

- **WHEN** 内存采样失败、读值异常或缓存陈旧超限时任一驻留请求到达
- **THEN** 请求放行并产生告警，无请求因数据质量被拒
