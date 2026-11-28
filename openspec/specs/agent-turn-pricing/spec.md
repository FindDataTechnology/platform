## Purpose

回合计费的估算与对账面：模型单价从词元（唯一计费真源）的管理门读取、进程内缓存、按回合时刻
价折算进日汇总的估算列，并与词元的真实计费数（`today_actual_cost`）对账——估算帮助优化决策，
永不冒充账单。

## Requirements

### Requirement: 模型价目经词元管理门读取并进程内缓存

平台 SHALL 经词元管理 API（ADR-0011 唯一门）读取模型单价（input/output/cache_write/cache_read，
per-token）并维护进程内价目表缓存：周期刷新（默认 10 分钟，部署可配）+ 未命中模型异步补拉；
缓存 SHALL 携带抓取时刻 `pricing_at`（价目版本戳）。词元不可达时 SHALL 降级 last-good 缓存；
从未取得过价目或价目未含该模型的回合 SHALL 记 `pricing_at=NULL` 且不产生估算成本（诚实空缺，
MUST NOT 以 0 价或猜测价冒充观测）。价目读取失败 MUST NOT 阻塞回合。

#### Scenario: 有价模型按时价估算

- **WHEN** 一个回合的模型在价目表内且词元可达
- **THEN** 该回合事件行 `pricing_at` 记所用价目表的抓取时刻，日汇总估算列按该回合的单价折算

#### Scenario: 词元不可达降级 last-good

- **WHEN** 周期刷新失败
- **THEN** 缓存保留 last-good 继续服务，新回合估算按 last-good 单价并如实带其 pricing_at
- **AND** 从未取得过价目时估算列 NULL，不写 0

#### Scenario: 无价模型诚实空缺

- **WHEN** 回合模型不在价目表内（自定义渠道等）
- **THEN** 该回合 `pricing_at=NULL`、估算成本 NULL；对账因子把该缺口显式化（有价样本口径）

### Requirement: 日汇总按回合时刻价累积估算成本列

日汇总表 SHALL 加估算成本列（input/output/cache_write/cache_read 四分量，USD，REAL），每条带
价回合以其**回合时刻单价**折算并同缝累加进对应日行——价目在一天内变更时历史回合不按新价重算。
turn 行 SHALL 只记 `pricing_at` 戳不记钱（D4a：估算永不混进计费数字；逐回合钱在日行，真数在
词元）。估算列 SHALL 只累计「取得过价目」的回合，聚合读面以有价样本口径呈现。

#### Scenario: 价目天内变更不误归因

- **WHEN** 价目表在一天内更新（单价变化）
- **THEN** 已落的历史回合日行保持其回合时刻价的贡献，仅新回合按新价累积

#### Scenario: 估算列只含有价样本

- **WHEN** 同一天内部分回合有价、部分回合无价（pricing_at=NULL）
- **THEN** 日行估算列只累积有价回合的贡献，turns 计数含全部回合——有价样本口径可从
  (pricing_at 非空样本) 与 turns 的差读出

### Requirement: 估算与词元计费真数对账且不自动校准

系统 SHALL 提供对账面（运维脚本，pod 内可运行）：取该 owner 的平台日汇总估算合计（有价样本）
对比词元计费真数（`today_actual_cost`，ADR-0011 门读取），输出漂移因子（估算/真数）与两侧
样本说明；漂移超过告警线（默认 30%）SHALL 以可观测方式呈现（日志/输出明示）。对账面 SHALL
NOT 自动修改任何价目、倍率或账面——校准是人的决策，因子只是证据。

#### Scenario: 对账输出漂移因子

- **WHEN** 运维运行对账脚本（指定 owner 与当日）
- **THEN** 输出平台估算合计、词元真数、漂移因子（估算/真数）与样本口径说明

#### Scenario: 漂移超线可见

- **WHEN** 漂移因子超出告警线
- **THEN** 输出明示超线与因子值；不自动改价、不自动记账
