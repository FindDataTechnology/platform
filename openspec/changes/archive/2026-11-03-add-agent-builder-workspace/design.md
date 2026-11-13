# Design: add-agent-builder-workspace

## Context

见 proposal.md - Why。读码与规格勘察补充的关键现状（设计以此为地基）：

- 工作室文档是**纯内存态**（`AgentStudioPage.tsx` 设计 D1），蓝图是盘上实体（blueprints.db，乐观锁 `expectVersion`，状态 draft/approved/cast）。
- 工作室「团队结构」页签内嵌 `BlueprintTeamMode`（第二编辑宿主），但右检查器恒渲染工作室文档的规格书与校验——生产实拍证实错位迷惑。
- 服务端真状态机与 UI 文案相反：approve 要求校验全绿（422 短路）；cast 要求 approved 且仅批准人（403）；**trial 要求 status=cast（409「先有包才能装台」）**；签字后可重封（reseal 走 cast 路由）。空态文案「校验→试跑→批准→铸造」在撒谎。
- `agent-document` 主 spec 已立法「一文档四目标、编辑器合流而生命周期不合流」——本设计是该脊梁的落面，不与之相悖。
- `fleet-blueprint-studio` 的「批准前零落地」禁的是市场包/铸造 manifest/集群三实体；blueprints.db 草稿记录本就是创作面存储，自动保存不违宪（D2 记账）。
- FleetCanvas 已具备设计模式全套交互原语（拖线连边、draft 边虚线、点边检查器、位置 localStorage 按舰队持久化、`add-fleet-canvas-drag` 声明零污染先例）。
- `BlueprintContent` 为开放形态（`[key: string]: unknown`），补 kind/skills/tags/provenance 无 schema 迁移；`shapeFindings` 只查凭据+数据源，不强制 fleet——单智能体骨架放宽成本≈零。
- 校验 finding 现为纯英文原文（`error` + 可选 `entry`），无稳定 code；发布门教义「原文不改写」。
- 设计系统原语已就位：`ui/` 九件（status-pill / confirm-dialog / toast v2 / states-kit / tabs / tooltip…）、statusTokens、g-nav。
- `/fleets`（2308 行）与创作面零互链；from-template 出生 paused 带待启动横幅是既有约定。

## Goals / Non-Goals

**Goals:**

- 一个文档（持久）、一条生命周期（ribbon 如实镜像服务端）、一次闭环（创作→铸造→部署→回编辑）。
- 检查器与画布零错位；校验错误可行动（定位 + 摘要 + 原文并存）。
- 全部复用：三桶卡、规格书、FleetCanvas 设计模式、from-template、既有校验链——**零第二造**。
- 存量行为安全：老蓝图（无 kind）= team 缺省；老深链全可达；市场/铸造/集群闸位逐字不变。

**Non-Goals:**

- 不动驾驶舱运行面（fleet-ops-canvas / 决策车道 / 报数归因）。
- 不动市场发布流、pack 版本不可变、fork 血缘管线（只链接它们）。
- 不做试跑机制改造（blueprint-trial-bounded-fire 原样）；不做 judge 模型/车道。
- 不做多设备同步/文档协作（冲突处置只做单用户多标签的乐观锁面）。
- 不改代码层 `packs.*` i18n 键与 API slug（词表 v4 治理照旧）。

## Decisions

**D1 · 统一对象 = 蓝图草稿记录，kind 显式存储。**
工作室文档不再独立存在：打开工作区即打开/新建一份蓝图记录，`content.kind = "agent" | "team"`，缺省（存量）= team。
*备选*：(a) 新建独立 documents 表——多一套存储与校验接线，违零第二造；(b) kind 由结构推导（有 fleet=team）——用户想建「先有 1 岗的 team」时推导抖动，且创建意图不是派生徽章。显式字段胜。
单智能体用轻骨架（无 boundary/fleet/acceptance），`skeletonContent` 增加 `kind` 参数；校验器对 agent kind 跳过 fleet 段（parseFleetTemplate 不跑），manifest 段与凭据/数据源闸两 kind 全量照跑。

**D2 · 自动保存只写草稿池，教义逐字保留。**
「批准前零落地」条款原文只禁市场/铸造仓/集群三实体；草稿池记录是创作面自身存储。设计在 spec 场景里把这条界线写明（「自动保存只落草稿池」），防止后人把 autosave 误读为违宪或把草稿池滥用为落地口。防滥用：agent kind 文档永无 approve/cast 按钮（ribbon 不渲染团队档），服务端对 agent kind 的 approve/cast 直接 409。

**D3 · ribbon 是服务端状态机的同态投影，不是新闸。**
前端只读 `status + approvedBy + trialReport + version` 计算档位与下一步；不新增任何客户端裁决。试跑在途态：`trialRunning` 是进程内存单飞——经详情读面暴露 `trialInProgress` 布尔（服务端在 trial 路由设置/清除，进程重启自然消失，重试点亮无害），UI 轮询详情而非新增端点。车道 503/502 失败如实红 + 重试；「评测没跑成≠通过」进验收场景。
*备选*：DB 标志位——崩溃后残留脏标志反而要清理，内存态 + 读面暴露已够诚实。

**D4 · 检查器恒等于「画布正在编辑的文档」。**
错位根因是两宿主共享右栏但文档态不共享。D1 消灭两宿主后，检查器三段（ribbon/规格书/校验）全部从当前文档派生。画布内选中（岗位/工具/边）只做联动高亮，不改变「校验属于文档」的语义。

