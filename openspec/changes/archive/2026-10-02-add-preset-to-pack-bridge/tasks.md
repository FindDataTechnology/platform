# Tasks: add-preset-to-pack-bridge

## 1. 服务端转换

- [x] 1.1 核对市场安装扩展与市场条目的对应键：读 `server/routes/extensions.js` 安装流与 `registry-bridge.js` `mapServer`，确认用扩展名匹配 `getMarketEntries().mcpServers` 还是 config 内携带的 registry 引用；结论落进转换辅助模块注释
- [x] 1.2 实现转换辅助模块（技能判据 `origin_pack_id`、MCP 判据 registry 来源+快照在场、`refreshRegistry()` 前置、report 组装），单测覆盖：全可迁移 / pack 技能待替换 / 服务器无对应 / 市场 key 刷新失败沿用 last-good 四例，`node --test` 绿
- [x] 1.3 实现 `POST /api/agent/presets/:id/pack-draft`：manage gate 与 `POST /api/pack-drafts` 同权（403 不留半成品）、调 `db.createDraft`、返回 `{ draft, report }`；单测覆盖 gate 拒绝、预设不存在、成功三例，`node --test` 绿

## 2. Web 面

- [x] 2.1 CustomPresetsPage 行动作「转为功能集草稿」（含 i18n 三语 key），成功后带 report 跳转 pack 编辑器打开新草稿；被 gate 拒绝时呈现指路文案，`npm run lint` 绿
- [x] 2.2 PackDraftsView 顶部一次性「待替换」横幅（pendingSkills 点名所属 pack、pendingServers 列名；报告仅随路由状态走、不落草稿存储），`npm run lint` 绿

## 3. 端到端与验收

- [x] 3.1 e2e：转换全可迁移预设 → 草稿内容与 serving 预置断言；含 pack 技能 + 无对应服务器的预设 → 待替换清单断言（含报告一次性）；playwright 套件 2/2 绿。403 门控行为由路由单测 1:1 覆盖（`scripts/test-preset-pack-bridge.mjs`：403 且零草稿残留）+ 五语 gate 文案 key 在册——hermetic 套件 auth-off（机器 owner 身份恒过门），无法在 UI 层造非 owner 身份，不改判据只改测试归属
- [x] 3.2 规格/提案回读：custom-presets 三场景（无发布路径=面只余转换动作；单向桥=e2e 断言预设原样+草稿落库；转换不发布=端点仅建草稿、无发布调用）+ pack-authoring 五场景（全迁移/外技待换/服务器无对应=e2e 断言；草稿即普通=同一存储与校验路径、与预设零关联系结构保证；serving 可摘=编辑器既有开关）逐条过；`openspec validate add-preset-to-pack-bridge` 通过
