# 脊柱存储切换 Runbook（add-supply-store-unification 3.2/3.3/3.5 + 2.5）

> 静窗执行预案。代码侧（1.x/2.x/3.1/3.4）已就绪；本文件是切换日的唯一操作单。
> 前置阅读：change `add-supply-store-unification` design.md（D1-D4）；
> `gateway/supply-store.js`（契约真源）；registry 侧 commit `bbaea8e6`（fd-supply-spine-adapter）。

## 0. 前置状态清单（切换日早晨核验）

- [ ] registry 镜像已出片：`fd-supply-spine-adapter` → 私有源仓 → CI 镜仓 `fd-mcp-registry`（**勿推错 origin；本机 github 须显式 `id_ed25519`**）→ 新 digest
- [ ] 谦面镜像已出片：paas 仓（含 `gateway/supply-store.js` + 脚手架）→ 快照线 → 新 sha
- [ ] 两个 secret 值已生成并托底：
  - `SUPPLY_STORE_PROJECTION_TOKEN`（registry pull 通道）
  - `SUPPLY_STORE_WRITE_TOKEN`（facade/迁移写闸通道）
- [ ] 静窗确认：无在途发布（谦面 10/h 限流窗口空闲）、无巡检/走查班并行

## 1. GitOps env 清单（2.5 —— 一次 commit，ArgoCD 滚动）

### 1a. `fd-infra-deploy/all-services/prod/facet.yaml`（先滚，脊柱落位但行为零变）

```yaml
# supply-store 路由与 token（投影/写闸在脊柱侧常开；SUPPLY_STORE_CATALOG 不设 =
# 目录面仍读 bridge —— 读面切换在第 4 步才翻）
- name: SUPPLY_STORE_PROJECTION_TOKEN
  valueFrom: { secretKeyRef: { name: facet-supply-store, key: projection-token } }
- name: SUPPLY_STORE_WRITE_TOKEN
  valueFrom: { secretKeyRef: { name: facet-supply-store, key: write-token } }
```
secret 生成：`kubectl --context cheap-ts -n fd-prod create secret generic facet-supply-store \
  --from-literal=projection-token=$(openssl rand -hex 32) --from-literal=write-token=$(openssl rand -hex 32)`

### 1b. `fd-infra-deploy/mcp-registry/prod/registry.yaml`（后滚，env 翻开即切读源）

```yaml
- name: SPINE_REPLICA_MODE
  value: "1"
- name: SPINE_PROJECTION_URL
  value: "http://10.43.71.119:3200"   # facet svc ClusterIP（platform FACET_CATALOG_URL 同值，hostNetwork 可达已实证）
- name: SPINE_PROJECTION_TOKEN
  valueFrom: { secretKeyRef: { name: spine-replica, key: projection-token } }  # 与 1a 同值，registry 侧另建 secret
- name: SUPPLY_STORE_WRITE_URL
  value: "http://10.43.71.119:3200"
- name: SUPPLY_STORE_WRITE_TOKEN
  valueFrom: { secretKeyRef: { name: spine-replica, key: write-token } }
```
注意：registry.yaml env 段极简（现仅 3 条），补充时勿动 `DOCUMENTDB_*` 之外的启动依赖；开模式缺 env → fail-fast（启动即崩，回滚=回退 commit）。

### 1c. 滚动顺序与坑

1. facet 先滚（新增路由+token，行为零变）→ rollout status 到位
2. registry 后滚（`SPINE_REPLICA_MODE=1` 一次翻）→ **hostNetwork 滚动死锁坑**：Registry Deployment 若 Recreate/hostPort 占口，手动 delete 旧 pod 让位；滚动前镜像预拉（cheap-8 `ctr images pull`）
3. 双 pod Ready 后立刻做第 2 步的 stale 检查

## 2. 静窗停写（3.3 步骤 1）

- 谦面侧写闸在迁移窗口返回 maintenance 语义（迁移器 `--maintenance` 预留位；实际闸=先停 registry 写入口：`kubectl --context cheap-ts -n mcp-registry scale deploy/registry --replicas=0`？**否**——registry 停机即网关停。正确姿势：registry 不停，靠「迁移期间无人发起登记」的静窗纪律 + 迁移后对账兜底；若有在途写，双读对账会逮住）
- 记录窗口起止时间戳（审计对齐用）

## 3. 迁移（3.3 步骤 2，从跳板机/本机执行）

```bash
# dry-run 先行（必做；输出逐行计划+未知字段+visibility 缺失名单）
cd /Users/chengsishi/finddata/paas
REGISTRY_URL=https://mcp.finddatatech.cloud \
MARKET_REGISTRY_TOKEN=<registry 内部令牌> \
node scripts/supply-store-migrate.mjs

# confirm 真写（--actor 落审计）
REGISTRY_URL=https://mcp.finddatatech.cloud \
MARKET_REGISTRY_TOKEN=<...> \
node scripts/supply-store-migrate.mjs --confirm --actor aloadtree@finddatatech.cloud
# 成功判据：exit 0 + 「row-level reconciliation: N/N AGREE」
# 未知字段行：按报告逐字段补映射表后重跑（绝不裁剪硬塞）
# visibility 缺失行：逐条人审后手工 PATCH visibility（写闸 facade 通道）
```

