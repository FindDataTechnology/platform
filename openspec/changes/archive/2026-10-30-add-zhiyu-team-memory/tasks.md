## 1. 前置核对

- [x] 1.1 结论：复用 server/cluster-memory.js 的既有客户端模式（/pages+/digest 平台缝）——`f/<fleetId>`
      是 u/ root 下普通 project，memberId 走 digest 的 q 参数（相关度排序）而非存储过滤；
      **fd-memory 零契约变更**证实
- [x] 1.2 定案：**拉取式**——桥沿 fleet-cells.js 的 forged-identity 通道（owner email + 共享 secret）
      取样 owner 自己 cell 的 /api/fleets/overview（零新上行白名单字段、零推送通道），
      每订阅 tick 差分→频控合并→system 行

## 2. 刀A · 岗位记忆（server 侧）

- [x] 2.1 `server/fleet-memory.js`（含 capture/health-flip/digest 客户端）：挂点三处——
      `recordFleetTurnEvent`（回合+健康迁移，server.js 包裹）、escalate/resolve（server/routes/fleets.js）、
      swap（真返回点）；幂等键含内容（固定时钟不误判重放）
- [x] 2.2 `fleetContext` 增 `memoryDigest` seam（决策 digest 后、结语前）：provider null/throw=段缺席；
      预算沿 PER_POST_LIMIT 截断、位置=池尾（截断顺序 报数>决策>记忆）
- [x] 2.3 换防/清史核对：零记忆删除调用（spec: 解散不清记忆）；swap capture 带 freshSession 标注
- [x] 2.4 `scripts/test-fleet-memory.mjs` 7/7：五类事实落 f/ project、幂等重放（键含内容）、
      失败=计数不抛、健康迁移只在 ok↔failed 翻转时发、seam 有/无/抛三态、超预算截断

## 3. 刀B · 团队×空间（gateway 侧）

- [x] 3.1 `zy_fleet_subs` 表（UNIQUE(room,fleet)）+ fleetSubAdd/Of/All/Remove；
      `gateway/fleet-room-bridge.js`：订阅 CRUD（所有权对活样本核验——非自有=404 不区分存在性；
      每房上限 5；订阅/解除都在房内留痕）
- [x] 3.2 拉取式 tick：差分（首见静默基线、无历史倾倒）→报告/拍板/健康三类 system 行（深链回驾驶舱）；
      频控 1h 窗口 >10 条合并为计数+样例行；连续失败≥3 开熔断、恢复行带「丢弃 N 条」标注；
      桥故障只哑桥（catch 全包）
- [x] 3.3 `POST /fleet-summon`：dry-run 预览（serving 可召唤 vs cockpit-only 如实）→执行走既有
      inviteCreate 握手/策略；召唤自带订阅；部分失败逐成员如实
- [x] 3.4 `scripts/test-fleet-room-bridge.mjs` 6/6：非自有 404、幂等订阅、首见基线无倾倒、
      差分三类落行+深链、不变样张零重复、死 cell 哑 tick、召唤预览/执行、解除断流+旧行保留

## 4. web 面

- [x] 4.1 ZhiyuRoomPage 名册侧栏增「团队订阅」区（owner 视角）：列表/解除、fleet id 预览→召唤、
      计划区分 ✓可召唤 与 •去驾驶舱、逐成员结果；桥面失败降级为不渲染
- [x] 4.2 i18n `zhiyu.fleet.*` 五语言同批；locale 闸绿

## 5. 验收

- [x] 5.1 新 13/13 + 既有 fleet 114/114 + zhiyu 51/51 + typecheck/biome（触碰文件，两条 pre-existing lint 非本批）/locale 绿 + validate 绿
- [x] 5.2 真机走查（随滚版班）：客服班组跑三回合→记忆面见 `f/` 观测→fleetContext 见记忆段→
      清史重开后记忆段仍在→空间订阅团队→报数事件行流入（深链回驾驶舱）→一键召唤部署成员入空间
      → **2026-11-07 解阻补记**（optimize-zhiyu-behavior-walkthrough 全链）：订阅/事件行/深链/召唤 dryRun+执行由
      fix-zhiyu-fleet-bridge-route-order（O0 复验）+ fix-zhiyu-summon-serving-face（O8）+ fix-cell-catalog-a2a-face（O9）
      三单上产真机全判据过（订阅 201+事件行深链+summonable 非空+邀请落库+订阅随行）；「三计费回合→记忆段」腿
      仍属走查单 2.1–2.3（未跑，不因此假勾其分项）——本行勾选范围=空间桥/召唤各步的真机走查实质完成
- [x] 5.3 台账补记（§15.138 序列，optimize-zhiyu-behavior-walkthrough 4.2 + 三修复单续记）
