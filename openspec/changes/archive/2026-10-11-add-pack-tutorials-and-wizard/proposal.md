# Proposal: add-pack-tutorials-and-wizard

## Why

R4 收尾"更聪明"：R2 的六包指南是平台方手工维护的客户端内容，创作者自己装的包没有教法；订阅成功后用户拿到的是一份安装报告而不是"接下来干什么"；示例提问只活在欢迎页的提示卡里，装包决策现场看不到。本期把教法下沉到 manifest（随包分发）、把安装动线接上向导、把示例外显到决策现场，并同步小程序端命名。

## What Changes

- **manifest 自带教程**：manifest 增加可选 `guide` 字段（`steps: [{title, body} ×3]`，title ≤60、body ≤500 字符）；发布校验（gateway 复用 validatePackManifest）；创作者编辑器（PackDraftsView）加三步编辑区；详情页指南卡渲染链改为 **manifest.guide → 客户端内容模块 → 不渲染**（创作者内容优先，平台六包存量内容由模块继续兜底）。向后兼容：无 guide 的存量包零影响。
- **安装向导**：订阅成功报告面板追加「下一步」引导（打开对话选上这位专家 → 成果页看产出），一键跳转；安装报告本身（pack-installation）行为不变。
- **示例外显**：详情页指南卡下方展示该包的示例提问（来自客户端内容模块，最多四条，只读）；帮助中心场景教程不受影响。
- **小程序命名同步**：资源库→成果、存入资源→存入成果、工作区→项目（~10 处用户可见文案，5 个文件）；MP 发版走微信提审节奏，与本 change 的镜像发布解耦。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `pack-authoring`: 新增需求——manifest 可携带三步使用指南（guide.steps 恰好 3 条、title/body 长度上限），发布时随 manifest 一并校验；无 guide 的包照常发布。
- `pack-marketplace`: 详情页指南卡按 manifest.guide → 客户端模块 → 不渲染 的链路取内容；客户端模块含示提词条时指南卡下展示示例提问（只读）；订阅成功报告追加下一步引导与跳转对话入口。

## Impact

- `lib/pack-manifest.js` — PACK_LIMITS 三项 + validatePackManifest 的 guide 校验
- `gateway/packs.js` — 发布路径自然继承（无改动或仅透传校验错误）
- `web/src/components/packs/PackDraftsView.tsx` — 创作者三步指南编辑区（6 输入 + 保存进 manifest）
- `web/src/components/packs/PackDetailDialog.tsx` / `PackMarketView.tsx` — 指南卡取链、示例外显、向导页脚
- `web/src/lib/packs-api.ts` — manifest 类型加 guide
- `miniapp/src/` — 5 文件 ~10 处文案（FileChip / HistoryDrawer / resources 页 / resources.ts）
- `web/src/locales/*/common.json` — 向导与指南 UI 壳文案（五语言）
- e2e — guide 字段发布校验、编辑器保存、详情卡 manifest 优先渲染、向导页脚；既有 pack 用例回归
- 零 WS 契约变更；存量包零迁移
