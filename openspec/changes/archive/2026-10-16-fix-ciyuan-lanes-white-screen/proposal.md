## Why

词元控制台的「模型车道」页面（`/lanes`）**必然白屏**：四张车道卡片全部依赖
`lanes.shapes.*` 文案渲染，其中 3 条（rerank/websearch/tts，zh/en 各一份共 6 条）
直接内嵌未转义的 `{` `}`（JSON 示例形状），vue-i18n 运行时编译消息时抛
`SyntaxError: Unterminated closing brace`，整个组件树卸载——真浏览器复现：
URL 变 `/lanes` 后 `BODY len: 0`，控制台即该报错。

该缺陷对全部持有分组 3 密钥的用户生效（生产 19 把在册），且构建期完全无感：
能抓此类问题的守测 `localesMessageCompile.spec.ts` 早已存在，但不在 Makefile 的
`FRONTEND_CRITICAL_VITEST` 列表里；出片管线（build-pool）的 test job 又只跑
Go 单测，前端测试在出片链上完全缺席——所以缺陷一路出片到生产。

## What Changes

- **文案修复**：`frontend/src/i18n/locales/lanes.ts` 6 条字符串按 vue-i18n 字面量
  转义约定改为 `{'{'}` / `{'}'}`（已隔离编译验证 6/6 通过）。
- **门禁补线**：把 `localesMessageCompile.spec.ts` 加进 Makefile
  `FRONTEND_CRITICAL_VITEST`——该类缺陷（运行时才编译的 i18n 消息）自此在
  `make test-frontend-critical` 与 fork CI（backend-ci.yml 的 frontend job）被拦。
- **出片滚产**：fork 出新 tag `ciyuan-v0.2.16-8`，经既有链（GHA → hkccr →
  cheap-3 relay → ccr）出片，GitOps 滚 sub2api deployment。
- **生产验收**：真浏览器全链——登录 → 点「模型车道」→ 四张卡片渲染、无控制台
  报错；`/lanes` 页既有其他元素（错误面文案等）回归不变。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `ciyuan-gateway-lanes`: 车道入口页（面板 `/lanes`）当前不可渲染（白屏）；
  修复后车道页在任意语言下均完整渲染，且该类 i18n 缺陷进入 CI 门。

## Impact

- 代码：fork 仓 `FindDataTechnology/sub2api`——`frontend/src/i18n/locales/lanes.ts`
  （6 条文案转义）、`Makefile`（守测入列）；无 Go 代码、无新缝点。
- 出片：新 tag 出片（`fd-build-channel` 判路），GitOps 滚 sub2api deployment。
- 风险面：仅文案字面量转义与测试清单，不动车道协议/计费/路由。
