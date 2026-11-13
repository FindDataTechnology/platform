## 1. 命名与入口结构（facet 壳）

- [x] 1.1 i18n 键从 `facetShell.tabs.*` 迁到 `facetShell.entries.*`（intro/packs/mcp/docs/studio）+ 新增 `facetShell.account.*`（mine/curate/logout/menuLabel），五语同步改值：介绍 / 智能体市场 / MCP 与技能 / 使用指南 / 创作台 / 我的发布 / 内容运营；验证：`node scripts/check-locales.js` 通过，且 `grep -rn "facetShell.tabs" web/src facet/web/src` 为空。
- [x] 1.2 新增单测 `scripts/test-facet-shell-labels.mjs`：五语键集相等、非 en 语不得等于 en 源串、zh-CN 除 `MCP` 白名单外不得含拉丁词、`facetDocs.*` 对作者面的指代与 `entries` 同字；验证：该单测在既有单测套件里跑绿，故意把 `entries.studio` 改回 `Studio` 时变红。
- [x] 1.3 `App.tsx` 把 `tabs` 拆成 `publicEntries` / `signedInEntries` / `accountEntries`，渲染 tab 行 + 账号菜单（按钮 + `aria-expanded` + `aria-current`，键盘可达）；`#/mine`、`#/curate`、`#/studio` 三条 hash 与身份闸保持不变；验证：匿名只见 4 个 tab、登录多创作台、管理员在账号菜单见到内容运营，手敲 `#/mine` 仍进作者面。
- [x] 1.4 更新 `e2e/facet-shell.spec.js` 的文案断言（`:354`、`:378` 的 `/我的智能体|My agents/` 一类）到新文案与账号菜单路径；验证：`npx playwright test e2e/facet-shell.spec.js` 绿。

## 2. 容器栅格与列表布局

- [x] 2.1 新增 `facet/web/src/Container.tsx`（`wide` / `split` 两档），`App.tsx` 的 `main` 去掉隐形全宽假设，各视图按档位自声明；验证：1440 与 1920 两档截图/断言下，没有任何视图出现「两侧同时大留白」。
- [x] 2.2 `IntroView` 改两栏（左文案 + 路径图，右卡片区平铺），`PageFooter` 在 `wide` 档下三列不再挤在 768px 内；验证：1920 视口下 intro 内容占满容器、三列页脚每列 ≥240px。
- [x] 2.3 `PackCard` 增 `layout?: "row" | "tile"`（默认 `row`，逐像素等于今天）并保留五槽位与 `pack-card-*` 前缀；验证：壹座侧不传参数时快照/断言零变化，谦面 tile 形态单测覆盖槽位渲染。
- [x] 2.4 `PackMarketView` 增 `layout` 与 `filters?: "top" | "rail"`（默认等于今天）；`rail` 档把搜索/尺寸/垂类/领域移入 `lg:` 起的 sticky 左栏，卡片网格 `sm:2 lg:3 xl:4`，`<lg` 折叠回顶部抽屉；验证：`pack-facets` testid 与 `[data-line-count]` 在两种档位下都挂（`facet-shell.spec.js:458/486` 不改仍绿），1920 下断言列数 ≥3。
- [x] 2.5 谦面 `#/packs` 接上 `layout="tile" filters="rail"`；验证：新增谦面专项 e2e 在 1920 断言 ≥3 列、在 375 断言单列无横向滚动。

## 3. 创作台嵌入与死链收口

- [x] 3.1 `StudioView` 补局部路由表（仅 `/studio`），保留 `studioQueryFromHash` 深链转发；验证：`#/studio?doc=<id>` 打开对应文档且宿主顶层 hash 不长出第二个视图。
- [x] 3.2 `AgentStudioPage` 增可选注入（`onExit` / `onCrossDomain`），把 `:689` 返回、`:541` 集群跳转、`:604` 市场跳转按 design D4 派发；不传即等于今天；验证：壹座侧单测零改动通过，谦面嵌入态点返回回智能体市场、点集群以新目标打开壹座。
- [x] 3.3 去掉 `StudioView.tsx:55-59` 的冗余标题条，让创作面只剩一层 chrome，画布宽度按 design D1 放开；验证：1080p 下画布可用高度增加且只有一行工具栏。
- [x] 3.4 补一条 e2e：嵌入态下导航控件要么改变宿主视图、要么发生浏览器导航（覆盖 `supply-studio` 新加的「不存在静默无操作」）；验证：该用例在故意移除局部路由表时变红。

## 4. 运营台（内容运营）

- [x] 4.1 `CurateView` 改主从：左列表带搜索、分页（`pageSize` 提到 200 + 分页控件）、未归类/缺项两个筛选旋钮与总数；右面板承接单包编辑；验证：造 >200 个包的 stub 数据时第 201 个仍可达（今天 `pageSize: 100` 会丢）。
- [x] 4.2 垂类从自由文本改词表下拉（与领域同一 `getPackFacets` vocabulary），领域 chip 保留上限 3；验证：词表不可用时下拉禁用并给出降级文案，不再出现自由输入框。
- [x] 4.3 一次提交三字段：底部「保存」调 `setPackCuration(id, {category, domains, featured})`，左列表行打脏点并在切行时提示；验证：改三处后只发一次请求（网络断言）且回读为已提交态。
- [x] 4.4 同步更新运营台 e2e（`facet-shell.spec.js` 的 curate 段：`:526-535`、`:625-642` 的行内编辑路径）到主从路径；验证：整套 facet-shell 用例绿。

## 5. 使用指南（文档）

- [x] 5.1 `DocsView` 改 `split` 容器：左 rail = 四类读者入口（只想装 / 要发布 / 要接 MCP / 站内导航）+ 四节目录，当前节由 `IntersectionObserver` 高亮，不写 hash；验证：滚到 MCP 节时目录标记切换，URL hash 不变。
- [x] 5.2 新增「站内导航」节：用 viewer 语言说明每个入口干什么、走哪条路（这一节是现在完全缺失的那层）；验证：五语键齐，`check-locales` 通过。
- [x] 5.3 深度指南站内化：每客户端补「原生配置片段 + 常见错误」小节，公开仓链接降级为次级入口；同步 `facet-platform` delta 的「不得只存在于站外仓库」；验证：断开公网只留本机服务时，六个客户端页各自仍有可用的配置说明。
- [x] 5.4 客户端搜索：从 `facetDocs.*` 文案键建内存索引，过滤命中小节并滚动定位，零新依赖零请求；验证：搜「cursor」命中 Cursor 小节，搜不存在的词给出空态文案。
- [x] 5.5 更新 `facet-shell.spec.js` 的 docs 断言（`.getByTestId("docs-nav")` 等）到 rail 结构；验证：相关用例绿。

## 6. 文档纪律与回归

- [x] 6.1 按 `facet/web/DESIGN.md` §1/§2 自定纪律登记新增项（容器 `max-w-[1600px]`、rail `16rem`、tile clamp 行数、新增微标），并补一节「容器与表面」把三档写成呈现律；验证：DESIGN.md 的清单与代码里出现的任意值一一对应（无未登记项）。
- [x] 6.2 全量回归：`node scripts/check-locales.js`、`scripts/test-facet-docs-facts.mjs`、新增 labels 单测、`npx playwright test e2e/facet-shell.spec.js`；验证：四项全绿，且 `#/`、`#/packs`、`#/mcp`、`#/docs`、`#/studio`、`#/mine`、`#/curate` 七条 hash 逐条手测可解析。
- [x] 6.3 `openspec validate overhaul-facet-shell-ia-and-space --strict` 通过；验证：命令零 error。
