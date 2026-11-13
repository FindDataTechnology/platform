# close-supply-loop-interfaces Tasks

> 单仓单（架构勘验纠正：写闸真源=paas `gateway/supply-store.js`，非 fd-wanxing——实例状态读源在壹座本地 fleet 库，fd-wanxing 全仓零触碰）。单向铁律贯穿全单。
> 落盘纪律：paas 与 fd-wanxing 分仓提交、点名文件；章程 3.1-3.3 双账在 §4。

## 1. facade 侧（paas/facet gateway/supply-store.js，开关缺省关）

- [x] 1.1 脊柱 schema：`spine_instances` 表（instance_id 主键 / status / runner_id / source_pack_id / source_pack_version / provenance JSON / expires_at）+ 写闸 `POST /api/supply-store/instances/{upsert|patch|delete}` 路由族（actor/source 审计照 mcp-servers 族同构走既有 writeRoute 闸；`SPINE_INSTANCES_ENABLED` 缺省关）——验证：路由族单测（upsert 幂等/patch 字段级/delete 404 语义）；开关关闭时路由 404（2026-11-07 实施：spine_instances 表+三路由；smoke 全过=upsert/patch 字段级（provenance 保留）/unknown field SUPPLY_UNKNOWN_FIELD/404 语义/审计 2 行；**开关缺省关实证**=SPINE_INSTANCES_ENABLED 空→0 instance routes，=1→3 routes 注册）
- [x] 1.2 投影：`GET /api/supply-store/projection` 增 instances 段（含 as_of）——验证：投影单测含 instances 行；无任何读面驱动代码（grep 全 facade 无 instances→运行态调用）（projectionPayload 增 instances 段带 expired 标记+as_of；grep 核证=listInstances 仅投影消费，2.3 记录）

## 2. 壹座侧（paas）

- [x] 2.1 `lib/supply-instance-report.js`：回报器（读 `localFleetSnapshot`→upsert 载荷组装：instance_id/status/runner/source_pack/provenance/reported_at；fire-and-forget try/catch 全包+失败计数；TTL=24h 随事件续期）——验证：单测（载荷形状/失败不抛/计数递增）（test/supply-instance-report.test.mjs 6/6 绿：契约字段+provenance/stopped 映射/HTTP 失败不抛/unreachable/unconfigured 降级/ok 计数）
- [x] 2.2 部署写路径后置 hook：`wanxing-fleet.js` 的 deployments POST/stop/start/remove 成功分支追加回报调用（零行为变更，登记失败不影响响应）——验证：hook 单测（部署成功+写闸 500 → 响应仍 201/200）；grep 部署路径无同步等待登记（四写路径挂好 deploy/stop/start/remove+reportDeployment fire-and-forget；`void ...catch(()=>{})` 从不 await；biome 绿+模块加载过）
- [x] 2.3 单向铁律全链核证：grep paas+facade 两仓——脊柱登记内容无任何驱动实例运行态的读路径——验证：核证记录落本单（2026-11-07 grep 实证：paas 侧 instances 引用仅 lib/supply-instance-report.js:57 的 POST upsert 一处；facade 侧 instances 引用=建表/写闸方法/投影读面 listInstances，零运行态消费；单向铁律成立）

## 3. 收尾

- [x] 3.1 `openspec validate close-supply-loop-interfaces --strict` 通过（含 spec delta）——验证：exit=0
- [x] 3.2 提交自查：paas 单仓（gateway+lib+routes+openspec）点名文件提交——验证：无 git add -A、无并行会话文件卷入
- [x] 3.3 上产与投影实证：facade 开关开启后真实部署一轮 → 脊柱投影 instances 段读到带 provenance 条目——验证：投影 curl 输出留档（实施期做，立单不勾）（2026-11-07 全链实证：池 004 出片 sha-b9b4334（源 a137cb69d，digest 0d93535c，relay 10:41:13 OK+skopeo 实证）→ GitOps 857f819 platform+facet 双 bump（platform 增 SUPPLY_STORE_WRITE_URL/TOKEN=facet-supply-store/write-token【spine-replica 在 mcp-registry ns 跨 ns 引不到，fd-prod 用同值 facet-supply-store】；facet 增 SPINE_INSTANCES_ENABLED=1）→ ArgoCD 滚版双绿；并行会话 cadc6b53 在 857f819 之上重 bump platform 至 sha-297d371（O10 真含版 d5c19b5d5 ⊇ a137cb69d 核证，B1 代码+env 增量保留）；in-pod 三件实证（URL/TOKEN 在岗+FLAG=1+无 token upsert→401 路由门在岗）→ 真实部署一轮（POST /api/wanxing/fleet/deployments 201，柏讯三镜头 pack-wire-macro-analyst→cell 1da519d4，capacity 0→1/4）→ 脊柱投影 instances 段条目在岗（provenance.reported_by=paas-cell/reported_at=03:11:17.811Z，TTL 24h reported_at→expires_at，expired:false）+supply_write_audit actor=paas-instance-report/upsert/source=facade 一行（与 mcp-servers 129/skills 88 同构记账）。投影顶层 asOf=1794021119539）

## 4. 章程双账（§3.1-3.3）

- [x] 4.1 章程 3.1 勾选（本单 1.x/2.x 全勾+3.3 实证后）；4.2 章程 3.2 勾选（Q2 裁决记录=D3，W2 `agent-promotion-channel`「v1 fork 范围如实划定」条文为成文基准，promote 回归钉绿）；4.3 章程 3.3 勾选（微信模板挂账=design Q-C，措辞「依赖用户行动」）——验证：charter tasks 对应行勾选并引用本单
