# Design: onboard-registry-argocd

## Context

摸底实证（2026-10-13 晚，全部生产实测）：

- registry compose 栈（cheap-1 `/opt/mcp-gateway-registry`，compose project=mcp-gateway-registry）共定义 12 服务，**生产在跑 5**：registry（531MiB）、auth-server（124MiB）、mcpgw-server（90MiB，钉版 1.32.0 上游非我方构建）、mongodb（566MiB，`--replSet rs0 --auth --keyFile`，数据卷 1002MiB）、openbao（90MiB，密钥库，监听 100.64.0.11:8200=tailnet 已暴露）；keycloak/keycloak-db/pingfederate/prometheus/grafana 为上游残件从未起；mongodb-init/keyfile-init 为一次性 Exited(0)。
- **bind mount 实测全空**：`~/mcp-gateway/{servers,agents,ssl,logs}` 均 0 字节——proposal 阶段「servers/ 是运行时真源」的担忧不成立，真状态只有 mongo（1GB）+ models（262MiB embedding 权重，只读）+ openbao（KV 密钥）。
- 端口拓扑（hostNetwork 可行性）：registry 7860（uvicorn，nginx upstream 已是 `127.0.0.1:7860`）+8091（内部 API，`EGRESS_REGISTRY_INTERNAL_URL=http://registry:8091` 容器名引用）+18080/18443（nginx 宿主映射，只绑 loopback）；auth-server 8888；mcpgw 8003；mongo 27017——**四容器无端口冲突**。
- 入口：`mcp.finddatatech.cloud:8080`（HTTP）→ cheap-1 Caddy → `127.0.0.1:18080`（含 SSE flush_interval -1 + 900s 超时 + mint 预flight 特判块）；Caddyfile 已有 tailnet 直连 k3s 节点先例（`reverse_proxy 100.64.0.12:8080`=facet hostPort 模式）。
- k3s 集群（cheap-4~8+liuliang×3，cheap-1 的节点对象 liuliangth1zdmvyyvr0 NotReady 35d）：ArgoCD 8 app 在管；GitOps 真源=gitee `fd-infra-deploy`（all-services-prod `all-services/prod/`，selfHeal 实证在案）——proposal 里「argocd/application.yaml 指向 github law-private」为旧信息。节点余量（requests 口径）：cheap-8 最空（8Gi 中 33% 已用）。
- 部署样板（facet.yaml）：hostNetwork+nodeSelector 固定节点+Recreate+dnsPolicy Default+hostPath 数据——本设计照抄该惯例。
- backend-auth 注入链（fd-1.3.0 双容器同源）生产实证 132 次 `injected shared`；vend 链依赖 auth-server→`http://registry:8091` 容器名+nginx→`127.0.0.1:7860` loopback。

## Goals / Non-Goals

**Goals**：registry 生产链路（registry/auth-server/mcpgw/mongo 四容器）入驻 ArgoCD/GitOps，滚动=改 manifest push gitee；切换窗口分钟级且可秒级回退；vend 注入链在新环境首验后才切流；compose 栈冻结双轨≥1 天。

**Non-Goals**：openbao 迁移（密钥库留 cheap-1，k8s 经 tailnet 直连；迁移单独立项=阶段二）；keycloak/pingfederate/prometheus/grafana 残件处置（随 compose 冻结自然封存）；多副本/HA（单副本链路与现状同阶）；镜像重构建（复用 ccr sha-a95f7a0 同源双镜像，零代码变量）。

## Decisions

