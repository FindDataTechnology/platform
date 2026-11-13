# Tasks: fix-zhiyu-summon-serving-face

## 1. cell 侧：formation.members 补 serving 面

- [x] 1.1 `server/routes/fleets.js` overview：formation.members 对 a2a 岗补 `targetId` 与 `servingPath`（从 entry.url 解析 `${REGISTRY_URL}/agent<path>/` 形态取 path；非该形态 → null）；非 a2a 岗两字段为 null，键仍输出（消费方免判存在性）→ 实施走 resolveTarget a2a fallthrough 带 `servingPath`（entry 在手边，零额外 merge）→ memberView.target 透传 → formation 映射；键恒在
- [x] 1.2 解析为纯函数并单测：url 形态命中/未命中/非字符串三分支（若有既有 fleets 路由测试文件则并入，否则独立小测试）→ `servingPathFromEntryUrl` 导出（同 `resolveFleetTarget` 模式），并入 `test-fleet-formation.mjs`（既有 harness）两用例：解析三分支 7 断言 + overview 装配（a2a 带 ref/path、persona 双 null 键恒在）→ 套件 5/5 绿

## 2. gateway 侧：桥的 summon plan 换真源

- [x] 2.1 `gateway/index.js`：`registerFleetRoomBridge` 装配新增 `servingDeployments` 窄缝（packs internal deployments 拉取，凭据与超时纪律同 agent-lane；失败返 null）
- [x] 2.2 `gateway/fleet-room-bridge.js`：删除 `.servingMembers?.()` 寻址；按 D2 重写 serving 候选→对齐→summonable（ref/onBehalfOf）；rows null → 诚实降级空；执行段（invite 循环/订阅随行/部分失败）零改动 → **实施偏离（design.md D4 偏离段实录）**：正路径测试抓出执行段从未可能跑通——inviteCreate 缺 `idemKey`（NOT NULL UNIQUE 必撞）+ `onBehalfOf` 写死召唤者（席位 lane 按 deployedBy 匹配）——补 kernel 同款 idemKey 约定+台账部署者 onBehalfOf+在座守卫，spec 语义零变化
- [x] 2.3 biome/typecheck 过（触碰文件单独跑）→ biome 6 文件零告警；`tsc --noEmit` 绿

## 3. 测试补正路径

- [x] 3.1 `scripts/test-fleet-room-bridge.mjs`：summon 用例扩为正路径（dryRun plan.summonable 非空逐成员带 ref+title+onBehalfOf；非 dryRun 走 store.inviteCreate 断言）+ 排除态（无对齐行/servingPath null）+ 降级态（null rows，保留现断言）→ 5 用例独立 server rig（旧用例的 per-scenario app 是死注册、断言靠 JSON 无函数才过——已修正）；execution 用例当场抓出执行段死点（见 2.2 偏离）
- [x] 3.2 `scripts/test-zhiyu-route-assembly.mjs`：生产序装配 + servingDeployments stub 正路径一条（dryRun 200 且 summonable 非空）+ 台账不可达降级一条 → 7/7
- [x] 3.3 全量 zhiyu 套件回归（13 套件）绿 → zhiyu* + fleet-room-bridge + fleet-formation **92/92**

## 4. 出片与真机

- [x] 4.1 提交（只 add 本单文件）+ 双推 + 公开免费线快照闸出片（force-push 后恢复镜像 workflows）→ 提交 `a4452ccbb` 双推 origin+gitee 全等；**首推出事故**：快照漏 `--init` 旗标、嵌套 cwd 的 git 操作命中父仓，误把主仓全史 force-push 上公开镜像仓——约 3 分钟窗口内顶回正规快照点 1f9335b40 封堵（暴露面定性=8 findings 里 1 条实键且为内网 LAN 地址，台账 §15.138 续三全录）；正规重发 `--init` 快照 6fbcf38 + restore workflows **4d2dbfb** → CI image run 42316905465 **绿**
- [x] 4.2 relay → ccr skopeo 硬门 → GitOps 双清单 bump → ArgoCD 滚版 → 双 pod imageID 核对 → relay `08:26:31 OK yizuo/platform:sha-4d2dbfb (4s)`；ccr `skopeo inspect --creds` 解析成功（Created 00:16Z 吻合、digest `f3bf4f10`）；GitOps `4f97953` 双清单（prod 回写 yizuo home + demo 对齐；前版 law-bench 5254a72 回滚可用）→ ArgoCD hard-refresh → **双 pod imageID `f3bf4f10` 逐字全等**（platform-5b65776fd4-tlltg / platform-demo-7fcfcc6896-qfczb）
- [x] 4.3 真机复验：对含现役 a2a 岗的团队 dryRun → plan.summonable 非空且 ref=`packId:agentId`；外部地址/无对齐行岗如实排除；persona 岗 cockpitOnly 不变 → **2026-11-07 O9 上产后全判据过**：serving face 上线实证（新镜像 formation.members 带 targetKind/targetId/servingPath，own 账号 7 支 a2a 岗全部如实列出）；dryRun 真机 200（专用房 `zy_f510e046f10d83f440`，用后即 end）`summonable=[]` + cockpitOnly 10 岗如实——vacant 岗排除是**正确行为**；**正路径被三层环境阻塞（新缺陷 O9）**：①facet catalog 源 `doFacetRefresh` 只拉 mcp+skills 不拉 agents → cell 目录 a2a 条目=0 → 全部 a2a 岗 vacant → servingPath=null；②本平台部署台账仅 1 行（ops-seed demo），a2a 岗的 pack 部署登记在萬星面账本（分家）；③facet pod Error/Pending（并发会话处置中）→ 台账缝 ECONNREFUSED。正路径由测试全覆盖（bridge 10/10 + assembly 7/7）；**O9 上产后正路径真机全判据过**：验证舰队挂 `pack-demo-fingpt` a2a 岗（registry enabled + facet 台账唯一行）→ dryRun `summonable=[{ref:"vtdpsNmtW6OQ9I99mBhbDw:pack-demo-fingpt", onBehalfOf:admin@finddatatech.cloud（台账部署者）}]`（专用房 `zy_a639f62f83406a613e`）
- [x] 4.4 执行级召唤一次（至多一队）：invites 按策略发起、逐成员结果如实、订阅随行；复验后清理测试房间 → **2026-11-07 过**：执行召唤 `results=[{ref:"vtdpsNmtW6OQ9I99mBhbDw:pack-demo-fingpt", ok:true, inviteId:"inv_7ed541636d66b2c127"}]`；生产 zhiyu.db 邀请行落库（kind=agent、on_behalf_of=台账部署者、state=pending——待答如实）；订阅随行落库（zy_fleet_subs 第 2 行）；验证房已 end、验证舰队已删

## 5. 收口

- [x] 5.1 走查单 O8 行改「修复已上产」+ 2.6 全判据注记 + 归档件 2026-10-30 5.2/5.3 解阻补记（见 evidence/O9 行与台账续五）
- [ ] 5.2 `openspec validate --strict` → 归档入 specs
