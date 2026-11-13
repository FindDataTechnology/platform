## Context

见 `proposal.md — Why`。设计需要知道的当前状态与约束：

- 薄壳是**单文件换视图**：`App.tsx:52` 用 hash 路径部分匹配，`main` 全宽 `p-6`，无容器组件、无路由表。视图由 `ErrorBoundary key={view}` 包住。
- 两套宽度事实并存：`IntroView.tsx:56` / `DocsView.tsx:284` 是 `mx-auto max-w-3xl`；`McpCatalog.tsx:173` 是 `max-w-6xl`；其余全宽单列。
- `PackCard` / `PackMarketView` 与壹座 Store 共用（`web/src/pages/AgentMarketPage.tsx:191`），且 `e2e/facet-shell.spec.js:458/486` 钉住 `pack-facets` 容器与 `[data-line-count]` 属性。
- 创作台是**真身**：`facet/studio.js` 配独立 `studio-docs.db`、复用路由树与发布闸；`StudioView.tsx:54` 用 `MemoryRouter initialEntries=["/studio"+query]` 挂载，**无 `<Routes>`**，故 `AgentStudioPage` 内 `Link to="/agents?tab=build"`（`:689`）、`navigate("/fleets/<id>")`（`:541`）、`navigate("/agents?tab=market")`（`:604`）在谦面全是静默无操作。
- `facetShell.*` / `facetCurate.*` / `facetDocs.*` 三个 i18n 命名空间只被 `facet/web/src` 消费（`web/src` 内零引用），改名不影响壹座。
- 策划写接口已支持一次提交三字段：`packs-api.ts:673 setPackCuration(id, {category?, featured?, domains?})` — 运营台的「一次保存」无需后端改动。
- 事实单源已有漂移守卫：`scripts/test-facet-docs-facts.mjs` 断言 `cliFacts.ts` 与 `facet/cli/facet.js` 目标表相等。

## Goals / Non-Goals

**Goals:**

- 一个容器栅格，三种表面（内容型 / 列表型 / 三栏工作区）各自有明确的空间用法。
- 入口按"观众权重"分层：消费者只看到消费面，作者面与运营面收进账号控件但不丢深链。
- 嵌入面（创作台）的导航要么真跳、要么真外链，消灭静默无操作。
- 命名成为可测契约（五语 parity + 无未译词），而不只是文案偏好。

**Non-Goals:**

- 不改任何数据面/API 形状（市场、策划写、发布闸、注册处）。
- 不改壹座 Store 的呈现：共享组件的新布局以**默认关闭**的 opt-in 参数引入。
- 不重写 `AgentStudioPage` 的三栏语义、文档生命周期、校验链（`supply-studio` 既有条目不动，只补嵌入约定）。
- 不引入 UI 框架/组件库/路由依赖：`facet/web/package.json` 零新增运行时依赖。
- 不做独立文档站（另一部署面不在本变更内）。

## Decisions

### D1 · 单一容器组件，两种宽度档

新增 `facet/web/src/Container.tsx`：`wide`（列表与工作区，`max-w-[1600px] mx-auto`）与 `split`（内容型，栅格 `lg:grid-cols-[16rem_minmax(0,1fr)]`，左侧 rail 占位、右侧正文 measure 放宽到 `max-w-4xl` 且**居左**不居中）。`main` 只保留 `p-6` 与滚动，由视图自己声明档位。

**理由**：现在的病不是"有 max-width"，而是每条路由各写一个值（`3xl` / `6xl` / 无），彼此不一致且内容型把留白放在**两侧**（读起来像没做完）。`split` 让留白变成导航 rail，宽度有去处。

**备选**：① 保留各页自定宽度（现状，等于不解决）；② 全局 `container mx-auto`（列表页会变窄，反而更浪费）— 均否。

### D2 · `PackCard` 双形态，默认不改变壹座

`PackCard` 增 `layout?: "row" | "tile"`，**默认 `row`**（逐像素等于今天）。`tile` 形态竖排：印章在上、标题/版本一行、承诺 clamp 2 行、信号行、标签行；`PackMarketView` 增 `layout` 与 `filters?: "top" | "rail"`，同样默认等于今天。谦面传 `layout="tile" filters="rail"`，壹座不传。

