## 1. 服务端校验薄端点

- [x] 1.1 【实施修正：复用既有 POST /api/packs/validate（creator-pack-forge-support），端点零新增】原任务：新增一个组合校验端点，复用 `validatePackManifest` + `parseFleetTemplate` + `toolFaceErrors/toolClosureErrors`，返回逐字段错误；验收：scripts/test-agent-studio-validate.mjs 5/5——结构错误===lib 校验器输出、fleetTemplate===解析器错误、toolFace 阶段 enforce 下逐字呈现、匿名 401、非创作者仍可校验（eligibility 是 finding）。
- [x] 1.2 复用既有端点，`lib/pack-manifest.js`、`server/fleet-template.js`、`lib/publish-tool-gate.js` 零改动；验收：本 change 提交不含这三个文件的 diff（git show --stat 可验）。

## 2. 三桶卡与名册（画布左/中）

- [x] 2.1 新增 Studio 路由与三栏骨架（左名册 / 中画布 / 右预览），工作文档为客户端状态；验收：新建 agent 后画布出现三桶卡、名册出现该 agent（组件测试）。
- [x] 2.2 实现三桶卡编辑：角色文本、技能（本地技能选取或内联）、MCP（注册处选取 + 工具收窄）；验收：三种编辑均即时反映到工作文档（组件测试断言 document 状态）。
- [x] 2.3 团队模式只读图：复用 `FleetGraph` 渲染成员与编导边，无增删边入口；验收：渲染文档中的成员/边，且图中无 add/remove edge 控件（组件测试）。

## 3. 右栏预览与校验

- [x] 3.1 结构预览：若 `add-agent-spec-sheet` 已落地则复用其共享组件，否则先出最小内联预览（角色摘要 + 技能列表 + MCP 引用）；验收：预览随文档变化刷新。
- [x] 3.2 实时校验接入 1.1 的端点（防抖），错误逐字段列出，错误未清时发射按钮禁用；验收：非法文档时按钮禁用、合法时启用（组件测试）。

## 4. AI 起草

- [x] 4.1 【挂下一棒：pack-author/fleet-architect 尚无 HTTP 工具面，需桥后再接画布】「AI 起草」动作复用既有 builder 工具面桥，产物落为可编辑草稿，不直接写任何发射口；验收：触发后画布出现草稿、且无任何 emit 产物生成（测试断言无写调用）。【**已拆出**：openspec/changes/add-studio-ai-drafting 立案承接（proposal/tasks/spec 三件齐，validate 绿）】
- [x] 4.2 【同上随 4.1】草稿与人批准的边界：未点「采用」前不覆盖现有三桶内容；验收：取消采用后文档不变。【**已拆出**：随 add-studio-ai-drafting 2.2 承接】

## 5. 发射口 v1（预设 + pack 草稿）

- [x] 5.1 发射为自建预设：调既有 `presets-api` 创建，emit 前先过 1.1 校验；验收：合法文档生成 cell 本地预设，非法被拒并显示校验错误。
- [x] 5.2 发射为 pack 草稿：调既有 draft 创建，进入既有发布门；验收：合法生成草稿、非法被拒；草稿发布仍受既有 creators 门（回归测试复用既有发布门用例）。
- [x] 5.3 发射不改工作文档；验收：emit 前后工作文档对象逐字段相等（测试断言）。【2026-11-01 补断言 test-agent-studio.mjs「emit does not mutate the working document」12/12】

## 6. 走查与收尾

- [x] 6.1 五语言 chrome 键 parity：新增 UI 文案进五语言包并通过既有 locale parity 门；验收：`scripts/check-locales.js` 通过。
- [x] 6.2 真机走查 ✓（§15.120：新建/三桶编辑/发射预设成功；「实时校验绿」为脚本时序假象——发射前同端点再校验已证管线；**走查逮回归：doc-fields 误删当场修** d8c6a1dd）
- [x] 6.3 既有 6 个入口保持可用（本 change 不折叠）；验收：`PacksPage`/`CustomPresetsPage`/`BlueprintStudioPage` 冒烟测试仍绿。【被 fold-blueprint-into-studio D2 两步退役取代：/blueprints 重定向 /studio?from=blueprint + BlueprintStudioPage 文件删除，测试在案（fold 测试「old /blueprints redirects…」）； PacksPage/CustomPresetsPage 未动。】
