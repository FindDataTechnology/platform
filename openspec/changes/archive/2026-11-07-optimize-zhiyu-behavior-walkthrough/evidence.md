# Evidence: optimize-zhiyu-behavior-walkthrough

> 走查日 **2026-11-06** · 环境＝生产 `platform.finddatatech.cloud`（镜像 `sha-d5784e8e5-paas`，源提交 `d5784e8e5`）。
> **第二段（用户按选项 A 授权后）**：以自有账号 `aloadtree@gmail.com` 登录，在自有租户下新建专用走查房间 `zy_68aea26f922749debe`（走查结束已 `end`），并做订阅/召唤尝试；公开演示房间 `zy_42ce690574b5423bd2` 全程未触碰（`day_turns` 保持 8）。**未跑任何计费回合**。凭据只用于本次登录会话，未落盘、未回显、未入 artifact；临时会话文件已删除。
> 数据来源：① `paas` 仓源码 / 归档 change / docs ② `kubectl --context cheap-ts -n fd-prod exec platform-54c75c5c8d-6xtkw` 只读查询 `/data/cells/zhiyu.db` 与各 cell `data/data/fleets.db` ③ 公网 HTTPS 只读 GET 与 Playwright 浏览器眼 ④ `docs/registry-maintenance.md` ⑤ 授权后的同域 `fetch` 实测。
> **取证口径（1.4）**：只记录消息 `kind` / `seq` / 可见性标记 / 事件名 / 计数 / 时间戳；**不导出任何真实用户消息正文**，不含 PII。

---

## 1. 准备任务

### 1.1 环境与三元组 —— **DONE（授权后补齐）**

| 项 | 实测 |
|---|---|
| 环境 | 生产 `platform.finddatatech.cloud`；镜像 `ccr.ccs.tencentyun.com/yizuo/platform:sha-d5784e8e5-paas`（`fd-infra-deploy/all-services/prod/platform.yaml:57`） |
| 代码对齐 | `git merge-base --is-ancestor d5784e8e5 HEAD` → EXIT=0；`git log d5784e8e5..HEAD -- <智语链 9 文件>` → 空。**生产智语代码 == HEAD 智语代码**，无 undeployed 差，「随滚版班」在代码侧已销 |
| 客服班组种子 | `docs/fleet-templates/service-desk-fleet.seed.json`（7,672 B，3 岗：`service-lead` 客服组长 / `service-agent` 一线客服 / `service-qa` 质检员；`agents` 3 条） |
| 房间 | 公开演示房 `zy_42ce690574b5423bd2`（owner `zhiyu@finddatatech.cloud`，未触碰）；**走查专用房 `zy_68aea26f922749debe`**（owner `aloadtree@gmail.com`，reply_cap=3 / daily_budget_turns=20 / idleMinutes=60，走查后已 end） |
| 团队 | 无「客服班组」实化实例（只读扫 12 份 `fleets.db` 共 25 支团队均为历史验收/业务团队）。授权后 `GET /api/fleets/overview` 得 **50 支团队、17 支 active**，改用现役 `fleet_1793235503630_7n5a3u`「工单分诊集群·试跑」作为订阅/召唤标的；`fleet_1793334491977_xd4vmd`「壹座产品介绍」与 `fleet_1792727749453_3m1nel`「客服护航集群」均 archived |

→ 三元组：`ownerEmail=aloadtree@gmail.com` / `fleetId=fleet_1793235503630_7n5a3u` / `roomId=zy_68aea26f922749debe`。**团队形态与种子不同（改用现役团队），已在 design.md D7 与本档如实标注**；2.x 若坚持「客服班组」口径需先实化种子，本轮不做。

### 1.2 判据检查表（D4 等待上限：事件行 90s / 5s 轮询）

