# Design: optimize-zhiyu-behavior-walkthrough

## Context

See proposal.md — Why. This section only records the state and constraints that shape the approach.

**为什么脚本全绿不等于链通。** 智语房间内核覆盖其实很实：`scripts/test-zhiyu-e2e-chain.mjs` 起真实模块栈（routes + store + router + bus + SSE），只 stub live-runner 的 HTTP 车道，一条叙事跑完 create → invite → hatch → @mention → broadcast+cap → busy → 呼叫 → 接管/交还 → budget → idle close → minutes；另有 12 个 script 套件与 2 个 e2e。但盲区有两类硬证据：

- 跨仓先例：`docs/registry-maintenance.md:3985`（§15.84「真机走查揪出」）记录 `scripts/test-fleet-delegation.mjs` 的 19 条用例全部直接 `createFleetRoutes(app, ctx)` 挂载，**绕过 `registerAuth` 中间件**，桥面鉴权从来没被任何用例覆盖过。
- 智语本域先例（更强）：近 60 天 8 个 `fix`/`harden` 提交中，「浏览器眼 / 真机首答」反复抓出脚本套件漏掉的缺陷——`d103f0bbd`/`08f629496` 快照缺文件致 CrashLoopBackOff（同因两次）、`13899eadd` 浏览器眼连擒两 bug（system 欢迎行不渲染 / embed 页 token 取自 useParams 但组件挂在 Route 外 → Failed to fetch）、`91ddd30a2` link 令牌被 meta 嵌入宿主闸误杀 403、`0e8edd25d` 真机首答逮住部署座 ref 被全小写毁混合大小写 packId、`332d68d98` 绑/解绑需热重载 bot 运行体、`c4021d18c` 浏览器眼第三擒。结论：真机走查必须带 **browser-eye / 无痕窗口**，不能只做 API 级观察。

**11-05 记忆架构变更（本单判据的真源）。** `add-member-knowledge-profile`（`1d21317d9`，已归档）把团队记忆从单一 `u/<owner>/f/<fleetId>` 迁到 own/shared 双分区：

```
  turn / health          -> d/<packId>/<memberId>   (own)
  decision-* / swap      -> d/<fleetId>/shared      (shared)
  legacy f/<fleetId>     -> STOPS receiving writes（仅过渡读）
  fleet-context.js:402   -> digest 三标签梯子
                            【本岗位记忆】【团队记忆】【历史团队记忆】
  server/fleet-memory.js:10,28-37,45-51,186-190
```

该 change 的 0.2（存量 `f/` 页回填）、8.2（真机冒烟 9/9：真 fd-memory + 真 paas 缝 HTTP，物化三成员 → 铸令牌 → capture 分流 → fleetContext 合流 → 文档集运行时换 → oversight 审计读）、8.3（validate 绿后归档）**全部 `[x]`**。所以本单 2.1/2.2 是回归，不是首验；按旧 `f/` 判据会得假阴性。

**部署真态。** 生产镜像 `ccr.ccs.tencentyun.com/yizuo/platform:sha-d5784e8e5-paas`，源提交 `d5784e8e5`（`unify-wanxing-a2a-face` paas 半边 / zhiyu lane 直读 packs internal）；`git merge-base --is-ancestor d5784e8e5 HEAD` EXIT=0，`git log d5784e8e5..HEAD -- <智语链 9 文件>` 为空。**生产的智语代码 == HEAD 的智语代码**，无 undeployed 差，「随滚版班」这个 10-30 挂账理由在代码侧已销。

**跨服务链条与锚点。**

```
  cell 回合  --recordFleetTurnEvent (server.js 包裹, fire-and-forget)-->  server/fleet-memory.js
       |                                                                    |
       |                                                          fd-memory (独立服务仓)
       |                                                          own : d/<packId>/<memberId>
       |                                                          shared: d/<fleetId>/shared
       |                                                          legacy f/ : 停写、仅过渡读
       v                                                                    |
  server/fleet-context.js  digest 三标签梯子 (:402-421, scope 门控)        <--+
       |
       +--> 清史重开后记忆段仍在   <-- 验「记忆层 != 对话史」，全案立论
       |
  gateway/fleet-room-bridge.js  拉取式：每 tick 取样 owner 自己 cell 的 overview
       |                        (forged-identity 通道；首见基线静默，不倒历史)
       |-- POST   /api/zhiyu/rooms/:id/fleet-subscriptions   (:119)
       |-- GET    /api/zhiyu/rooms/:id/fleet-subscriptions   (:111)
       |-- DELETE /api/zhiyu/rooms/:id/fleet-subscriptions/:subId (:142)
       |-- POST   /api/zhiyu/rooms/:id/fleet-summon          (:156)
       |          diffOverview (:40) -> systemRow (:28)
       v
  gateway/zhiyu/index.js  房间消息流 / 回合路由 / SSE / guest 闸
```