**D5 · 错误 code 是附加字段，映射表在客户端。**
`validatePackManifest` 与 `blueprint-validate` 的每条 finding 增加稳定 `code`（如 `name_too_long`、`pack_needs_one_reference`、`handoff_cycle`），原文 `error` 逐字不动（发布门教义）。客户端 `error-codes.ts` 映射 code→五语摘要；未知 code 回落原文。
*备选*：服务端按 locale 出摘要——校验器在 facet/铸造/市场多面共用，出文案改语言层会把校验器变成 i18n 面，否决。code 同源生成（校验器内联），杜绝「展示面猜码」。

**D6 · 可写团队图 = FleetCanvas 设计模式的文档适配器。**
新增薄适配层：输入 `content.fleet`（members 由 agents + pack 引用投影），输出 draft 边/节点变更，确认动作 = 把 draft 并入 content 并跑同一校验链（dry-run 即 validate 端点），非法即拒并锚定边。位置 localStorage 键从 `fleet:<id>` 扩为 `doc:<id>` 同构复用。@xyflow 重 chunk 维持路由级懒加载。
*备选*：studio 自造简版 SVG 可写图——两套图交互永远漂移，违零第二造；只读图维持——岗位编排是团队文档的主编辑对象，只读等于没有。

**D7 · 闭环走既有通道，回链靠 `_casting`。**
「部署团队」= `POST /api/fleets/from-template`（packId=castPackId），出生 paused，成功 navigate `/fleets/:id`。回链：团队详情读 manifest `_casting.blueprintId`（铸造追溯已有）→「来源蓝图」芯片 → `/studio?doc=`。不新增端点、不新增字段。已铸文档续编辑 = 正常 autosave；ribbon 依「version > cast 时版本」判重封档（服务端已有 reseal 语义，UI 只是显性化）。

**D8 · 导航退役走 preset 层，注册表不动。**
`blueprints` 留 NAV_SURFACES（存量预设/深链合法），从 FACTORY_PRESETS 两档 nav 列表移除；`/blueprints` 重定向保留。family「构建」成员改为 [agents, fleets]。
*备选*：删注册表 slug——validatePreset 会拒存量预设，炸用户布局，否决。

**D9 · hub 构建区 = 最近文档板，读既有列表端点。**
`GET /api/blueprints` 已返回 name/status/version——板子只是呈现层（top6 + status-pill + 两新建入口 + 全部入口）。hub「四区只是重组承接、不引入新数据形状/端点/校验器」条款因此不破。

**D10 · AI 起草浮层化 + 逐字段评审卡。**
从头部横条改为右侧浮层（与检查器同层互斥显示，画布不缩）；产物渲染为评审卡（每字段 采用/跳过 + 全部采用）。采用仍是唯一写入门（spec 同步 MODIFIED）。team kind 起草复用 blueprint-author 桥（`/api/studio/draft` kind 参数已留位），批次 3。

**D11 · 路由分工：/studio 恒为工作区，/agents 恒为总览。**
遵守已上线 hub 裁定「/studio 保持独立路由（全宽三栏不内嵌）」：构建区板子链入 /studio，工作区顶部返回链回 /agents。不内嵌、不合并路由。

**D12 · 冲突 UX：横幅 + 破坏性确认。**
409 时横幅二选项：「刷新查看」（拉服务端覆盖本地，本地 diff 先 toast 摘要）/「以我为准」（confirm-dialog 后以当前 version 强写）。默认永不静默。多标签软锁（BroadcastChannel）留批 4，409 横幅在批 1 即兜底。

## Risks / Trade-offs

- [autosave 写放大（每键一 PUT）] → 防抖 1.5s + 在途单发合并；PUT 本体是既有乐观锁面，服务端零新压力面。
- [kind 放宽让 agent 文档误入团队闸] → 服务端对 agent kind 的 approve/cast 显式 409（不靠 UI 藏按钮）；测试钉住。
- [FleetCanvas 在 /studio 的 chunk 成本] → 维持懒加载 + 编辑态进入才拉；走查记录首屏耗时不劣化（度量门）。
- [code 映射表与校验器漂移（改文案不改码）] → code 内联在生成点 + 单测对表（每条 code 恰一摘要键，五语齐全走 check:locales）。
- [hub/layout/families 三处 spec 同批改，归档冲突] → 按依赖序归档（hub→families→layout→workspace→其余）；MODIFIED 全带既有场景（差集纪律）。
- [生产实拍里「37 待决」等运行面徽章依赖 /fleets 不动] → 本 change 对 FleetsPage 只加一芯片一按钮，运行逻辑零触碰。
- [试跑在途布尔经进程重启丢失 → UI 假「空闲」] → 可接受：重试点亮本就幂等安全（trial 路由自设单飞）。
- [老用户习惯「蓝图构造间」入口] → 深链 + legacy query 映射保留；词表登记新词，公告随出片台账。

## Migration Plan

1. **服务端先行**（批 2 件：kind/轻骨架/code/trialInProgress 全为附加字段，旧 UI 对新服务端零感知）→ 出片验证存量蓝图行为不变（回归走查 + validate --specs 对齐）。
2. **web 跟进**（批 1/3 前端）：新 UI 对老服务端降级——无 kind 视为 team、无 code 回落原文（不猜纪律）。
3. 每批独立出片（fd-build-channel 判路 → 快照 → GitOps bump → 核 imageID 假绿律）+ 真机走查腿全绿才进下一批。
4. **回滚** = 回退部署清单镜像；服务端字段附加式，回滚无数据清理（kind/code 留在 content 内无害）。

## Open Questions

- 多标签软锁的最终形态（提示 vs 只读接管）——批 4 前不影响任何契约。
- 官方 starter 模板作为文档种子的清单——批 4 与货架侧一起定。
- 指标埋点形态（首次发射耗时/错误消解率取数口）——批 4 定，规格只要求可度量。
