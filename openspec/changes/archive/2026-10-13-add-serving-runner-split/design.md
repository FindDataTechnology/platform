# Design: add-serving-runner-split

## Context

摸底实证（2026-10-13）：

- serving runner = cheap-1 `agent-runner-dsh` 裸 docker 容器（`docker inspect`：Memory 2Gi、restart unless-stopped、卷 `agent-runner-data`→/data、env 全量在案）。cheap-1 同时是 registry compose 栈/WAF/buildx 宿主，且其 k8s 节点对象（liuliangth1zdmvyyvr0，InternalIP 100.64.0.11）NotReady 35d——容器平面完全在 k8s 控制面之外。
- fleet 表（facet packs DB，`GET /api/packs/internal/runners`）：cheap-1（100.64.0.11，8791/32，默认行）、runner-b（100.64.0.13=cheap-6，8851/32）、runner-c（100.64.0.14=cheap-7，8891/32）。
- registry serving 条目 10 个：runner-b 4、cheap-1 打标 2、未打标（默认→cheap-1）4。
- observer 面板 live：cheap-1 {children 2, agents 6, budget 217/768}，runner-b {2,4,267/768}，runner-c {0,0,0/768}。
- fleet-scheduler（gateway/fleet-scheduler.js，驻 facet 单副本）：stale 90s / 孤儿（掉板+行龄>10min）→ 改点最闲健康 runner（余量=budget_limit−budget 降序），滞回不回搬；生产四证（孤儿改点/接管/真回合/滞回）。
- 节点余量（kubectl top）：cheap-4 2.56Gi/7.7Gi（最空），且与 runner-b(cheap-6)/runner-c(cheap-7) 不同故障域；cheap-4 tailnet IP=100.64.0.8。
- runner 侧分片过滤（agent-runner/registry.js）：`(entry.metadata.runner_id ?? defaultRunnerId) === fleetId`；defaultRunnerId = `AGENT_RUNNER_DEFAULT_ID` ?? 自身 fleetId。

## Goals / Non-Goals

**Goals**：serving lane 获得独立内存包络（4Gi/预算 3328，并发 ≈5-6 vs 现 2-3）、声明式生命周期（GitOps+ArgoCD 可滚）、与 registry 宿主及任务车道故障域隔离；存量 6 条目零手工迁移；切换窗口分钟级。

**Non-Goals**：不动 runner/facet/scheduler 任何代码；不做容量水位线部署闸与开放身份门（M4⑤ 余项，另片）；不回收 runner-b 上 4 个 serving 条目（滞回语义如此）；不动任务车道 b/c。

## Decisions

1. **落点 cheap-4 专用节点、标准端口几何 8790+8791/32** —— 专用节点无撞端口（b/c 因共节点用 8851/8891 基座），fleet 行几何与 runner env 保持一致；避免与任务车道同节点（单节点故障不打断两条车道）。备选 cheap-7（与 runner-c 同节点、需改基座）弃。
2. **镜像 sha-5c9f532 原样复用** —— 与 b/c 及旧容器同源，切换零代码变量；本片纯拓扑迁移，出新镜像反而引入无关变量。
3. **防双宿主时序：新 runner 先带 `AGENT_RUNNER_DEFAULT_ID=cheap-1` 惰性启动** —— 否则新 runner（默认=自身）会在切换窗口为 4 个未打标条目 spawn 常驻 child（residency 无闲置回收），与 cheap-1 双宿主白耗 ~1-2GB。接管波给条目打 runner-serving 标签后即由标签匹配接管，DEFAULT_ID 在卫生步随 Deployment 更新移除（pod 重启一次，child 冷重建）。备选「立刻 kill 缩短窗口」弃——窗口内浪费不受控且时序脆弱。
4. **kill cheap-1 触发接管波，而非手工改点** —— 既有机制生产验证过，且给「死亡改点」路径再来一次真实负载下的实证（6 条目）。改点落点由余量排序自动选 runner-serving（3328 余量 > b 501 > c 768），无需干预。
5. **数据 rsync 而非弃卷冷起** —— /data 里 llm-providers.json（finddata 提供者+密钥）是 child LLM 车道必需；按代理 DSH home 与 meter/notify 审计顺带保留连续性。llm-providers.json 属机密，走 ssh 直拷不落仓。
6. **卫生步三件套一起做** —— fleet 表删 cheap-1 行+runner-serving 行 created_at 回填为最老（成默认行 rows[0]；行龄同时越过孤儿宽限）；Deployment 去 DEFAULT_ID；platform-config `AGENT_SERVING_RUNNER_URL` → http://100.64.0.8（platform+facet 各滚一次，Recreate 秒级窗）。不做卫生步的后果：全新 DB 会种子出死地址、面板盲退化路径（board 不可达时 rows[0]）指向死 runner。
7. **cheap-1 容器 stop 不 rm、卷不删**（当日回滚保险）—— 滞回保证条目不会自动回搬，灾难回滚 = stop runner-serving + 重启旧容器 + 按本片 scheduler PUT 语义手工改回（一次性脚本）。次日确认稳定后再清。

## Risks / Trade-offs

- **切换窗口 ~2 分钟服务缺口**（stale 90s + tick 30s + poll 20s + 冷启动）：A2A 调用方（facade 重放/调用者重试）可吞；温会话转写丢失（冷重建语义，与既有 failover 契约一致）。
- **cheap-4 节点水位升至 ~85%**（+4Gi Guaranteed）：platform-demo（Burstable）受挤压风险有限；若日后吃紧，runner-serving 单副本可再迁（本片建立的机制即迁移配方）。
- **单副本 runner-serving 自身是单点**：与现状同阶（现状还是更脆的裸容器）；多副本横向扩留给水位线片。
- **接管波目标误选 b/c 的风险**：仅当 runner-serving 未上面板（心跳未到）时发生——时序上先验证面板心跳再 kill，且 b/c 余量 501/768 远小于 3328，正常必落 runner-serving。
- **观察盲区**：接管波日志只在 facet pod stdout（无持久日志面）；验证以 registry 条目 URL + 新 runner poll 日志 + 真回合为准。

## Migration Plan

时序（详见 tasks.md）：① rsync 数据 → ② 建_secret + GitOps 上 Deployment（DEFAULT_ID=cheap-1）→ ③ 面板见 runner-serving 心跳 + poll 0 agent → ④ facet DB 插 fleet 行（sqlite via kubectl exec，better-sqlite3）→ ⑤ docker stop agent-runner-dsh → ⑥ 观察 facet fleet 日志改点波 + registry 条目 URL 翻到 100.64.0.8 → ⑦ 真回合+计费验证（facade A2A 真调用 + sub2api 记账）→ ⑧ 卫生步三件套 → ⑨ 稳定观察后清 cheap-1 容器与卷。

回滚：⑦ 前失败 = 无损（新 runner 空转，撤 Deployment 即可）；⑦ 后失败 = stop runner-serving → docker start agent-runner-dsh → 手工把 6 条目 PUT 回 cheap-1 几何（复用 scheduler 改点语义的一次性脚本）。
