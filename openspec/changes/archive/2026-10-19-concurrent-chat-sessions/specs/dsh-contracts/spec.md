## MODIFIED Requirements

### Requirement: 活控制合同钉住 model/set、session/cancel 与多会话并发

套件 SHALL 新增活控制合同（在既有六条之外独立执行、独立报告）：

7. **模型活切**：`model/set` 在空闲与流中均可调用；切换后该会话的下一个模型请求按新 provider/model 路由（agent/request 瀑布请求粒度生效），子进程不重启；未知 provider 拒绝；
8. **真取消**：`session/cancel` 中断活跃回合并收敛 idle（agent.cancel + whenIdle），取消后的会话可立即接受新 prompt；
9. **多会话派发并发**：一会话回合在途时，另一会话的 prompt 不被拒绝、其请求正常派发并驱动自身回合（各自独立的 session.status 流）。（rc.2 已知限制：**并发打开的回合其收尾不保证收敛**——即使挂起请求解除，仍可能非确定地卡在 running；取消（⑧）是可靠的解卡手段。平台宿主因此以派发器强制共享子进程同一时刻最多一个开着的 web 回合（`turn-dispatch` 的 `queue` 策略），不消费自然收尾交错。）
9b. **收尾交错（advisory）**：在 ⑨ 的布置上释放挂起请求后不发任何取消，A、B 两会话 SHALL 在界内（20s）均收敛到 idle。本条 SHALL 作为 **advisory 行**执行与报告：照常打印 PASS/FAIL 与 detail，但 SHALL NOT 计入失败数、SHALL NOT 影响套件 exit code，摘要末尾 SHALL 单列 advisory 结果。它是 `turn-dispatch` 的 `concurrent` 策略的开启条件：候选矩阵 ⑨b 绿 → 可立 dsh 升级 change 翻转默认策略并把 ⑨b 升格为门禁；红 → `queue` 策略即终态。

⑦⑧⑨ 均基于 dsh-agent 公开导出面（非 internal-API 标签），但 SHALL 与六合同同流程：候选 rc 任一条 fail 即按 ADR-0007 不跟版或归因决策。

#### Scenario: 合同⑦捕获快照语义破坏

- **WHEN** 候选版本使流中 model/set 撕裂当前请求（当前请求被中途换模型或报错）
- **THEN** 合同⑦ fail 并指名 model/set

#### Scenario: 合同⑧捕获取消不收敛

- **WHEN** 候选版本使 session/cancel 后会话不回 idle 或后续 prompt 被挂起
- **THEN** 合同⑧ fail 并指名 session/cancel

#### Scenario: 合同⑨捕获会话串扰

- **WHEN** 候选版本使 A 会话在途时 B 会话的 prompt 被拒绝或不派发
- **THEN** 合同⑨ fail 并指名多会话派发并发

#### Scenario: 合同⑨b 在冻结矩阵上红而不翻总判定

- **WHEN** 对冻结矩阵（0.2.0-rc.2）运行套件
- **THEN** ⑨b SHALL 报 FAIL 并指出哪一会话未收敛
- **AND** 套件总判定与 exit code SHALL 与 ⑨b 无关（其余全绿则 exit 0）

#### Scenario: 合同⑨b 绿是并发策略的开启证据

- **WHEN** 候选 dsh 树上 ⑨b 报 PASS
- **THEN** 该结果 SHALL 被记录为该候选支持回合收尾交错，供 dsh 升级 change 决定翻转 `TURN_DISPATCH` 默认值
