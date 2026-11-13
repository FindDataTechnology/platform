# Proposal: add-serving-runner-split

## Why

M2 容量实测（2026-10-11）定案：内存是 serving 并发的硬约束，规模化前置 = serving runner 独立 deployment（结构决策待拍板）。现状是历史遗留的第三种 runner 形态——**serving runner 是 cheap-1（registry 宿主机，同时也是 k8s 集群里 NotReady 的 liuliangth1zdmvyyvr0 节点）上的一个裸 docker 容器**：2Gi 内存上限、768MB 常驻预算、手工生命周期（无 GitOps、无 ArgoCD、镜像滚不动）、与 registry/WAF/buildx 挤同一台重载机器。M4⑤ 开放前置点名此结构决策——不拍板只能内部小规模。用户已拍板（2026-10-13「开始做吧」）。

## What Changes

把 serving runner 迁到 k8s 独立 Deployment（与任务车道 runner-b/c 同款形态），并通过既有 fleet-scheduler 接管机制零手工迁移存量条目：

- **新 Deployment `agent-runner-serving`**（GitOps fd-infra-deploy，cheap-4 专用节点、hostNetwork、hostPath 数据根、镜像与 b/c 同源 sha-5c9f532）：内存包络 4Gi（QoS Guaranteed）、常驻预算 3328MB（≈5-6 并发 child，对齐 M2 实测 540-600MB/child）、MAX_CHILDREN 8、标准端口几何 8790+8791/32（专用节点无撞端口）。
- **数据搬家**：cheap-1 docker 卷 `agent-runner-data`（llm-providers.json 含 finddata 提供者密钥、按代理 DSH home、meter/notify 审计）rsync 至 cheap-4 hostPath。
- **防双宿主切换时序**：新 runner 先以 `AGENT_RUNNER_DEFAULT_ID=cheap-1` 惰性启动（只收 runner-serving 标签条目 = 0 个，不与 cheap-1 抢未打标条目）；fleet 表插入 runner-serving 行；kill cheap-1 容器 → scheduler 接管波（stale 90s）把 6 个条目（2 打标+4 未打标）自动改点 runner-serving（预算余量 3328 最大必胜）；冷重建即恢复服务。
- **卫生步**：fleet 表删 cheap-1 行、runner-serving 行回填 created_at 成为默认行（rows[0]，退化路径的选址目标）；Deployment 去掉 DEFAULT_ID（默认=自身，收留未打标）；platform-config 的 `AGENT_SERVING_RUNNER_URL` 种子值更新为新 runner URL（只影响全新 DB 的种子与盲退化路径）。
- **cheap-1 容器退役不删卷**（当日回滚保险：重启容器即恢复心跳；滞回保证条目不会自动搬回去，灾难回滚=手工改点）。

零应用代码变更：runner/facet/scheduler/observer 代码全部现成（add-fleet-scheduler 四证生产验证）。本片是部署拓扑 + 运维时序 + 生产切换。

##Capability

`agent-runner`（新增部署拓扑要求；既有「分片托管」「死亡改点」要求不动）。

## Impact

- 代码：无（镜像 sha-5c9f532 不滚）。
- GitOps（fd-infra-deploy，gitee ArgoCD）：新增 agent-runner-serving.yaml；platform-config 单值更新（platform+facet 各滚一次，Recreate 秒级窗）。
- 集群外：cheap-1 docker 容器 stop（保留卷）；secret agent-runner-serving-env out-of-band 建。
- 生产影响面：切流窗口 = kill 后 ~2 分钟（stale 90s + 下一趟 30s tick + 新 runner 20s poll 物化）；6 个在役 serving agent 冷重建（温会话转写丢失，代理本身不停摆）；runner-b 的 4 个条目不动。
