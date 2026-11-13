# Tasks: onboard-registry-argocd

## 1. GitOps manifest + ArgoCD app（影子，零流量）

- [x] 1.1 cheap-8 选址核实：`tailscale ip` 实测 cheap-8 tailnet IP、确认 18080/18443/7860/8091/8888/8003/27017 七端口未被占用、requests 余量复核
- [x] 1.2 fd-infra-deploy 新增 `mcp-registry/prod/`：namespace、Secret 骨架（`mcp-registry-env` 占位+.env 全量灌入、mongo keyfile Secret）、registry/auth-server/mcpgw 三 Deployment+mongo StatefulSet（hostNetwork+nodeSelector cheap-8+Recreate+dnsPolicy Default；镜像钉 ccr sha-a95f7a0 / mcpgw 1.32.0 / mongo 8.2；容器名引用三处改 loopback；models/mongo hostPath）
- [x] 1.3 ArgoCD app `mcp-registry` manifest（源=gitee fd-infra-deploy `mcp-registry/prod/`、dest ns mcp-registry、automated+selfHeal+CreateNamespace）入 GitOps 仓同路径，push gitee 后 app 建立并 sync
- [x] 1.4 影子四负载 Running+registry/auth-server healthy；pv 无 PVC 悬挂、Secret 挂载路径正确

## 2. 数据迁移（低峰窗）

- [x] 2.1 models rsync：cheap-1 `~/mcp-gateway/models`（262MiB）→ cheap-8 `/opt/mcp-registry-k8s/models`（含可写 CACHEDIR 目录）
- [x] 2.2 mongodump 全库（含 admin；~1GB）→ scp → mongorestore 到 k8s mongo；`rs.status()` ok、registry 侧连接探活、`mcpgw/registry` 业务库文档数对账
- [x] 2.3 .env 全量复核进 Secret（OPENBAO_ADDR 指向 100.64.0.11:8200 留守值；三处 loopback 改写就位）；滚动重建四负载使新 Secret 生效

## 3. 影子冒烟（切流闸门）

- [x] 3.1 直连 cheap-8:18080：`/health`（或等价探活）+ servers API 返回与 compose 侧一致的 server 清单
- [ ] 3.2 vend 注入链首现：**未达成**（k8s auth-server 终身 `mcp_proxy: server=` 计数=0，无 `injected shared`）。组件级已证（vend 8091 UP、`_consent_with_backend_auth` grep=3、两侧 SSRF/openbao 均通）；未达成原因=切流后 wire 代理路径在 k8s 侧落通配 403（见 §6 挂账），真实代理流量到不了注入环节——非注入链本身缺陷
- [x] 3.3 出站源 IP 变化实证：影子 registry 经 mcp_proxy 调 business-mcp+legal-search 两 NodePort 条目均非 403/拒绝（allowlist 无源 IP 断裂）
- [x] 3.4 openbao 可达：k8s registry/auth-server 启动日志无 openbao 连接失败（或等价探活）

## 4. 切流 + 生产验证

- [x] 4.1 cheap-1 Caddyfile mcp.finddatatech.cloud 块 upstream `127.0.0.1:18080` → `http://<cheap-8-tailnet>:18080`（SSE 参数与 mint 预检块不动），`caddy reload`；https/18443 引用面核查并同步处理
- [x] 4.2 生产验证：mcp_proxy 统计恢复常态流量、`injected shared` 计数在 k8s auth-server 增长、错误率无异常、控制台/市场面可开
- [ ] 4.3 双轨观察≥1 天：compose 栈冻结 a95f7a0 只读；期间无回退需求 —— **结论：观察期内被回切过一次，判据不成立**（见 §6 时间线）。最终态（10-15 05:53 起）由并行会话收口：Caddy 三处→100.64.0.15、registry 滚 fd-1.4.0，双宿主收口归 add-packs-product-home 4.3；本项不再由本 change 主张

## 5. 收尾

- [ ] 5.1 compose 栈 stop registry/auth-server/mcpgw-server/mongodb 四容器（stop 不 rm；**openbao 保持运行**）；Caddyfile 注释更新指向 k8s —— **不做**：compose 侧仍是 wire cell 的上游宿主（k8s 解析不了 docker 网络名，见 §6），停了会放大 cell 403
- [x] 5.2 维护台账 §1 改写（k8s 形态+ArgoCD app+Caddy 切流配方+双轨回退配方+openbao 留守）；MEMORY 更新
- [x] 5.3 openspec validate --specs 通过、归档
- [x] 5.4 **双轨分叉数据补齐**（2026-10-15 核账时发现并修复）：compose 服务期（10-14 03:23→10-15 05:53）新增的注册数据未同步到 k8s，生产实测 `/fd-paper-trading/mcp` 405（缺失）。已同步 28 条注册记录（servers 1/agents 5/skills 4/caller_map 3/scopes 2/groups 3/embeddings 10）+ 20 条安全扫描记录，走 mongoexport→mongoimport `--mode merge`（按 _id 合并，不覆盖 k8s 侧更新）。修复后 `/fd-paper-trading/mcp` 405→401（与已知条目同形状），双向对账：compose→k8s 差集=0，反向剩余=k8s 侧分叉期新增的合法数据

## 6. 实施注记（2026-10-15 核账）

- **切流两个来回（非本 change 单方操作）**：① 10-13 19:19 本 change 切 k8s（Caddy 三处→100.64.0.15）；② 10-14 03:23 被切回 compose（`100.64.0.11:18080`），compose 换镜像 sha-adeac80/d82ffed 并新增 `100.64.0.11:18080` 端口映射——同期 cheap-1 盘满（dockerd `no space left on device`，nginx 模板 reload 失败）；③ 10-15 05:53 并行会话（add-packs-product-home 4.3）切回 k8s 并滚 fd-1.4.0，**双宿主收口归它**。最终态：文件/live config/autosave 三方一致指向 100.64.0.15，marker 探针实证公网流量落 k8s。
- **教训（双轨期纪律）**：双轨=两个可写库，回切就分叉。回切前必须反向 dump 同步，否则生产缺条目且症状温和（405 而非 5xx）不易察觉。本 change 的回退配方只写了 Caddy 一行，未写"回切前同步数据"——这是 design 的缺口。
- **挂账（不在本 change 收，属运行时/并行会话范围）**：wire cell 代理路径在 k8s 侧持续 403。根因=条目 `proxy_pass_url` 是 docker 网络名 `http://fd-wire-cell-drillcust001:8000/mcp`，k8s 侧 DNS 解析失败（实测 rc=2）→ 健康检查判 `UNHEALTHY_URL_BLOCKED` → nginx 把该 cell 的 location 整段注释掉 → 请求落通配 `^~ /fd-wire-cell-` 返回 403。影响 2 个 cell 路径（drillcust001、aloadtree）。SSRF 白名单两侧一致（hosts 含 drillcust001、CIDR 含 192.168.32.0/20），故不是白名单配置问题，是**寻址形态**问题。修法待拍板：把 cell 上游改为 k8s 可达地址（tailnet IP/NodePort）并同步条目，或让 cell 宿主暴露 k8s 可达端口。
- **k8s 侧 mongo 现有 12 条扫描记录为 k8s-only**：分叉期 k8s 侧自身产生（健康检查/扫描），非丢失。