| # | 可观察产物 | 判据 | 超时口径 |
|---|---|---|---|
| 2.1 | fd-memory 落库行 | `turn`/`health` → `d/<packId>/<memberId>` own；`decision-*`/`swap` → `d/<fleetId>/shared`；legacy `f/` **零新写入** | 回合结束后 30s |
| 2.2 | 回合 fleetContext 快照 | 含三标签【本岗位记忆】【团队记忆】【历史团队记忆】；provider=null 时段缺席且回合不阻塞 | 单回合内 |
| 2.3 | 清史后首回合 fleetContext | 仍含上轮记忆（按 2.2 口径）且对话史为空 | 单回合内 |
| 2.4 | `GET /api/zhiyu/rooms/:id/fleet-subscriptions` 响应 | 返回新订阅；首见基线静默、无存量事件行涌入 | 订阅后 10s |
| 2.5 | 空间消息流 `kind=system\|event` 行 | 含来源标注（团队名+岗位）+时间+驾驶舱深链；密集合并；熔断期丢弃不补发、恢复后标注丢失量 | **90s / 5s 轮询** |
| 2.6 | 召唤响应 + 成员行 | 逐成员接受/拒绝/待答如实；persona 岗「去驾驶舱」；订阅同时建立；部分失败不掩盖 | 召唤后 30s |
| 3.1 | guest 席位 / iframe CSP / 浏览器眼 | 无 cookie 仍复用同一席位；429 双桶独立；frame-ancestors 按令牌白名单；无痕窗口真应答无登录墙 | 单次加载 30s |
| 3.2 | 消息流 `visibility` 列 | guest 与中途加入者流内零 `private:<id>` 行；私窗不进共享历史 | 单次拉取 |
| 3.3 | 计费/回合事件行 | @定向未点名座位零计费、pass/失败零计费、guest 按被点座位键结算带 guest scope；cap/budget 界内生效、界外被拒现值不变 | 单回合内 |
| 3.4 | 房间事件流 + IM 出站 | `meta.im` 行不回寄 IM；长消息切段；送达失败如实落流 | 单次投递 |

无「测试通过」类判据；每条都指向落库行 / 流内事件行 / 端点响应 / 页面呈现。

### 1.3 两条已知坑复核 —— **仍成立**

- `gateway/zhiyu/store.js:646-659`：`messagesAfter` 以 `return rows.map((m) => this._messagePublic(m))` 结尾 → 返回**数组**，不是 `{items}`。与 `add-zhiyu-team-memory/design.md:86` 一致。
- `gateway/fleet-room-bridge.js:20`：`import express from "express";` 显式 import 在位（gateway 内文件不共享 host 模块图）。与 `design.md:87` 一致。

### 1.4 取证口径

见文首。走查账号口径：既有测试租户，不导出消息正文。本轮**未执行任何生产写**，故无 PII 导出步骤。

### 1.5 8.2 覆盖范围（不重复劳动）

`openspec/changes/archive/2026-11-05-add-member-knowledge-profile/tasks.md`：`0.2 [x]` 存量 `f/` 页回填、`8.2 [x]` 真机冒烟（物化三成员团队 → 铸令牌 → 回合 capture 分流 → fleetContext 合流注入 → 运行时增删文档集 → oversight 下 owner 可读成员分区）、`8.3 [x]` validate 绿后归档；配套提交 `8b89c936c`（真 fd-memory + 真 paas 缝 HTTP，冒烟 9/9）。

→ 本单 **2.1 / 2.2 为回归**（按 11-05 新 scope 口径），**不是首验**；2.3–2.6 与 3.x 无既有真机覆盖。

---

## 2. 生产只读盘点（2026-11-06，`/data/cells/zhiyu.db`）

```
表 9 张：zy_rooms / zy_room_members / zy_room_messages / zy_room_invites /
         zy_widget_tokens / zy_widget_nonces / zy_owner_policies /
         zy_notifications / zy_fleet_subs

rooms            28（active 1 / ended 27）    owner: aloadtree@gmail.com 26、
                                              zhiyu@finddatatech.cloud 1、3106241601@qq.com 1
messages        266    kind: system 202 / event 27 / human 26 / agent 11
                visibility: shared 266（private:<id> 0）
members          92    user 29 / guest 34 / agent 25 / facade 4
widget tokens    31    embed 18 / link 13；revoked 25（active 6）
notifications    55    invites 29    owner_policies 1
zy_fleet_subs     0    ← 团队订阅从未在生产使用
```

**活跃房间**：`zy_42ce690574b5423bd2`「智语 · 现场演示」，owner `zhiyu@finddatatech.cloud`，`reply_cap=1`、`daily_budget_turns=60`、`day_turns=8`；席位 agent 4 / guest 20 / user 1。

