## 1. 摘除归一化层

- [x] 1.1 删除 `server/blueprint-validate.js` 的 `normalizeIncomingContent` 函数本体、其上方整段「跨仓契约兼容层」注释、以及自由文本断言归一分支；验证 `grep -n normalizeIncomingContent server/blueprint-validate.js` 零命中
- [x] 1.2 删除 `server/routes/blueprints.js:13` 的 `normalizeIncomingContent` import，并把 POST（:136）与 PUT（:175）两处 `const content = normalizeIncomingContent(raw.content)` 改为 `const content = raw.content`；验证 `grep -rn normalizeIncomingContent server/` 零命中

## 2. v1 方言如实拒绝 —— 判别函数与校验链短路

- [x] 2.1 在 `server/blueprint-validate.js` 新增导出 `v1FormatFindings(content)`：命中条件为 `(vertical || sources || boards 任一存在) AND (对应 boundary / dataSources / board 缺位)`，命中返回**一条**指名 v1→v2 错误（含 v2 字段清单 + 逐项迁移指引，见 design D2/D6 文案）；未命中返回 `[]`。验证：对 finddata `cross-border-ecom-policy/blueprint.json` 原文调用返回长度 1
- [x] 2.2 `validateBlueprint` 开头调用 `v1FormatFindings` 并**短路**：命中即 `return { ok:false, errors:[那条错], findings:{ v1:[…], shape:[], acceptance:[], fleet:[], manifest:[], toolFace:[], toolClosure:[] }, manifestPreview }`；验证：对 v1 原文 `validateBlueprint(...).errors.length === 1`（不掺 4 条 acceptance 形状错、不含无 entry 的包级错）

## 3. v1 方言如实拒绝 —— 写入层硬拒

- [x] 3.1 `server/routes/blueprints-db.js` 的 `assertStorable` 增加 `v1FormatFindings` 判别（与 `credentialFindings` 并列，任一命中即抛 422 并附 findings）；验证：直接用 v1 形状 content 调 `store.createBlueprint` 抛 422 且不落库
- [x] 3.2 核对 `assertStorable` 抛出的 v1 错误经 POST/PUT 路由的 422 分支原样透出（错误文案 + findings 可读）；验证：HTTP 粘 v1 创建得 422 且 body.error 指名 v1

## 4. UI 换行呈现

- [x] 4.1 `web/src/pages/BlueprintStudioPage.tsx` 的 `ErrorList` 条目加上 `whitespace-pre-line`（或等价），使多行迁移指引按行呈现；验证：手动粘贴 v1 触发拒绝，错误块分行显示而非一坨连排

## 5. 测试翻转与回归

- [x] 5.1 改写 `scripts/test-blueprints.mjs` 的「跨仓契约兼容：finddata 蓝图格式 v1 原样粘入…」用例为：v1 形状 POST/校验被指名拒绝（只报一条 v1 错，含 v1→v2 迁移指引），且库中不落该蓝图
- [x] 5.2 新增用例：一份**合规 v2 蓝图**（自带 boundary/dataSources/board）另带一个无害旧键（如未使用的 `sources`）不被 v1 拒绝、正常通过——锁住 D2 合取判别不误伤
- [x] 5.3 跑 `node scripts/test-blueprints.mjs` 全绿；顺跑其余 `node scripts/test-blueprint-judge.mjs`、`test-blueprint-trial.mjs`、`test-blueprint-reverse-assertions.mjs` 确认无回归

## 6. 契约与文档收尾

- [x] 6.1 更新 `docs/blueprint-v1-compat-removal-requirements.md` 三处措辞：§3 病因改为「4 条 acceptance 形状错 + 一条无 entry 包级错」（非六段全缺）、§5.3 验收口径同步、§2-B 处置明确为「写入层 assertStorable 硬拒 + validateBlueprint 前置短路」
- [x] 6.2 运行 `openspec validate remove-blueprint-v1-compat --strict` 通过；记录 finddata 仓 `schema.md` 注记更正为跨仓跟进项（不在本仓实施）
