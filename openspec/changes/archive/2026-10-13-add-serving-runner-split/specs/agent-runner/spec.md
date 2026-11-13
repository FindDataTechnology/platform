## ADDED Requirements

### Requirement: The serving lane runs on a dedicated deployment with its own memory envelope

Serving 回合执行面（托管市场部署 agent 的 runner）必须是独立管理的部署单元：自己的内存包络（不与 registry 宿主机的其他负载、也不与用户会话平面同 cgroup）、声明式生命周期（GitOps 管理、镜像可滚）、且与任务车道 runner 不同故障域。常驻预算与包络对齐（预算 ≤ 容器上限减 runner 基座），并发上限按 M2 实测的单 child 足迹（≈540-600MB 含 sidecar）推算，不以 500-agent 注册闸门为约束。

#### Scenario: 独立部署承载存量条目
- **WHEN** serving runner 从裸容器形态迁入独立 Deployment（专用节点、hostNetwork、hostPath 数据根）且旧容器停止
- **THEN** 既有 fleet-scheduler 接管机制在旧 runner 心跳过期后自动把其条目（打标与未打标默认）改点到新 runner，新 runner 在下一个 poll 周期内冷重建并恢复 A2A 服务；改点目标由面板预算余量排序决定，新 runner（最大余量）承接全部条目。

#### Scenario: 切换期不发生双宿主
- **WHEN** 新旧 runner 并存（切换窗口内，registry 条目 URL 仍指旧 runner）
- **THEN** 新 runner 以「默认 runner 指向旧 runner」的配置惰性启动——它只物化显式打给自己标签的条目（初始为零），不为未打标条目 spawn child；旧 runner 死亡、条目被改点打上新标签后，新 runner 才开始托管。

#### Scenario: 切换后 fleet 默认行指向新 runner
- **WHEN** 接管波完成（无条目再挂在旧 runner 的行/标签下）
- **THEN** fleet 表删除旧 runner 行，新 runner 行成为默认行（列表首行）；新 runner 的「默认 runner」配置恢复为自身（收留未打标条目）；部署面的 legacy 种子 URL（全新 DB 的种子与面板盲退化路径的选址目标）更新为新 runner 地址。

#### Scenario: 内存包络与预算一致
- **WHEN** 独立 Deployment 的容器内存上限为 4Gi（requests=limits，QoS Guaranteed）
- **THEN** runner 常驻预算声明 ≤ 上限减基座（3328MB），并发 child 上限（8）高于预算可容纳数（≈5-6），预算是真实约束；面板展示的 budget_mb_limit 与之一致。
