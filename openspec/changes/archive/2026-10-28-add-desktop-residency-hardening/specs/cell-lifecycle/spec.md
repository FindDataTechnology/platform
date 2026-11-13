# cell-lifecycle Specification Delta

## ADDED Requirements

### Requirement: 常驻恢复后的簇收敛

steward 被唤醒（开机登录、睡眠恢复、更新后重启、显式启动）拉起运行时栈时，
本地集群 SHALL 收敛到声明态：插件启用位与本机 feed 令牌来自 settings（幂等
铸造，缺失补铸不重置）；本地部署以部署表为真源——feed 声明即期望，runner 按
既有分片纪律领回，部署表中 enabled 的条目 SHALL 恢复运行时，已停用条目 SHALL
保持摘除，已卸载 pack 的孤儿记录 SHALL 被剔除。收敛 SHALL NOT 因外部网络不可达
而失败（feed 与运行时不依赖公网）；无可部署条目时 SHALL 呈现空编目的健康态
而非未健康。收敛结果 SHALL 在状态面可见（领回几条、剔除几条）。

#### Scenario: 重启后集群自行回来

- **WHEN** 用户在装有本地部署的机器上重启并登录（原 UI 未打开）
- **THEN** steward 拉起栈，enabled 部署全部恢复运行时，状态面报出领回计数

#### Scenario: 睡眠唤醒后收敛

- **WHEN** 机器睡眠期间部署表被外部修改（如 CLI 停用一个条目）后唤醒/登录
- **THEN** 收敛按最新声明执行：停用条目运行时排空、feed 摘除，状态面如实报告

#### Scenario: 断网不影响本地集群收敛

- **WHEN** 恢复时公网不可达但本地部署非空
- **THEN** 本地 feed 与运行时照常拉起（收敛不依赖公网），仅需要公网的旁路（如云席位桥）呈降级

#### Scenario: 空部署是健康态

- **WHEN** 恢复时部署表为空
- **THEN** 集群呈 `0` 数量的健康态，不显示为未健康、不触发崩溃环计数
