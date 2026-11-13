# chat-connect-guidance — 任务

## 1. 服务端分类器

- [x] 1.1 `server/connect-guidance.js`：`turnErrorHint(message)` / `toolFailureHint(toolName, resultText)` + 共享的 server-config 解析；静态 import 无环。
  验证：`node --test scripts/test-connect-guidance.mjs`（分类表：模型 401/invalid key 命中→ciyuan-account；网络类/限流类不命中；mcp 前缀带 ref→panel；裸工具名/无 ref→null）
- [x] 1.2 `dsh-events.js` 两处附着：`{type:"error"}` 与 `tool_end` 广播带可选 `connect`；stale 链路不动。
  验证：单测里断言广播载荷（fake ctx 捕获 sendToViewers）

## 2. 客户端

- [x] 2.1 `chat-store.ts`：Block 两变体 `connect?: {panel}`；`case "error"` / `tool_end` 透传。
  验证：typecheck 绿 + store 级单测（若有先例；否则并入 e2e）
- [x] 2.2 `AssistantTurn.tsx`：错误块 + 失败工具块渲染 `turn-connect-cta` → 深链 `?panel=`；i18n 五语言。
  验证：typecheck 绿

## 3. 测试门

- [x] 3.1 e2e：注入一个 401 转折（fake 转折或 page.evaluate 派发 WS error 带 connect——按仓库既有 e2e 模式择一），断言按钮出现且 href 正确。
- [x] 3.2 全量 `node --test scripts/test-*.mjs` 不回归 + `npm run web:build:e2e` + playwright 绿。

## 4. 发布与真机

- [x] 4.1 随同车发布；生产 chunk 含 `turn-connect-cta`。
- [x] 4.2 真机核销：§12.15 角色账号（stock）——无法安全触发真 401，故验收=部署证据（chunk 标记）+ 分类表单测 + e2e；台账如实记「未在生产触发真实凭据失败」。
- [x] 4.3 主 spec 同步 + 归档。

## 实施记录（apply 阶段，2026-10-19）

- `server/connect-guidance.js` 静态 import `extension-store`/`credential-refs` 无环（二者链路不经 dsh-events）；`credential-refs.js` 新导出 `connectPanelForRef`（`connectPathForRef` 改为复用它）。
- 单测 `scripts/test-connect-guidance.mjs` 6/6：分类表（8 命中 / 9 不命中）、mcp 前缀→ref→panel 三例（含 wanxing-caller→ciyuan-account）、无 ref/未知服务/裸工具/非凭据不附；**附着点走真 harness**（`createAppContext` + `attachDshEvents` + `handleDshEvent`）证实 `tool_end`/`error` 带 `connect`、result 文本逐字节不变、持久化块无指针。
- 客户端：`ws.ts` `ConnectPointer` 类型挂 `tool_end`/`error`；`chat-store` 两处透传（done 调用清掉旧失败留下的指针）；`ConnectCta` 共用组件在错误块与失败工具块渲染；e2e `e2e/connect-guidance.spec.js` 3/3（turn 错误带/不带 connect、失败工具块内 CTA 深链 registry 面板）。
- 3.1 的 e2e 用 store 缝注入 WS 事件（非真 401）——分类正确性由单测保证，e2e 只证客户端渲染与深链。
- 4.1/4.2 实证：pod 内 `/app/server/connect-guidance.js` 在位（`ciyuan-account` 引用 2）、served chunk 含 `turn-connect-cta`；生产未触发真实凭据失败（如计划所述），分类正确性由单测 6/6 + e2e 3/3 保证。