**理由**：同仓 `AppCenterPage.tsx:287` / `FleetPage.tsx:429` 已是 `sm:grid-cols-2 lg:grid-cols-3`，卡片多列是本项目既有范式；而共用组件直接改会连带壹座回归面与「五槽位契约」的视觉验证。

**约束**：`tile` 必须保留五槽位（印章/标题+版本/承诺/信号/受众或标签）与 `pack-card-*` testid 前缀；`pack-facets` 容器与 `[data-line-count]` 属性在 `filters="rail"` 下**位置变、testid 不变**，让 `facet-shell.spec.js:458/486` 继续有效。

**备选**：① 分叉一份 `FacetPackCard`（两份实现必然漂移，违反 DESIGN.md「同一实现不得各写一份」的精神）；② 直接改共用组件（壹座被迫接受未验证的新布局）— 均否。

### D3 · 入口分层：`entries` 数据化 + 账号控件

`App.tsx` 的 `tabs` 数组改为三段：`publicEntries`（介绍/智能体市场/MCP 与技能/使用指南）、`signedInEntries`（+ 创作台）、`accountEntries`（我的发布、内容运营（仅管理员）、退出）。`View` 与 `VIEW_HASH` 不变（`#/mine`、`#/curate` 继续可解析、继续受身份闸）。账号控件是 `<details>`/按钮 + 菜单，不引入 popover 依赖，键盘可达 + `aria-expanded`。

**理由**：运营面只服务管理员的少数时刻，占着消费者的每一屏宽度；作者面两个入口语义重叠（草稿 vs 已发布是同一对象的两段）。降级但不删深链，e2e 与已有跨域回链（`#/studio?doc=`）继续成立。

**备选**：① 七个平铺（现状）；② 直接把 `#/mine` 合并进 `#/studio` 并删路由（外链断，且 `supply-studio` 的深链契约与之冲突）— 均否。

### D4 · 嵌入面：局部路由表 + 跨域真外链

`StudioView` 保持 `MemoryRouter`，但补一张**只含创作面自身**的局部路由表：`/studio`（工作区）。`AgentStudioPage` 增加可选 props 由宿主注入：
- `onExit`（宿主传「回智能体市场」）、`runOrigin`（已有）、`onCrossDomain`（宿主渲染真 `<a>`）。

派发规则：`Link to="/agents?tab=build"` → `onExit`；`navigate("/fleets/<id>")` / `navigate("/agents?tab=market")` → 真外链 `${runOrigin}/fleets/<id>`；其余文档内导航（`navigate("/studio?doc=…")`）留在局部路由表内。

**理由**：`facet-platform` 要求 shell 本身零路由依赖，`supply-studio` 要求深链在谦面域解析——两者的共同解是「宿主给局部路由 + 跨域一律外链」，而不是让借用视图在空路由表里假装能跳。

**备选**：① 在共用页里删掉这些按钮（壹座也失去入口）；② 给宿主挂完整路由表（要为 `/fleets`、`/agents` 造假页面）— 均否。

### D5 · 市场筛选上左栏（rail）

`filters="rail"` 时：搜索/尺寸/垂类/领域移入 `lg:` 起的 sticky 左栏；右侧卡片网格 `sm:2 lg:3 xl:4`。窄屏 rail 折叠成顶部可展开抽屉（与今天位置一致）。筛选状态继续走现有 URL query（`agents` 等参数不变）。

**理由**：顶部堆叠吃掉首屏约 1/3（两条 chip 轴 + 搜索行），而左栏是列表页的常规做法，且把"当前筛选"从三行压缩成一列可扫读。

### D6 · 运营台改主从 + 一次提交

左列表（搜索 + 分页 + 未归类/缺项两个筛选旋钮，`pageSize` 提到 200 并配分页），右面板承接单包编辑：垂类（**词表下拉**，与领域同一 vocabulary）、领域 chip（上限 3）、精选开关、覆盖度缺项、用量。底部一个「保存」调 `setPackCuration(id, {category, domains, featured})` 一次提交；未保存的改动在左列表行上打脏点，切行时提示。

**理由**：`setPackCuration` 已支持三字段同提交（`packs-api.ts:673`），当前三次点击是 UI 自造的；自由文本 slug 与词表 chip 混用让运营需要记住 slug。