**两条已知坑**（`add-zhiyu-team-memory/design.md:86-87`，走查时会撞上）：`store.messagesAfter` 返回**数组**而非 `{items}`；gateway 内文件不共享 host 模块图，`gateway/fleet-room-bridge.js` 引 express 需显式 import。

**四个行为面的代码锚点**：guest/widget 链 `gateway/zhiyu/index.js:1011`（widget.js）、`:1025`（动态 frame-ancestors）、`:163-178`（cookie + `tty` 双轨）、`:1087-1088`（只见加入后）、`:1055`（429 限速）；私窗 `:809` / `:1139`（`private:<id>` 逐 viewer 过滤）；熔断/计费 `:450-457`（reply_cap 两级）、`:378-385`（dailyBudget 1..100000）；IM 桥 `openspec/specs/zhiyu-im-bridge/spec.md` Req3/Req5（`meta.im` 防回响、切段、送达失败如实落流）。

**官网 liveRoom 现状**：`site-zhiyu/index.html:215` 带真令牌 `wtr_192c5807…`，`site-zhiyu/script.js:158-170` 直开 `/zhiyu/embed/` 而非浮标 `widget.js`。实测 `GET /zhiyu/embed/<token>` = 200，`frame-ancestors` 含 `zhiyu.finddatatech.cloud` 与 `platform.finddatatech.cloud`（与 `docs/zhiyu-site-resupply-20261030b.md:86` 一致）。`add-product-intro-team/tasks.md` 4.1/4.2 均 `[x]`：10-30 真域无痕窗口访客提问 →「产品向导」真应答、无登录墙；10-31 四席真房间全活、a2a 车道；11-04 bridge/bots 车道活体。**即 ④ 的静态链与交互链都验过**，本单只做今天网关变更后的回归复验，不另立 change。

## Goals / Non-Goals

**Goals:**

- 把 `add-zhiyu-team-memory` 5.2 的**记忆两腿按新 scope 口径回归**、**空间桥四腿首验**，逐条有可复现证据（或明确 BLOCKED 及原因）。
- 在同一走查窗口把四个跨边界行为面从「脚本半覆盖」变成「真机观察过」，如实记录通过或缺陷。
- 产出可勾的收账（5.3 台账、归档件勾选、缺陷清单），不产产品变更。

**Non-Goals:**

- 不改任何产品代码；不新增能力 spec；不动 `openspec/specs/`。
- 不修走查发现的缺陷——另立 change，本单只出证据与判定。
- 不触碰公开演示房间 `zy_42ce690574b5423bd2`（owner `zhiyu@finddatatech.cloud`）；走查另建自有租户的专用房间。不改任何产品配置、不动他人数据。
- 不把官网 `site-zhiyu` 公开接待链另立 change；只做滚版后回归复验（无痕窗口一问一答），并入 3.1。
- 不重复 `add-member-knowledge-profile` 8.2 已覆盖的记忆链首验；本单按新口径做回归。
- 不以重跑已绿的 13 个 script 套件 / 2 个 e2e 作为验收依据。
- 不碰 `openspec/specs/app-navigation/spec.md:4` 的 Purpose「including the Bots entry」残留。项目规则（`AGENTS.md`）要求 specs 只能经 `openspec archive` 更新，且本单 `skip_specs: true` 无 delta 通道；只登记为跨单 deferral（`align-yizuo-specs-to-reality` 提案当时也把它留作「Purpose 层 chore」）。
- 不重开 `add-zhiyu-team-memory` 归档件；只回写其 tasks.md 两个勾选框。

## Decisions

### D1 · 一趟真机同时覆盖 5.2 与四个行为面

七步与四个面共享同一测试租户、同一客服班组种子、同一走查窗口，且都落在「跨边界、脚本替不掉」这一同类盲区上。

- 备选 A：分两个窗口分别走查 → 多一次窗口协调，且两趟会重复确认同一环境/种子，无增量信息。
- 备选 B：只补脚本用例把盲区盖住 → 与 §15.84 及智语本域 8 个 fix 的教训正面冲突；脚本再全绿仍绕不过真实 cell 身份与独立服务仓。

### D2 · 判据是可观察产物，不是「测试通过」

每条判据指向具体落库行、消息流事件行、端点响应或页面呈现，并带 `timestamp + ownerEmail + fleetId / roomId` 三元组用于对账。fd-memory 在独立服务仓，两侧都取三元组，不靠单边日志。

- 备选：以既有脚本套件全绿为准 → 已绿（`add-zhiyu-team-memory` 5.1：13/13 + 回归 165/165 + validate 绿），对跨边界链零信息量，明确拒绝。