## 4. 双 dump（3.2 —— pre-cutover 双份留存）

```bash
# 脊柱侧（facet pod 内）
kubectl --context cheap-ts -n fd-prod exec deploy/facet -- \
  node scripts/supply-store-dump.mjs /data/packs.db /data/dumps
# registry 侧 Mongo（registry pod 内，pymongo dump → 落 pod /tmp 再 kubectl cp）
kubectl --context cheap-ts -n mcp-registry exec deploy/registry -- sh -c \
  'mongodump --uri "$DOCUMENTDB_URI" --db mcp_registry -o /tmp/mongodump-pre-cutover'
kubectl --context cheap-ts -n mcp-registry cp deploy/registry:/tmp/mongodump-pre-cutover ./mongodump-pre-cutover
# 双份 sha256 记入本文件末尾执行记录段
```

## 5. 切读源（3.3 步骤 3）

1. GitOps bump 1b（registry.yaml env）→ ArgoCD sync（`--async`，hostNetwork 坑见 1c）
2. **stale 检查**：`kubectl --context cheap-ts -n mcp-registry exec deploy/registry -- curl -s 127.0.0.1:7860/api/system/stats | grep spine_replica_status` → `stale: false`、`asOf` 新鲜
3. 公网冒烟：`curl -H 'X-API-Key: <MCP_HTTP_TOKEN>' https://mcp.finddatatech.cloud/law-bench/mcp` initialize 200；匿名 401 门仍在
4. 壹座冒烟：装机面板读路径（FACET_CATALOG_URL 零改，回归即证）

## 6. 双读窗口（3.3 步骤 4 —— 24h）

```bash
# 单次比对（cron 每 15min 跑一次，漂移即告警）
REGISTRY_URL=https://mcp.finddatatech.cloud \
MARKET_REGISTRY_TOKEN=<...> \
SPINE_PROJECTION_URL=http://10.43.71.119:3200 \
SPINE_PROJECTION_TOKEN=<...> \
node scripts/supply-store-dual-read.mjs
```
- 已知预期差异：`groups`（registry list 不回）→ 双读脚本已声明跳过；registry 新运行时字段出现在信息段 → 正常
- 任何行级字段漂移 → 停观察、查审计（`supply_write_audit`）、判责后处置

## 7. 回滚（3.5 —— 演练一次再上岗）

单命令回滚 = GitOps revert 1b commit + ArgoCD sync：
```bash
cd /Users/chengsishi/finddata/fd-infra-deploy && git revert <1b-commit> && git push
argocd app sync <mcp-registry-app> --async
```
- registry 读源回指本地 Mongo（pre-cutover dump 已在其内，数据不丢）
- 回滚窗口内脊柱新写入并回：`supply_write_audit` 列出窗口内 `source='facade'/'gate'` 行 → 逐行在 registry API 重放（人工，量小）→ 再归档
- 演练判据：env 回指后 5 分钟内 `/api/system/stats` 恢复 Mongo 模式健康、28 条活册 initialize 全通
- 演练时点：静窗内、迁移完成后（此时脊柱数据=Mongo 数据，回滚无损）

## 8. 收尾（观察期满 7 天）

- [ ] 旧 Mongo 转归档：dump 双份留存（1.1G 审计 dump 先例）、deployment 缩容不删除
- [ ] MCP-REGISTRY.md §0 对账规则换锚（对账对象=脊柱投影；直补配方注记退役）
- [ ] registry-groups.json 手工映射退役注记（组元数据已原生）
- [ ] `SUPPLY_STORE_CATALOG=1` 已翻（目录面切脊柱）→ plaza/壹座机器面对账零漂移
- [ ] registry-maintenance.md 发布记录 + 本 runbook 执行记录

## 执行记录（切换日填）

| 项 | 值 |
|---|---|
| 静窗起止 | 2026-11-06 ~01:00Z–（进行中，双读窗口 24h） |
| facet 镜像 sha | sha-7d935ac（1a 落位；注释修复版 sha-0af2495 出片中——cheap-3 本地构建旁路，GH Actions 计费墙） |
| registry 镜像 sha | sha-ab9b55e（digest 66c81845，内容级合流 onto 公开 release 线） |
| 迁移对账 | 26/26 AGREE（--registry-dump 模式，pre-cutover Mongo dump 为读源） |
| 双 dump sha256 | 脊柱侧落 pod /data/dumps；Mongo dump /tmp/mongodump-pre-cutover（26 行）——sha256 待归档段补录 |
| 双读窗口首日 | 28→9→修 visibility 后剩 tool_list×6（in-flight）+provider_organization×2（迁移增强良性）；identity 27/27 对齐 |
| CATALOG 翻转 | 首翻 f84073b 实弹逮出 23 条 annotation null（repoAnnotationFn 未接）→ revert aca8849 恢复 → 修复 b0c47f756 待滚再翻 |
| 事故 | cheap-8 DiskPressure 驱逐风暴（journald 638M+镜像 prune 清，03:20Z False）；GH Actions 计费墙（11-04T22:57Z 后零成功，待用户处理账单） |