1. **范围=迁生产 5 容器中的 4**，openbao 留守。理由：主目标是 registry 链路 GitOps 化，密钥迁移风险单列；openbao 已绑 tailnet IP（100.64.0.11:8200），k8s hostNetwork pod 用节点网络栈直连零改造。备选「全家迁」弃——openbao KV 是全栈密钥源，出任何闪断即全站瘫，不值得与本次混窗。
2. **形态=四容器 hostNetwork 同节点 cheap-8**，照 facet 样板（单副本+Recreate+nodeSelector kubernetes.io/hostname=cheap-8+dnsPolicy Default）。理由：vend 链 loopback 语义原样保留（7860/8091 改 `127.0.0.1` 引用即可，共两处 env+一处模板变量）；nginx conf upstream 零改动；Caddy 切流直连 hostPort 18080（facet 先例）；端口实测无冲突。备选 ClusterIP+Service 弃——三处网络引用要改且 vend 链多一跳，为刚实证修复的注入链引入新变量。mcpgw 照搬（用途未全摸清但生产在跑 90MiB，影子冒烟若证无流量依赖，切流后可缩容=观察项非阻塞）。
3. **秘密与配置=.env 全量入 k8s Secret**（`mcp-registry-env`），服务名引用三处改 loopback（EGRESS_REGISTRY_INTERNAL_URL→`http://127.0.0.1:8091`、mongo 连接→`127.0.0.1:27017`、`{{AUTH_SERVER_HOST}}` 渲染值→`127.0.0.1`）。**不再 bind-mount** nginx conf 与 logto_admin.py/iam_manager.py——fd-1.3.0 起镜像内容与仓库字节一致，bind-mount 是 compose 时代热补丁残留，同源出片纪律下走镜像内置。
4. **mongo=StatefulSet 单副本+hostPath**（`/opt/mcp-registry-k8s/mongo` 于 cheap-8），副本集 rs0+auth+keyfile 语义原样（keyfile 入 Secret 只读挂载）。数据迁移=mongodump 全库（含 admin，1GB）→mongorestore；mongodb-init 的初始化职责被 dump 覆盖（用户/角色随库恢复）。models 262MiB→hostPath `/opt/mcp-registry-k8s/models` 只读（一次性 rsync，出站拉权重会写 CACHEDIR 的目录留可写）。备选「mongo 留 compose 远连」弃——跨机房/tailnet 一跳且延续两套运维面，正是本 change 要消灭的形态。
5. **ArgoCD=独立 app `mcp-registry`**：源=gitee fd-infra-deploy 新路径 `mcp-registry/prod/`（与 `all-services/prod/` 并列），ns=mcp-registry（CreateNamespace），automated+selfHeal 与平台同款。理由：切流窗口独立控制、回退不牵连 all-services-prod 全家桶；registry 有自己的滚动节奏（fd-* 出片纪律）。备选「并入 all-services-prod」弃——大锅 app 一次 sync 全家滚，与 registry 的切流节奏冲突。
6. **切流=cheap-1 Caddy 单行 upstream 切换**：mcp.finddatatech.cloud 块 `reverse_proxy 127.0.0.1:18080` → `http://100.64.0.x:18080`（cheap-8 tailnet IP，实施时以 `tailscale ip` 实测为准）；SSE 参数（flush_interval -1/900s）与 mint 预检特判块原样不动；Caddy reload 秒级生效。双轨：compose 栈 freeze 在 sha-a95f7a0（台账已 freeze），保留≥1 天。
7. **回退三层**：切流前失败=删 ArgoCD app（影子零流量无损）；切流后即时失败=Caddy upstream 改回 127.0.0.1:18080+reload（秒级）；切流后数据回退=观察窗内 k8s mongo 新写入以反向 dump 回灌 compose mongo（观察窗流量低，损失窗在案接受）。

## Risks / Trade-offs

- **出站源 IP 变化**（100.64.0.11→cheap-8 tailnet IP）：registry servers 条目指向的下游 MCP（NodePort/tailnet 服务）若有源 IP allowlist 会断。缓解：影子冒烟必测 business-mcp 与 legal-search 条目真实调用（经 mcp_proxy 全链）。
- **mongo hostPath 节点绑死**：cheap-8 故障时 pod 无法重调度（数据在节点盘）。与现状同阶（cheap-1 docker 卷单点）；接受，多副本 HA 非本片目标。
- **vend 链新环境首验风险**：hostNetwork 下 loopback 语义虽同，但首次在 k8s 跑。缓解：切流前影子面直连 18080 走一次完整 MCP 调用，验 `injected shared` 日志出现在 k8s auth-server。
- **cheap-8 水位**：+~1.4Gi requests（33%→约 50%）；agent-runner-serving 在 cheap-4（不同节点），故障域分离；若日后吃紧单副本可再迁（本片配方即迁移配方）。
- **双写窗口**：mongodump→restore→切流之间 compose 侧可能新增写入（wire 流量、pack 操作）。缓解：迁移选低峰窗（夜间），dump→切流间隔压到分钟级；切流后 compose 侧只读不写，回退时反向补。

## Migration Plan

时序（详见 tasks.md）：① 写 manifest（ns+Secret 骨架+4 工作负载+ArgoCD app）push gitee → ② sync（影子起来，零流量）→ ③ 数据迁移（models rsync+mongodump/restore+.env 灌 Secret）→ ④ 影子冒烟（/health+servers API+vend 链+两条 MCP 条目直连，验注入日志）→ ⑤ 低峰窗 Caddy 切流 → ⑥ 生产验证（mcp_proxy 统计+injected 计数+错误率）→ ⑦ 双轨观察≥1 天 → ⑧ compose 栈 stop（registry/auth-server/mcpgw/mongo 四容器 stop 不 rm；**openbao 保持运行**）→ ⑨ 维护台账 §1 改写+spec 归档。

回滚：④ 前失败=删 app 无损；④⑥ 失败=Caddy 未切/切回，compose 栈原样；⑧ 后回退=重启 compose 四容器+Caddy 切回（k8s 侧数据按需反向 dump）。
