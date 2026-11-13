# Proposal: add-agent-builder-workspace

## Why

智能体构建器、蓝图构造间、智能体团队是平台的核心创作链，但今天它们是 4 条路由 / 3 个落点、一页里并排两套编辑器、两条互不相认的生命周期。生产实拍已证其害：在工作室「团队结构」页签编辑盘上蓝图时，右侧检查器校验的是另一份空的内存态文档（错位）；空态文案「校验→试跑→批准→铸造」与服务端强制真序（批准→铸造→试跑在铸后→签字→重封）相反，会把用户引向 409。这是最重要的核心功能，布局与交互必须收敛为：一个文档、一条生命周期、一次从创作到运行的闭环。

## What Changes

- **统一创作工作区**（/studio 重建）：左栏文档库（智能体/团队文档统一列表，状态徽章）、中栏画布（编辑选中文档：岗位三桶卡 + 团队结构图）、右栏检查器（**永远跟随画布选中对象**：生命周期 ribbon / 规格书 / 校验清单）。
- **工作文档持久化**：工作室文档不再是内存态（设计 D1 废止），自动保存为蓝图草稿记录（`content.kind = agent | team`，单智能体用轻骨架）。**BREAKING（行为）**：离开页面不再丢工作；新建即落盘为草稿。
- **一条生命周期 ribbon**：按 kind 如实渲染服务端真状态机（agent：草稿→发射口；team：草稿→批准→铸造→试跑→签字→重封→部署团队），散落的发射/闸位按钮列退役；空态文案错误随批修复。
- **校验可行动**：findings 携带稳定 `code`（原文不动，「发布门原文」教义保留），客户端 code→五语摘要，点击错误行定位并聚焦出错字段。
- **可写团队结构图**：画布内一等卡片，复用 FleetCanvas 设计模式的草稿通道纪律（拖线产 draft 边、dry-run、显式确认、退出即弃），落 `content.fleet`；折叠只读图退役。
- **三面闭环**：铸造成功→「部署团队」（from-template，出生 paused）→ /fleets/:id；团队详情新增「来源蓝图」芯片→ /studio?doc= 续编辑（改动后 ribbon 自动回到重封档）。
- **导航 IA**：「蓝图构造间」导航项从 factory preset 摘除（注册表 slug 与 /blueprints 重定向保留，存量深链不炸）；「构建」family 改为 构建器+团队；/agents 构建区从 hero 卡升级为最近文档板；深链契约 `/studio?doc=|fork=|from=`。
- **AI 起草评审化**：右侧浮层 + 逐字段采用/跳过（「人的采用是唯一写入门」纪律不变，粒度变细）；team kind 起草随后批次。

## Capabilities

### New Capabilities

- `agent-builder-workspace`：统一创作工作区——文档库、上下文跟随检查器、生命周期 ribbon、自动保存与版本冲突、错误锚点定位、深链契约、铸造→运行→回编辑闭环、空态与窄屏态。

### Modified Capabilities

- `agent-document`：Agent Document 的持久形态 = 蓝图草稿记录（kind 派生字段）；「发射为蓝图」从发射口改为文档自身持久化，其余三发射口（预设/草稿包/团队模板）与「编辑器合流不合流生命周期」教义不变。
- `fleet-blueprint-studio`：工作面由工作区统一承载（团队模式页签退役，蓝图专属段成为 team kind 文档的画布段）；草稿自动保存为草稿池记录（「批准前市场/铸造仓/集群零落地」教义逐字保留）；findings 增稳定 code。
- `agent-builder-hub`：构建区承载物从直达卡改为最近文档板 + 新建智能体/新建团队入口。
- `sidebar-nav-families`：「构建」family 成员改为 builders(agents) + teams(fleets)；blueprints 不再入 family。
- `layout-configuration`：factory preset 的 nav 列表不再含 blueprints（注册表条目保留以兼容存量预设与深链）。
- `studio-ai-drafting`：采用面从整稿一次性采用改为逐字段评审采用（采用是唯一写入门、取消零污染两条纪律不变）。

## Impact

- **web**：`pages/AgentStudioPage.tsx`（重建为工作区）、`components/studio/*`（BlueprintTeamMode 并入；AgentBucketsEditor 保留共享）、`pages/AgentsPage.tsx`（构建区）、`components/Sidebar.tsx` + `packages/core/src/lib/surfaces.ts`（NAV_FAMILIES/FACTORY_PRESETS）、`lib/blueprint-api.ts`/`packs-api.ts`（kind/code/锚点）、FleetCanvas 复用、五语词条、`e2e/layout.spec.js` + 新增工作区 e2e。
- **server**：`server/routes/blueprints.js`（agent 骨架、kind、findings code、试跑在途态暴露）、`server/blueprint-validate.js`（kind 感知放宽、稳定 code）、`lib/pack-manifest.js`（skills 入蓝图 content、code 同源）。无新端点（试跑态走详情读面）、无 DB 迁移（content 开放形态）。
- **词表/i18n**：新 UI 词（文档/工作区/档位名）过 native-lexicon 登记；check:locales 五语门。
- **不动**：市场发布闸、铸造双钥匙、试跑收证窗口（blueprint-trial-bounded-fire）、fork 血缘管线、驾驶舱运行面。