### D3 · 缺陷只登记不改（evidence-first）

走查若发现缺陷，写成「现象 / 证据 / 建议另立 change」一行，本单零源码改动。

- 备选：顺手修 → 会把证据链与修复混在同一窗口，缺陷现场被覆盖，且违反本单 Non-goals 与出片纪律。修复另立 change 走既有出片线。

### D4 · 拉取式桥的等待上限显式化，超时记「未观测到」

`gateway/fleet-room-bridge.js` 每 tick 取样 owner cell 的 overview 并差分；事件行有天然延迟。`evidence.md` 为每条事件行判据写死等待上限（默认 90s / 5s 轮询），超时如实记「未观测到」并附原因，**不推断成功也不推断失败**。

- 备选：固定 sleep → 随负载漂移，flaky。

### D5 · `skip_specs: true` + 刻意跳过 specs 工件

本单是验证/文档类，无 spec 级行为变更。instruction 明确「Do not invent a requirement just to satisfy validation」，且同日两单体检单（`optimize-yizuo-module-audit` / `optimize-paas-module-audit`）均以 `skip_specs: true` 立案，仓内先例一致。

- 备选：编一条 ADDED 需求凑 delta → 会造出一条不描述任何外部可见行为的假契约，归档后污染主 spec，明确拒绝。

### D6 · 归档件回写取最小变更面

5.2 / 5.3 只在 `add-zhiyu-team-memory/tasks.md` 改两行 `- [ ]` → `- [x]`，用 `git diff` 对账零其余差异；不重开归档、不碰其 spec 文本。仓内已有「归档后补勾」先例（`crossborder-vertical-line` 5.1/2.4 补勾）。

### D7 · 记忆两腿按 11-05 新口径回归，不重复 8.2 首验

`add-member-knowledge-profile` 8.2 已用真 fd-memory + 真 paas 缝 HTTP 跑过 9/9，且把 `f/` 停写。本单 2.1/2.2 的判据改为 `own: d/<packId>/<memberId>` / `shared: d/<fleetId>/shared` 与 digest 三标签梯子；`f/` 出现新写入反而是缺陷信号。

- 备选：沿用 10-30 的 `u/<owner>/f/<fleetId>` 判据 → 会得到假阴性，且重复已完成的劳动，明确拒绝。

### D8 · 官网 liveRoom 作为 3.1 的回归 case，不另立 change

10-30/10-31/11-04 已有真域无痕窗口真应答证据；今天 `gateway/index.js` 的摘挂变更后唯一新增风险是回归，用一个浏览器眼 case 覆盖即可。

- 备选：另立 ④ change → 会重复建立同一令牌/房间/白名单的判据，且把已验过的链重新当未验处理。

## Risks / Trade-offs

- [走查依赖服务可用性与登录凭据，可能跑不全] → 每条判据预写成可离线核对的落库/流内快照；窗口或凭据不到位时如实标 BLOCKED 并写原因，不假绿。
- [fd-memory 在独立服务仓，证据跨仓] → 两侧都取 `timestamp + ownerEmail + fleetId` 三元组对账，不靠单边日志。
- [11-05 scope 迁移后旧 `f/` 判据失效] → 按 D7 换口径；`f/` 只作过渡读，出现新写入记为缺陷。
- [拉取式桥有 tick 周期，事件行可能延迟] → 按 D4 显式等待上限；超时记「未观测到」而非推断。
- [guest 令牌与私窗涉及隐私] → 只用既有测试租户；证据只落消息 `kind` / `seq` / 可见性标记 / 计数，不导出真实用户消息正文。
- [归档件 tasks.md 回写] → 只改两行状态，`git diff` 对账零其余差异。
- [四个行为面可能查出真缺陷] → 本单不改码，缺陷清单交另立 change；代价是收口延期，收益是证据不被修复动作污染。
- [Purpose 残留只能登记] → 在 design 与台账中明确标注 deferral 与理由，避免下轮体检重复报同一条而误判为未处理。
- [CSP `frame-ancestors` 含 `http://` 源] → `gateway/zhiyu/index.js:1023` 对非通配白名单同时产出 https 与 http 两条；父站 80→443 已 308、iframe 本身 https，两条 http 无正当用途。属 P2 硬化，改的是产品代码，本单只登记不改。

## Migration Plan

无部署、无回滚（只读观察 + 文档）。执行序：

```
判据固化 -> 环境/种子确认 -> 5.2（两腿回归 + 四腿首验）-> 四个行为面
        -> 缺陷登记 -> 台账补记 + 归档件勾选回写 -> validate --strict
```

走查若触发缺陷修复，另立 change 走既有出片线（源提交 → 镜像 → GitOps 滚版），不在本单内。本单产物全部为仓内文档与状态位，可直接回退（revert 对应文件）。