**现役 widget 令牌**：`id=192c58071d18` → `room_id=zy_42ce690574b5423bd2`、`kind=embed`、`allowlist=["zhiyu.finddatatech.cloud","platform.finddatatech.cloud"]`、`revoked_at=null`。与公网实测一致：

```
GET https://platform.finddatatech.cloud/zhiyu/embed/wtr_192c5807…  → 200
Content-Security-Policy: frame-ancestors 'self'
  https://zhiyu.finddatatech.cloud  http://zhiyu.finddatatech.cloud
  https://platform.finddatatech.cloud  http://platform.finddatatech.cloud
GET https://zhiyu.finddatatech.cloud/  → 200（HTTP 80→443 308），data-room 真令牌在线
```

**system/event 事件分布**（`meta.event`，JS 侧解析）：

```
guest_joined 32 / member_joined 29 / room_created 28 / guest_greeting 28
room_ended 27 / invite_sent 25 / invite_accepted 25 / agent_failed 18
reply_cap_hit 5 / take_over 4 / all_passed 4 / needs_you 2
hand_back 1 / guest_identified 1
```

**关键阴性结果**：`zy_fleet_subs` = 0；`meta` 含 `fleet`/`team` 的消息行 = **0**；`kind=event` 的 27 行全是 `agent_failed`(18) / `all_passed`(4) / `reply_cap_hit`(5)，**无报数事件行**。即 `fleet-room-bridge` 的三类事件（报数摘要 / 待拍板 / 健康迁移）从未在生产流过一行。

**IM 桥痕迹**：`meta` 含 `im`/`platform`/`chatKey` 的消息行 4 条 → 入流造座有真实痕迹，但防回响/切段/送达失败无法从静态行判定。

**agent_failed 18 条**：`2026-10-26T21:09Z` ~ `2026-11-03T13:02Z`；近 24h **0**、近 7d **6**。原因分布：A2A 400 `model_not_available: qwen3.8-flash` ×4、A2A 429 ×3、A2A 502 ×1、A2A 503 ×2、`Connection error` ×2、`agent parked: key-invalid (INVALID_API_KEY)` ×1、A2A 405 ×4、`agent seat has no live deployment` ×1。属历史性上游波动，非当前故障。

---

## 3. 逐任务状态（授权后更新）

| 任务 | 状态 | 已有证据 / 阻塞原因 |
|---|---|---|
| 2.1 | **BLOCKED** | 三元组已补齐、凭据已有，但**桥路由不可达**（见 §2.5 的 P0）导致订阅/召唤链整体停摆；且跑三回合＝计费写，本轮未触发（授权范围内但不必要，因 2.4 已先失败） |
| 2.2 | **BLOCKED** | 同上；`fleet-context.js:402-421` 三标签梯子在码，但无回合快照 |
| 2.3 | **BLOCKED** | 需先跑 2.1/2.2 再清史重开 |
| 2.4 | **BLOCKED（实测 404）** | 授权后以真实浏览器同域 `fetch` 实测：`GET/POST /api/zhiyu/rooms/zy_68aea26f922749debe/fleet-subscriptions` 与 `POST .../fleet-summon` **全部 404 `{"error":"not found"}`**；房间本体 `GET /api/zhiyu/rooms/:id` 为 200、身份 `aloadtree@gmail.com` 一致。根因＝P0 路由注册顺序缺陷（§2.5），非授权或参数问题 |
| 2.5 | **BLOCKED** | 依赖 2.4；生产 `fleet|team` 事件行仍 0 |
| 2.6 | **BLOCKED（实测 404）** | 同 2.4；`dryRun` plan 请求也 404 |
| 2.7 | **DONE** | 本节 + 上节 + §2.5 即为七步证据汇总；每步有 BLOCKED 原因，零「推断成功」 |
| 3.1 | **PARTIAL → 本轮已复验** | Playwright 无痕浏览器眼：`zhiyu.finddatatech.cloud` 200、`#liveRoom` 真令牌在线、注入 **1 个 iframe** 指向 `platform.finddatatech.cloud`、`CONSOLE_ERRORS=[]`、无登录墙；CSP/令牌有效性另有 curl 实证。**未做**「访客发一句得真应答」（会触发一次计费回合，且 10-30 已有真域无痕窗口真应答档案） |
| 3.2 | **PARTIAL** | 生产 266/266 `visibility=shared`，零 `private:<id>` 行 → 无泄漏证据，但也无正向私窗样本，不能判「通过」 |
| 3.3 | **PARTIAL** | 现役房间 `reply_cap=1` / `daily_budget_turns=60` / `day_turns=8`；`reply_cap_hit` 5 行、`all_passed` 4 行 → 熔断有真实痕迹。计费归属需跨账本对账，未做 |
| 3.4 | **PARTIAL** | `meta.im` 类行 4 条 → 入流有痕迹；防回响/切段/送达失败需主动投递，未做 |
| 3.5 | **DONE** | 汇总即本节；缺陷单列见 §4 |

