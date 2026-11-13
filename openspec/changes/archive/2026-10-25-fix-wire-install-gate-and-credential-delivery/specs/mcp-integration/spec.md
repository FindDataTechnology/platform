# mcp-integration Delta

## ADDED Requirements

### Requirement: 凭据形 patch 变化的一切交付路径同受交付控制器管辖

当一次 patch 写入因快照不可比（首装、ref 携带服务从无到有、patch 从无到有）而落入
非热交换的兜底 restart 路径时，平台 SHALL 以凭据交付控制器执行该 restart——碰撞
（restart already in progress）SHALL 重试而非向上抛出后吞掉；有回合在跑 SHALL 推迟到
回合边界并受硬顶约束。平台 SHALL NOT 在任何凭据可变化的 patch 交付路径上裸调 restart
后以 catch 吞异常（生产 2026-10-24 两次「重启 platform 才生效」的事故形态）。凭据行
「从无到有」落库（此前该用户该线无行）SHALL 记一条审计事件（credential line created，
含用户、线、时间戳）——该事件不承载密钥材料。

#### Scenario: 首行凭据在运行中的 cell 五分钟内可见

- WHEN 一个运行中的 cell（子进程已启动、此前无任何线凭据）的属主在浏览器完成首次
  铸币，且平台不重启
- THEN 交付在 5 分钟内完成（空闲立即、忙则回合边界），此后起的回合经工具发现可见
  对应线服务

#### Scenario: 兜底 restart 碰撞被重试

- WHEN 兜底路径的 restart 撞上一次进行中的 restart
- THEN 按控制器的重试节奏重试并最终交付，日志留有碰撞与重试痕迹，而非静默丢失

#### Scenario: 首行落库有审计事件

- WHEN 某用户某线的凭据行从无到有落库
- THEN 平台日志出现一条 credential line created 事件（用户/线/时间），不含 token 材料

#### Scenario: 非凭据变化维持既有交付语义

- WHEN patch 写入只是 server 增删/启停且 Authorization 头值不变、快照可比
- THEN 交付语义与本 change 之前完全一致（热交换或既有 restart 路径）
