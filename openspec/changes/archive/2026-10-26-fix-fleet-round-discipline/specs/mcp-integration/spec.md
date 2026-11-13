# mcp-integration Delta

## MODIFIED Requirements

### Requirement: 凭据形 patch 变化的一切交付路径同受交付控制器管辖

当一次 patch 写入因快照不可比（首装、ref 携带服务从无到有、patch 从无到有）而落入
非热交换的兜底 restart 路径时，平台 SHALL 以凭据交付控制器执行该 restart——碰撞
（restart already in progress）SHALL 重试而非向上抛出后吞掉；有回合在跑 SHALL 推迟到
回合边界并受硬顶约束。**「有回合在跑」的判定 SHALL 覆盖共享运行时子进程上的一切在途回合**：
web 活回合与经收集器注册的非 web 回合（定时任务、委托、bot 中继）同权——判定 MUST NOT
只看 web 活回合（生产 2026-10-24 深夜：舰队巡逻回合流式中凭据变更被误判空闲、子进程立即
重启致回合中断，9 连败中至少 3 次死于此）。**硬顶 SHALL 不小于共享子进程上最长的单回合
预算**（默认回合超时 10 分钟）：一次合法在途回合（未逾自身回合预算）SHALL NOT 被硬顶强推
打断；等待超过硬顶且此刻无在途回合时照常交付；在途回合期唯一的强推是楔死释放——
回合已逾其自身预算仍未终止时，凭据不得被无限期扣押（强推并留警告日志，被打断的
回合可重跑）。平台 SHALL NOT 在任何凭据可
变化的 patch 交付路径上裸调 restart 后以 catch 吞异常（生产 2026-10-24 两次「重启
platform 才生效」的事故形态）；**hot-swap 关闭或空 patch 等其余兜底 restart 路径 SHALL
同样经由控制器交付，不得绕过忙判定**。凭据行「从无到有」落库（此前该用户该线无行）SHALL
记一条审计事件（credential line created，含用户、线、时间戳）——该事件不承载密钥材料。

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

#### Scenario: 舰队回合流式中凭据变更不打断回合

- WHEN 一个舰队成员的巡逻回合正在共享子进程上流式执行，期间一次线上 token 重铸落库
  触发凭据形 patch 写入
- THEN 交付被判忙推迟（日志留 deferred 痕迹），巡逻回合完整跑完不中断
- AND restart 落在该回合终止后的最近回合边界（下一回合 pre-round 排空或排空 poller）

#### Scenario: 硬顶不吞合法长回合

- WHEN 凭据交付在某个回合开始时被判忙推迟，该回合按默认预算跑满 10 分钟
- THEN 整个回合期间不发生 restart；硬顶在该回合自行终止前不触发

#### Scenario: 非凭据兜底路径同受管辖

- WHEN hot-swap 关闭（或 patch 无服务器条目）使 profile 变更落到 restart 兜底，且此刻
  共享子进程上有在途回合
- THEN 该 restart 同样推迟到回合边界，而非立即执行
