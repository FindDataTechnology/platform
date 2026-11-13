# Tasks — fix-ia-shell-polish

- [x] 1.1 `web/src/styles/globals.css` 加 `.micro-label` 语义类（`:lang(en)` 11px/uppercase/0.02em；`:lang(zh)/:lang(ja)` 12px/none/normal）；验证：zh 与 en 截图对照，家族头不再糊、不再散
- [x] 1.2 家族头、设置分组头、项目切换器、构建快捷行四处改用 `.micro-label` 并删掉各自的字号/字距字面量；验证：`grep -n "text-\[10px\]\|text-\[11px\]" 这四处 = 0`
- [x] 1.3 design-lint 棘轮加一条 micro-label 字面量扫描（基线 file+rule→count，只拦改动文件）；验证：故意写回一处 `text-[10px]` 时门变红
- [x] 2.1 折叠状态机：渲染只读 `collapsedFamilies`，去掉 `!isActiveFamily` 条件；验证：在 `/agents` 点“构建”家族头能折叠
- [x] 2.2 路由跨家族变化时 reveal-on-entry（一次性）；验证：深链 `/tuning`（构建折叠时）自动展开
- [x] 2.3 折叠家族含活动条目时家族头带活动标记；验证：折叠后活动标记在家族头可见
- [x] 2.4 全局开关 `data-collapsed` 与图标只由折叠集推导，与渲染永不分叉；验证：`/agents` 点“全部折叠”后所有家族均折叠、图标为“展开全部”
- [x] 3.1 修 `OnboardingTour.tsx` 的 key 拼接（含 `install-preset` 特例与缺失步骤降级）；验证：首启引导卡显示正常文案，DOM 文本不含 `onboarding.`
- [x] 3.2 新增 e2e 断言：引导卡可见文本不匹配 `/onboarding\.tour/`；验证：绿
- [x] 4.1 混合拍板标签：中文 `工具`、英文 `Tools`，MCP 降为副标题/tooltip；5 语词条同步；验证：`check:locales` 绿
- [x] 5.1 回归：`e2e/layout.spec.js`、`e2e/nav-persistence.spec.js`、`e2e/sidebar-workspaces.spec.js`、`e2e/settings-modal.spec.js`；验证：全绿
- [x] 5.2 `npm --prefix web run typecheck` + `npx biome check` + `openspec validate fix-ia-shell-polish --strict`；验证：全绿
- [x] 5.3 截图走查：zh/en × 1440/1024，家族头、分组头、项目切换器、折叠三态；验证：留档对比
