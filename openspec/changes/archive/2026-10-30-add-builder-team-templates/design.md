# Design: add-builder-team-templates

## Context

三块现状拼图：
1. **团队架构师**是唯一已成的 builder：bundled MCP（`server/fleet-architect-mcp.js`，五工具三段纪律）
   + 官方种子（`docs/fleet-architect.seed.json`，已按 v4 改名团队架构师）+ loopback 桥身份=cell owner
   （`platform.bundle.json` 注释即纪律）。它证明了这个模式可复制。
2. **蓝图 NL 起草**是纯文案流：`blueprints.draft.promptIntro`（你是蓝图构造师…）+ constraints 一段话，
   用户复制到任意会话、把 JSON 粘回池。没有工具面→没有「校验即反馈」回路，错误要等粘回构造间才见。
3. **通用 pack 创作**只有空表单编辑器（`PackDraftsView`）+ 分身工坊（只做 facade）。
   `facet-pack-builder`（用户侧 skill）与 `docs/creating-packs.md` 是知识源，但没有产品化入口。

## Goals / Non-Goals

**Goals**

- 三类创作各有官方对话式 builder，四员分工互斥、定位一句话说得清。
- 一切 builder 产出 = 草稿，走既有池/既有链/既有门；builder 本身不碰任何生效写面。

**Non-Goals**

- 不做可视化 pack IDE（编辑器已有，够用）。
- builder 不代发布/不代批准/不代铸造——发布门与双钥匙试跑闸是人的面。
- 不改架构师五工具与其纪律（它是模板，不是改造对象）。
- 不引入第二校验器、第二草稿池、第二调度器。

## Decisions

### D1 · 复制架构师模式，而不是发明新模式

两段新 MCP（`blueprint-author-mcp` / `pack-author-mcp`）按 `fleet-architect-mcp.js` 同款骨架：
薄声明层（工具名+纪律化 description）+ 业务在 bridge、loopback 桥身份=cell owner、
`platform.bundle.json` 登记 bundled 自激活。理由：该模式已被生产验证（bundled 种子自激活、
零新凭据），评审/测试基建现成。

### D2 · 蓝图构造师的三工具刻意窄

`blueprint_draft`（按 schema 组稿，纯构造无 IO）、`blueprint_validate`（调既有校验链返回逐字段原文
错误）、`blueprint_save`（过校验才落池）。**没有** approve/cast/trial/delete——批准闸与铸造是主人
在构造间的面（fleet-blueprint-studio 既有纪律），工具面少一个动词就少一条越权路径。

### D3 · 智能体作者写面走既有 REST 而非新存储

作者 MCP 调既有 `/api/pack-drafts*`（同 `requireMcpManage` 权限语义），manifest 组稿在工具内
预跑 `validatePackManifest` 才交付——草稿池零新表。MCP 引用只收市场目录条目名（与编辑器同一
「不能自带端点」边界），工具不提供自由 URL/command 字段。

### D4 · 分工互斥写进 persona，用测试钉住

四员 persona 各自带「我不做什么+该找谁」一句话（构造师→架构师、作者→发布门、工坊→facade 边界）。
单测断言 persona 文本含边界声明——文案纪律也是纪律。

### D5 · 创建入口接线用空态深链，不加导航项

三处创建空态（创建团队、pack 草稿、蓝图新建）的引导按钮深链到对应官方 pack 的安装/对话入口；
不加第四个导航项（团队导航项已承载综合看板/管理/驾驶舱三面，`add-agent-teams-first-class` D1
的同款克制）。

## Risks

- **两段新 MCP 的桥身份**：loopback=cell owner 是既有惯例，但新工具面写的是蓝图池/草稿池——
  单测必须钉「未过校验不落池」「无 approve 类工具」，越权面靠工具集窄化而非运行时拦截。
- **种子/locale 门扩容**：`official-locale-coverage` 门要纳入两份新种子（否则门与资产漂移）。
- **persona 文案与 promptIntro 收编**：现有 `blueprints.draft.promptIntro/constraints` 是精心校准的
  schema 纪律，构造师 persona 必须完整收编（不丢约束），构造间的粘贴提示词保留作为无 builder
  时的回落。


## Implementation Notes (apply 2026-10-30)

- **桥接身份照 architect 模式**：auth.js 豁免戳 `builder-author@internal` 占位（过总闸），
  两桥的 owner 由 `ctx.cellUserEmail` 服务端解析——桥子与调用方都无法指名身份。
- **蓝图画具必须说语料方言**：bridge 测试首版用 `{name,kind,server}` 形状的 dataSources 被校验链
  422——DRAFT_SCHEMA 的形状是 `{ref}`、acceptance 需要 `kind`（machine 两件套）、monitoring 是
  对象不是数组。复用链=吃链的方言，fixtures 从 corpus 抄。
- **pack save 的 manifest→draft 投影**：草稿是 entries 形状（skills/mcpServers/agents/guide），
  与 manifest 近 1:1——桥内投影，草稿池零新表、编辑器零改动。
- **测试 shared-store 陷阱**：两桥共用项目 DB，跨测试计数必须按 id 过滤，不能假设隔离。
- **locale 门立功**：纳入两份新种子的「全官方资产过 pack 校验器」用例随即逮到 #3 遗留的三处
  guide 步骤 3:1 比率超限（facade-builder/finddata-facade）与架构师种子缺 en.notes——全修。
  这正是「门要在资产入库前建好」的价值。
- 4.3 的 e2e（对话内起草→构造间同池）依赖铸造上架，随走查班补。
