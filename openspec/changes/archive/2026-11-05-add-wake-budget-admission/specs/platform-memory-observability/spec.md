# platform-memory-observability — Delta

## MODIFIED Requirements

### Requirement: 内存准入闸与 fail-open

新 cell 驻留（provision）SHALL 在准入检查中查容器内存余量：余量比例低于阈值时 SHALL 拒绝驻留并透出可读原因（当前用量、limit、余量、阈值）；阈值 SHALL 可配（env，缺省保守值）。parked cell 唤醒（park-resume）SHALL 以**投影水位**准入：投影 = 当下用量 + **在途唤醒预约合计（含本唤醒自身）** + 该 cell 的驻留足迹；驻留足迹取其 last-known 档案（上次完整驻留期的 cgroup 实扣合计，park 时点落档），**无档案时按保守默认足迹记账**（env `CELL_WAKE_DEFAULT_FOOTPRINT_MB`，SHALL 可配、缺省保守值），该 cell 首次 graceful park 落档后 SHALL 回归档案值。每一笔驻留准入（provision 与唤醒同式）SHALL 在判定前把自身贡献估计（档案足迹或默认足迹）登记为在途预约、在判定结束（放行、拒绝或异常）后 SHALL 释放，使同一采样窗内的并发唤醒互相可见：各唤醒基于含他人在途预约的投影判定，而非共享同一份彼此外的当下水位。投影余量比例低于阈值时 SHALL 先驱逐闲置驻留 cell（`last_user_traffic_at` 距今超过现役 reap 阈值者，按闲置时长降序逐个驱逐、逐个复投影，复用既有 park 原语、状态落盘；复投影时其他唤醒的在途预约 SHALL 照记），驱逐后投影达标 SHALL 放行，候选耗尽仍超限 SHALL 拒绝驻留并透出可读原因（含投影值、足迹值、预约合计、已驱逐清单），拒绝发生在任何进程物化之前。被驱逐者 MUST 仅限闲置驻留——活跃驻留 cell（`last_user_traffic_at` 在 reap 阈值内）MUST NOT 被本闸驱逐。计量缺失、读值异常或陈旧超限时 SHALL fail-open——放行并告警，与既有 carrier 准入闸的降级纪律同构，fail-open 放行时本唤醒的在途预约 SHALL 同步释放；闸整体关闭（阈值未设或 ≤0）时 SHALL 逐字节等价于无闸行为。拒绝与驱逐证据 SHALL 落 durable registry（沿 `last_gate_refusal_json` 扩展投影/足迹/预约合计/驱逐清单字段）。

#### Scenario: 余量充足放行

- **WHEN** 容器内存余量高于阈值时一个新 cell 请求驻留
- **THEN** 驻留照常发生，行为与本闸未引入前一致

#### Scenario: 余量低于阈值拒绝并给原因

- **WHEN** 容器内存余量低于阈值时一个新 cell 请求驻留
- **THEN** 驻留被拒，响应/事件携带当前用量、limit、余量与阈值的可读原因

#### Scenario: 唤醒投影充足放行

- **WHEN** 一个有足迹档案的 parked cell 被唤醒，当下用量加其在途预约与足迹后的投影余量高于阈值
- **THEN** 唤醒照常物化，行为与投影判定引入前一致

#### Scenario: 并发唤醒互相记账

- **WHEN** 两个唤醒落在同一采样窗内，各自单独投影均低于阈值、但两者预约合计投影超限
- **THEN** 后到者在任何进程物化之前被拒（或走驱逐链），证据携带预约合计；未被同时物化冲破 cgroup limit

#### Scenario: 预约随判定结束释放

- **WHEN** 任一唤醒判定结束（放行后物化完成或失败、拒绝、异常）
- **THEN** 其在途预约被释放，后续唤醒的投影不再计入该笔预约

#### Scenario: 唤醒投影不足先驱逐闲置驻留

- **WHEN** 唤醒投影余量低于阈值，且存在闲置超过 reap 阈值的 running cell
- **THEN** 闲置最久者被驱逐（park、状态落盘），每驱逐一个复投影一次（含他人在途预约），投影达标即停止驱逐并放行唤醒，驱逐清单可读

#### Scenario: 驱逐后仍不足则拒绝于物化之前

- **WHEN** 唤醒投影余量低于阈值，且所有 running cell 均为活跃（或驱逐候选耗尽后投影仍超限）
- **THEN** 唤醒被拒绝，被唤醒 cell 保持 parked，事件携带投影值、足迹值、阈值与已驱逐清单，且无任何该 cell 进程被物化

#### Scenario: 活跃驻留不被驱逐

- **WHEN** 唤醒投影不足，但全部 running cell 的 `last_user_traffic_at` 均在 reap 阈值内
- **THEN** 不发生任何驱逐，唤醒直接走拒绝路径

#### Scenario: 无足迹档案按保守默认足迹记账

- **WHEN** 被唤醒或新驻留 cell 无足迹档案（首次驻留、上产后首唤醒、或 park 于硬杀无 exit handler）
- **THEN** 其自身贡献按 env 配置的保守默认足迹计入投影与在途预约（不再以零增量参与并发记账）；该 cell 首次 graceful park 落档后，后续唤醒回归档案值

#### Scenario: 足迹档案缺失降级为现行为

- **WHEN** 被唤醒或新驻留 cell 无足迹档案，且默认足迹被显式禁用（`CELL_WAKE_DEFAULT_FOOTPRINT_MB` 置 0）
- **THEN** 准入降级为只看当下用量的现行判定（本唤醒零贡献记账，他人在途预约照记），放行照常、无告警刷屏

#### Scenario: 计量缺失 fail-open

- **WHEN** cgroup 或 /proc 计量不可读（路径缺失、值异常）
- **THEN** 驻留放行，系统告警记录计量缺失，不得因计量故障阻断业务，且本唤醒的在途预约同步释放

#### Scenario: 计量异常 fail-open

- **WHEN** 内存采样失败、读值异常或缓存陈旧超限时任一驻留请求到达
- **THEN** 请求放行并产生告警，无请求因数据质量被拒，在途预约不留残留

#### Scenario: 闸关闭逐字节等价

- **WHEN** 阈值未配置或 ≤0（闸 inert）
- **THEN** 驻留行为与本机制未引入前逐字节一致，无预约登记与释放开销