**共同阻塞已收敛为一条**：P0 路由缺陷使 `fleet-room-bridge` 的 4 条端点在生产全部不可达；在它修好之前，2.4/2.5/2.6 与依赖它们的 2.1–2.3 都不可能产出证据。这**正是本单要找的东西**——真机走查抓出了脚本套件与只读盘点都看不见的缺陷。

---

## 3.5 P0 缺陷实证：桥路由被 404 catch-all 吞掉

```
gateway/index.js:859   const zhiyu = registerZhiyuRoutes(app, {...})
                       └─ gateway/zhiyu/index.js:1236
                          app.all(/^\/api\/zhiyu(\/.*)?$/, (_req,res) =>
                            res.status(404).json({error:"not found"}))   ← 前缀 catch-all
gateway/index.js:878   registerFleetRoomBridge(app, {...})
                       └─ gateway/fleet-room-bridge.js:111/119/142/156 四条 /api/zhiyu/rooms/:id/fleet-* 路由
```

Express 按注册顺序匹配：catch-all 在 `registerZhiyuRoutes` 内先注册，`registerFleetRoomBridge` 在**之后**才挂到同一个 `app`，因此 4 条桥路由**永远不可达**。注释（:1233-1235）明写「The prefix is owned: unmatched /api/zhiyu/* paths must 404 here」，本意是防止未匹配路径误代理进 cell，却把自己的桥也挡了。

**三路交叉实证**：

| 路径 | 结果 |
|---|---|
| 公网 curl（带 `paas_session`） | `GET/POST .../fleet-subscriptions`、`POST .../fleet-summon` → 404 `{"error":"not found"}`；`GET /api/zhiyu/rooms/:id` → 200 |
| 浏览器同域 `page.evaluate(fetch(...))`（全 cookie，`/api/auth/me` = authenticated `aloadtree@gmail.com`） | 同上 4 个 404；`ROOM_GET` 200 |
| pod 内直连 `127.0.0.1:3100`（排除边缘/Caddy） | 同上 404；`rooms/:id` 200 → **排除边缘路由问题，确认为进程内注册顺序** |
| 本地最小复现 | 同一 Express app：先 `app.all(/^\/api\/zhiyu(\/.*)?$/)` 再 `app.get(".../fleet-subscriptions")` → **404**；去掉 catch-all → **200** |

**生产后果**：`zy_fleet_subs` 恒 0、`fleet|team` 事件行 0 —— 与只读盘点完全吻合。即 `add-zhiyu-team-memory` 刀B（团队订阅桥）自 10-30 归档以来**在生产从未可用过**，而 13 个 script 套件 + 2 个 e2e 全绿，因为测试直接把桥路由挂到独立 app 上，绕过了生产注册顺序（与 §15.84「测试绕过 registerAuth 中间件」同类）。

**建议修法**（另立 change，本单不改码）：把 `registerFleetRoomBridge(app, …)` 移到 `registerZhiyuRoutes(app, …)` **之前**，或把 404 catch-all 从 `registerZhiyuRoutes` 内提出、放到所有 `/api/zhiyu/*` 路由（含桥与 IM 桥）注册完成之后；并补一条「按生产注册顺序装配」的集成测试，防止回归。

---

## 4. 缺陷与观察清单（4.1、3.5）

| # | 级别 | 现象 | 证据 | 建议另立 change |
|---|---|---|---|---|
| O0 | **已解除（2026-11-07）** | `fleet-room-bridge` 的 4 条端点生产全部不可达：`registerZhiyuRoutes` 内的 `/api/zhiyu/*` 404 catch-all（`gateway/zhiyu/index.js:1236`）先于 `registerFleetRoomBridge`（`gateway/index.js:878`）注册，Express 顺序匹配把桥路由吞掉 → 团队订阅/召唤/报数事件行自 10-30 起从未可用 | 公网 curl + 浏览器同域 fetch + pod 内 :3100 直连 + 本地最小复现四路交叉；生产 `zy_fleet_subs`=0、`fleet\|team` 事件行 0 | **已由 `fix-zhiyu-fleet-bridge-route-order` 修复并上产归档**（opt-in `deferNotFound`，兜底改由 `zhiyu.registerNotFound()` 在桥之后、cell 代理之前收口）：镜像 `sha-1f9335b`（digest 5c862edc）、GitOps `4fbf889` 双清单、双 pod imageID 全等；真机复验 GET 200 / POST 订阅 201 / dryRun 召唤 200（summonable 空 + cockpitOnly 如实分诊）/ 非自有团队同形 404，`zy_fleet_subs` 0→1，报数+健康事件行带深链流入；spec `fleet-room-bridge` 新增「完整装配下可达」需求；全仓 255/255 绿 |
| O1 | P2 硬化 | `frame-ancestors` 含 `http://` 源：网关对非通配白名单同时产出 https 与 http 两条；父站 80→443 已 308、iframe 本身 https，两条 http 无正当用途 | `gateway/zhiyu/index.js:1023`；生产 CSP 响应头实测 | `harden-zhiyu-embed-csp`（产品代码，本单不改） |
| O2 | 观察 | 团队订阅桥生产零使用：`zy_fleet_subs`=0、报数/拍板/健康事件行 0 | 生产库只读盘点 | **已由 O0 解释并解除**（根因是路由不可达，不是没人用；修复后订阅 0→1、事件行流入，见 O0 行） |
| O3 | 观察 | 生产 266 条消息 `visibility` 全 `shared`，零 `private:<id>` 行 → 私窗从未落过行或存于别处；3.2 无法正向验证 | 生产库只读盘点 | 待 2.x 走查时一并确认 |
| O4 | 观察 | `agent_failed` 18 条（10-26~11-03，近 24h=0），多为 A2A 上游 4xx/5xx 与 parked key-invalid；对外演示房间首答体验有隐患 | 生产库 `meta.event=agent_failed` | 待 browser-eye 回归时复核，若复发再立案 |
| O5 | **已解除** | 原 `proposal.md` Impact 写「只读观察 / 对外影响：无」，而 2.1/2.4/2.6 实为生产写 + 计费回合 | `proposal.md:29-31` vs `tasks.md` 2.1/2.4/2.6 | 用户 2026-11-06 按选项 A 明确授权受限写并给出自有账号凭据；Impact 已改为「只读为主、辅以授权范围内受限写」，`design.md` Non-Goals 增「不触碰公开演示房间」 |
| O6 | P2 文案 | 官网称「两张服务智能体席位：产品向导与壹座专家」，生产 active 房间有 4 个 agent 席；`add-product-intro-team/tasks.md:21` 也记「四席真房间全活」 | `site-zhiyu/index.html:214`；生产 `zy_room_members` kind=agent n=4 | 待 browser-eye 回归时核对口径（可能是「只一张开口」的呈现口径） |
| O7 | deferral | `app-navigation/spec.md:4` Purpose「including the Bots entry」残留 | `align-yizuo-specs-to-reality/proposal.md:13` 自注「Purpose 层 chore」 | 随下次归档提交一行 chore 改，不单独立 change |
| O8 | **P1（修复已上产 2026-11-07，正路径待 O9）** | 召唤「可召唤」半边生产恒空：桥对 `sampleFleets()` 返回的 JSON 调 `.servingMembers?.(fleetId)`（`gateway/fleet-room-bridge.js:171`）——JSON 无函数、全仓零生产者；dryRun 如实报 `summonable=[]` 但**永远召不到任何人**，生产 4 cell 共 **10 支 a2a 部署岗**全部不可召 | 码锚 `fleet-room-bridge.js:171`（唯一引用）；测试 `test-fleet-room-bridge.mjs:166` stub 对 serving 路径返 null、断言「summonable=[] 诚实降级」——正路径零覆盖（与 O0 同款「测试绿、生产不可达」）；生产库 fleet_members target_kind='a2a' n=10 实测 | **`fix-zhiyu-summon-serving-face` 已 apply+上产**（镜像 sha-4d2dbfb、digest f3bf4f10、双 pod imageID 全等；GitOps 4f97953）：serving face 上线实证 + vacant 如实排除 + 执行段两死点（缺 idemKey/onBehalfOf 写死）修复；正路径真机验证阻于 **O9**（见下行），由测试全覆盖（bridge 10/10 + assembly 7/7） |
| O9 | **已解除（2026-11-07，fix-cell-catalog-a2a-face 上产）** | a2a 服务面在 facet catalog 统一后断供：`doFacetRefresh` 只拉 mcp+skills **不拉 agents** → cell 目录 a2a-mode 条目=0 → 全部 10 支 a2a 岗 status=vacant → servingPath=null；且本平台部署台账仅 1 行（ops-seed demo），a2a 岗的 pack 部署登记在萬星面账本（**账本分家**）；叠加 facet pod Error/Pending 故障（并发会话处置中）→ 台账缝 ECONNREFUSED | 新镜像真机 overview：7 支 a2a 岗全 `vacant`+`servingPath=None`；`/api/catalog` a2a-mode=0；pod 内 `FACET_CATALOG_URL` 已设 → 走 facet 源（registry-bridge.js:51-55 源选择）；pod 内读 /data/data/packs.db `pack_deployments`=1 行 | **已由 `fix-cell-catalog-a2a-face` 修复上产**（镜像 sha-d13fbc1、digest ec71a1cb、双 pod imageID 全等；GitOps f3149fb）：cell 目录 29 支 a2a 条目复活、7 支岗 servingPath 全解析、O8 正路径真机全判据过（fingpt 验证舰队 summonable 非空+执行邀请落库+订阅随行）；**O9b 账本归一仍为 Non-Goal**（萬星面部署要不要可召=用户拍板项） |

**零源码改动对账（4.1）**：`git status --short` 显示工作树有并发会话遗留改动（`Dockerfile`、`openspec/specs/agent-runner/spec.md`、`harden-windows-runner-smoke` 删除、若干 `scripts/tmp-*` 与截图/zip 未跟踪文件），**均非本单产生**；本单未触碰 `gateway/` / `web/` / `server/` 任何文件。收尾复核时 `git diff -- gateway/ web/ server/` 另见 `gateway/index.js` +7 行（`FACET_PROXY_TIMEOUT_MS` opt-in / `registerFacetProxy` timeout，mtime 2026-11-06 23:45），已核 diff 内容确认属**另一并发会话的 faceted-proxy 改动**，与本单无关、非本轮所为；本单自身产物仍为零源码。

---

## 5. 跨单 deferral 登记（4.4）

`openspec/specs/app-navigation/spec.md:4` 的 Purpose「including the Bots entry」残留，已在 `design.md` Non-Goals 与本节 O7 双处登记为**跨单 deferral**，理由：项目规则（`AGENTS.md`）要求 specs 只能经 `openspec archive` 更新，且本单 `skip_specs: true` 无 delta 通道；OpenSpec instruction 也明写既有 capability 的 delta `## Purpose` 被忽略，只能直接改主 spec。最省路径＝随下一次归档提交附一行 chore，不虚构需求、不单独立案。台账 §15.138 同步登记，避免下轮体检误判为未处理。

---

## 6. 结论与待办

- **已完成**：1.1 / 1.2 / 1.3 / 1.4 / 1.5、2.4、2.5、2.6、2.7、3.5、4.1、4.2、4.4、4.5、4.6（**15/23**，2026-11-07 O9 上产后 +2.6）。
- **未勾**：2.1–2.3（待真跑三计费回合）、3.1–3.4（部分证据在案）、4.3（5.2 未完成，归档件勾选**不得**假绿）。
- **本轮真机走查的核心产出**：抓出 **P0 缺陷 O0**（桥路由被 404 catch-all 吞掉），四路交叉实证 + 本地最小复现，解释了生产 `zy_fleet_subs`=0 与 `fleet|team` 事件行 0 的全部谜面。13 个 script 套件 + 2 个 e2e 全绿却漏掉它，与 §15.84 同类。**O0 修复上产后复验又抓出 O8**（召唤可召唤面恒空，同款测试盲区）——走查线连抓两缺陷，均以「spec 语义对、实现不可达」为共同形状。
- **授权后的实际动作**：登录 → 新建专用房间 `zy_68aea26f922749debe` → 订阅/召唤尝试（404）→ 结束该房间。公开演示房间 `zy_42ce690574b5423bd2` 未触碰（`day_turns` 保持 8）。**未跑任何计费回合**；凭据未落仓，临时会话文件已删。O0 修复复验另建专用房 `zy_1ad879f94b7f3248e3`（reply_cap=3/budget=20，复验后已 end，见修复单 evidence §8）。
- **解阻顺序（更新 2026-11-07）**：~~另立 fix-zhiyu-fleet-bridge-route-order 修 O0~~（**已归档**）→ apply `fix-zhiyu-summon-serving-face` 修 O8 并出片 → 2.6 执行半边 + 2.1–2.3 真跑回合 + 3.2–3.4 正向样本 → 最后勾 4.3。在此之前任何「5.2 已完成」的勾选都是假绿。
- **建议用户**：本次在对话中明文提供了账号口令，虽然未落盘/未入仓，仍建议**轮换该口令**；后续走查改用一次性会话或临时令牌更稳妥。

## O11 私窗发送面真机实证（2026-11-07，add-zhiyu-private-window-send 4.3）

- 生产镜像 `ccr.ccs.tencentyun.com/yizuo/platform:sha-56d6648`（digest `sha256:ba31dd21`，pod `platform-764df86d54-2k2v8` imageID 全等；源 paas `d6e22447c`）。
- 走查房 `zy_a8bbf967f023ad90d0`（owner `aloadtree@gmail.com`，dailyBudgetTurns=5）——**用后即焚**：`end` 200 + widget token 吊销 200；公开演示房 `zy_42ce690574b5423bd2` 全程未触碰。
- 正向样本：分身 `intro-lex`（真部署 `bTnrv2P_JhmCzqqXCF0GIA:intro-lex`，onBehalfOf 本人，auto_accept 即席）→ `POST /api/zhiyu/rooms/:id/private` 真回合 → **seq=12 agent 行落 `private:mem_bb352563a534e11a51`**，应答文本「私窗通道已打通，本分身已就席。」；吩咐行 3/6/10 同档。本人读面 private 行 6 条（2 吩咐+1 应答+2 失败事件+预算语义行）。
- 隔离判据：guest（widget 无痕席位 `g_356ee896d9`）读面 8 行 **0 私行**、guest SSE 流 0 私行；guest POST /private → 401、匿名 → 401（无 user seat）。共享流（visibility=shared）零 private 行。
- 日预算：`dayTurns 1/5`（应答回合计数；两次失败回合不计——「失败不结算」语义真机复证）。
- 如实记：`reception` 分身（`Ut_bJMuW5KxAD83KImPmlg:reception`）A2A 冷启动坏（registry GET /api/skills/corpus-company/content 404 ×2 回合，agent_failed 落 private 档——诚实失败面同时得到正向验证）；换 intro-lex 一次成功。此为座位供给侧既有问题，不在本 change 范围，挂账见台账续八。
- 凭据卫生：会话 cookie 落 /tmp 0600、用后即删；口令未落盘未回显未入 artifact。

## 3.4 IM 桥回写闭环（2026-11-07，Req5 第二半补齐）

- 防回响（Req3）：gateway 读面构造级排除 `meta.im` 行（`gateway/zhiyu/im-bridge.js` events filter），归档单 8.2(b) 生产实证（真实签名 webhook→房内行→读面 `rows:[]`）。
- 切段（Req5 前半）：cell 侧 `chunksFor` 3800 字符上限、署名随首段、顺序投递（单元 5.x 绿；§15.73 生产真 WeChat API 调用实证）。
- 送达失败如实（Req5 后半，本次补齐）：cell 侧 3 次重试耗尽 → `POST /api/zhiyu/im-bridge/rooms/:id/delivery-failed`（machine cred、10/min 限流桶）→ gateway 落 `kind=system`、`visibility=shared`、`meta={event:"im_delivery_failed", platform, chatKey, seq, reason}` 事件行；房间如实看到「为何群里没来回答」。测试 `5.x-b` 双腿（gateway 401/落行形状 + cell 重试后恰一次 POST），zhiyu 全套件 **49/49**。
