# Tasks: add-facet-docs-view

## 1. 事实单源（防漂移机制先建）

- [x] 1.1 `facet/cli/facet.js` 导出 `SKILLS_SUBDIR`（`MCP_TARGETS`/`targetDir` 已导出/可导出）；行为零改
- [x] 1.2 `facet/web/src/cliFacts.ts` 扩为客户端事实表：`FACET_CLI_PACKAGE`/`FACET_INSTALL_COMMAND`/`FACET_CONNECT_COMMAND`/`FACET_TARGETS`（五客户端：label、技能目录展示路径、MCP 配置文件展示路径、target flag）+ 公开仓深度指南 URL 构造
- [x] 1.3 新单测 `scripts/test-facet-docs-facts.mjs`：导入 CLI 模块 + cliFacts，断言目标集合全等、每客户端技能目录全等（假 FACET_HOME 调 `targetDir` 真路径互证）、MCP 配置文件路径全等、命令含包名与子命令

## 2. DocsView 视图

- [x] 2.1 `facet/web/src/DocsView.tsx`：三块结构（安装/MCP 接入/创作）+ 块间锚点导航；静态无 fetch
- [x] 2.2 安装块：壹座卡片置顶+默认选中；五客户端 tab 切换（视图内态，不新增 hash）；每页命令/技能目录/MCP 配置文件/深度指南链接
- [x] 2.3 MCP 接入块：wgk-key 通用路径（铸键→connect→install --write-mcp）+ OAuth 发现路径（401 resource_metadata→发现文档；零贴依客户端支持，DCR 未提供如实写）；免费额度/付费档/吊销要点
- [x] 2.4 创作块：creators 组前提、三条组装路径、版本不可变+notes、订阅 vs 安装、深度指南链接
- [x] 2.5 五语 key（`facetDocs.*`，en 源真相）；命令字面量不进 locale，组件从 cliFacts 拼接；`check-locales.js` 通过

## 3. 路由与文档

- [x] 3.1 `App.tsx`：`View` 增 `docs`；`VIEW_HASH`/`viewFromHash`/tab 清单增 `#/docs`（公开 tab，匿名可见四 tab）；深度链接/reload 稳定
- [x] 3.2 新 `docs/creating-packs.md`（创作者深度指南，中文）：身份前提/三条组装路径/manifest 内容模型/发布门/版本纪律/订阅 vs 安装/下架与可见性；随 OSS 快照发布
- [x] 3.3 壳内创作块深度链接指向公开仓该文件；客户端页链接指向 `docs/ecosystem/<client>.md`

## 4. e2e 哨兵与生产实证

- [x] 4.1 `e2e/facet-shell.spec.js` 扩：`#/docs` 三块渲染、壹座默认选中、客户端切换后命令/路径可见、MCP 两路措辞、创作块深度链接 href 形状、零 pageerror；条件 tab 场景同步为四公开
- [x] 4.2 CI 全绿（lint/typecheck/单测/locales/build/e2e）——org GHA 账单阻断期，本地等价全绿：lint 净、typecheck 过、unit 1101/1101、locales 五语 1136 键、build 过、fast e2e 397 passed
- [x] 4.3 生产实证（按 paas-release 标准线：快照→relay→GitOps→ArgoCD→in-pod 探针+浏览器验收）；归档 + 路线图 F1.3 标 ✅
