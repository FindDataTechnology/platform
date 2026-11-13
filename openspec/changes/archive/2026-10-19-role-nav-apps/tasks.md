# role-nav-apps — 任务

## 1. 配方与断言

- [x] 1.1 `packages/core/src/lib/surfaces.ts`：`FACTORY_PRESETS.simple.nav` 追加 `"apps"`（agents 之后），注释说明入口原因。
  验证：`node --test scripts/test-layout-resolution.mjs` 的 simple 用例按新列表通过
- [x] 1.2 同步六处硬编码断言：`scripts/test-layout-resolution.mjs`（4 处）、`scripts/test-layout-storage.mjs`（1 处）、`e2e/layout.spec.js:205`（1 处）。
  验证：`grep -rn '"chat", "knowledge", "resources", "agents"\]' scripts e2e` 为 0 命中

## 2. 测试门

- [x] 2.1 `node --test scripts/test-layout-resolution.mjs scripts/test-layout-storage.mjs` 全绿；`npm run typecheck` 绿。
- [x] 2.2 e2e `layout.spec.js` 绿（先 `npm run web:build:e2e`）。

## 3. 发布与真机

- [x] 3.1 随同车发布（与 voice-lane / chat-connect-guidance 同一出片）。
- [x] 3.2 真机：`scripts/verify-live-app-center.mjs` 的角色账号（stock）侧栏出现 `nav-apps`（§12.15 观察项核销）。
  验证：脚本新增断言 PASS
- [x] 3.3 主 spec `layout-configuration` 同步 + 归档。

## 实施记录（apply 阶段，2026-10-19）

- 硬编码列表实际七处（提案估六处）：`test-layout-resolution.mjs` 三处 simple 结果断言（L95/138/160；L102-105 是「部署层藏 apps 不可揭示」用例、L208 是 resolveContainer 顺序用例，输入输出均保持四项，语义正确不动）、`test-layout-storage.mjs:90`、`e2e/layout.spec.js:205` + `:228`（侧栏 `nav-apps` 由「不存在」改「可见」）、`e2e/intent-onboarding.spec.js:244`（全量 e2e 抓出的漏网）。
- `node --test` layout 两套 43/43；`layout.spec.js` 9/9；`intent-onboarding.spec.js` 绿。
- 3.2 实证形态调整：管理员账号已豁免角色层（admin-layout-exempt），拿它验不了角色 nav；改为 pod 内 served chunk grep `"chat","knowledge","resources","agents","apps"` 命中 1 + `test-layout-resolution` 43/43 + `layout.spec` 侧栏 `nav-apps` 可见（logto 模式非管理员用户）。
