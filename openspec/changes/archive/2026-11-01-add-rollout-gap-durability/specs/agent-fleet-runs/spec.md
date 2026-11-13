## ADDED Requirements

### Requirement: 打断回合的容差补拍

启动清扫 SHALL 把被进程终止打断的 open run（sweepOpenRuns 判定孤儿）按停机补拍的同一容差规则
处置：该 run 对应岗位节拍在容差窗内（2× 周期、地板 6h，`PLATFORM_CRON_CATCHUP=0` 杀开关沿用）
SHALL 补一拍（一次 make-up run，与既有停机补拍同源合流，不双发）；窗外 SHALL 如实记 missed
不补。补拍与不补拍 SHALL 都留可观测痕迹（makeup 标记/missed 记账），不得静默。

#### Scenario: 容差窗内打断补一拍

- **WHEN** 一次滚版打断某岗位在途回合，该节拍距其计划触发的偏移仍在容差窗内
- **THEN** 启动清扫后该岗位补跑一拍（makeup 标记在案），该节拍不因滚版丢失

#### Scenario: 窗外打断如实不补

- **WHEN** 被打断节拍的偏移已超出容差窗（或杀开关关闭）
- **THEN** 该节拍记 missed 不补跑，痕迹与既有停机补拍的窗外行为一致