**备选**：① 保留行内编辑（行数一多就没有纵向空间放详情）；② 表格式批量编辑（需要新交互范式与批量接口，超出本次）。

### D7 · 文档：站内索引 + rail 目录 + 客户端搜索

`DocsView` 改 `split` 容器：左 rail = 目录（四类读者入口 + 四节 + 当前节高亮，`IntersectionObserver` 驱动，不写 hash），右 = 正文。搜索为纯客户端：从 `facetDocs.*` 的文案键与标题建内存索引，过滤后高亮命中的小节标题并滚动（零新依赖、零请求）。深度指南：站内每客户端补一节「原生配置片段 + 常见错误」，公开仓链接降级为次级「源码与完整指南」。

**理由**：`cliFacts.ts:27` 的 `github.com/.../blob/main/docs` 在客户网络里常常打不开，而这一页正是"装不上时最后会点的地方"；同时 spec 现在把"public repository"写成**唯一**深度指南路径，必须改成"不得只存在于站外仓库"。

**权衡**：站内补 6 客户端 × 5 语的文案是本变更里最大的一块纯文案工作量；接受，因为它把"点开就超时"变成"点开就有答案"。

### D8 · 命名成为可测契约

i18n 键从 `facetShell.tabs.*` 改为 `facetShell.entries.*`（含 `account.*`），五语同改；新增单测 `scripts/test-facet-shell-labels.mjs`：① 五语键集相等（复用 `check-locales.js` 机制）；② zh-CN / es / fr / ja 的 `entries` 与 `account` 值不得等于 en 源串，且 zh-CN 不得含除 `MCP` 白名单外的拉丁词；③ 断言 `facetDocs.*` 里对作者面的指代与 `entries.mine` 同字。

**理由**：命名是这次改动里最容易在后续迭代中被悄悄改回去的一项（历史上 `Studio` 就是这么留下来的）。让它进单测，才叫"优化好"。

### D9 · `DESIGN.md` 同步登记

按 `facet/web/DESIGN.md` §1/§2 自身的纪律，登记新增的任意值（容器 `max-w-[1600px]`、rail 宽 `16rem`、tile 承诺行数 clamp）与新增微标；补一节「容器与表面」把 D1 的三档写成呈现律。

## Risks / Trade-offs

- **e2e 文案断言会红**（`facet-shell.spec.js:354` `/我的智能体|My agents/`、`:378` `查看我的智能体…`）→ 与实现同批更新断言；`pack-*` / `facet-curate-*` testid 一律不动。
- **共用组件的 tile 形态未经壹座验证** → 默认 `row` + 新增谦面专项 e2e（1440/1920 两档断言列数），壹座快照类测试零改动。
- **左栏筛选在小屏挤压正文** → `lg:` 才出 rail，`<lg` 折叠回顶部抽屉，与今天位置一致；e2e 保持 `pack-facets` testid 在两种布局下都挂。
- **`AgentStudioPage` 增加注入 props** 会碰壹座共用页 → 全部 `?`，不传即等于今天；壹座单测不需改。风险在于后人给该页加新导航时又写裸 `Link` → 在 `design.md` D4 之外，落一条注释 + 在 `supply-studio` 加了「不存在静默无操作」的要求兜底。
- **文案工作量（6 客户端 × 5 语）可能拖长** → 允许分两步交付：rail 目录/搜索/读者入口先行，站内原生配置小节随后同批补齐（tasks 里分两条，验收分开）。
- **`#/mine` 降级后用户找不到「我的发布」** → 账号控件带文字标签（不只头像图标），并在创作台内提供「已发布」入口；首次登录后菜单项带一次性提示点。

## Migration Plan

无数据迁移、无后端改动。发布顺序：① i18n 与入口结构（同时改 e2e 断言）→ ② 容器与列表布局（纯 CSS/组件属性）→ ③ 创作台注入与死链收口 → ④ 文档重做（可拆两次发布）。回滚：每一步都是前端单文件级改动，`git revert` 对应提交即可；`#/mine`、`#/curate`、`#/studio` 三条 hash 在全部步骤中始终可解析，故任一步回滚不会产生 404。

## Open Questions

无（影响 spec / 方案 / 任务切分的问题已在提案阶段与你确认：命名集、IA 分层、空间全套重排、文档站内重做）。
