# Tasks — require-full-access-ack

## 1. 判据先钉住（修复前应红）

- [x] 1.1 `scripts/test-permission-switch.mjs` 新增三例：
      「全权访问不带 acknowledge → 拒绝且不触及 bridge」
      「全权访问带 `acknowledge: true` → 生效」
      「未知名优先级：带/不带 acknowledge 都报 Unknown permission mode」
- [x] 1.2 确认这三例在**改动前**有红：不带 flag 的那一例必须失败（当前会被直接放行）
  - 实证：加闸前 `node --test scripts/test-permission-switch.mjs` → 12 tests / **10 pass / 2 fail**，
    正是 `full access without the acknowledgement is refused before the bridge` 与
    `acknowledge:false is not an acknowledgement` 两条

## 2. 服务端闸

- [x] 2.1 `server/agent-session.js::switchPermissionTo(name, { acknowledge })`：
      在 roster 校验之后、bridge 调用之前加 `danger-full-access` 的 acknowledge 闸；
      已处于该预设时的 no-op 保持不需要 flag
  - 判定顺序：流中 → no-op → 空 roster → 未知名 → acknowledge 闸 → bridge（未知名不会被误报成缺确认）
- [x] 2.2 `server/ws.js::set_permission` 把 `data.acknowledge === true` 传下去；
      失败仍走既有孤儿错误路径（只回请求方）

## 3. 客户端与类型

- [x] 3.1 `web/src/components/ControlStrip.tsx` 的 confirm 动作发送
      `{ type: "set_permission", name: "danger-full-access", acknowledge: true }`
- [x] 3.2 `packages/core/src/types/ws.ts` 的 `set_permission` 负载加可选 `acknowledge?: boolean`

## 4. 测试（正例 + 反证）

- [x] 4.1 `node --test scripts/test-permission-switch.mjs` 全绿
  - 实证：**12 tests / 12 pass / 0 fail**（含既有四例：流中拒绝 / 未知名 / 空 roster / bridge 失败）
- [x] 4.2 反向验证：把 acknowledge 闸注释掉 → 1.1 的「不带 flag」必须转红；恢复即绿
  - 实证：临时删除闸 → **正是那 2 条转红（10 pass / 2 fail）**；`cp /tmp/agent-session.bak.js` 恢复 → 12/12 绿
- [x] 4.3 `e2e/composer-controls.spec.js` 断言确认动作发出的负载带 `acknowledge: true`
  - 实证：`npm run web:build:e2e` + `npx playwright test e2e/composer-controls.spec.js --project=fast`
    → **7 passed (6.7s)**，含「full access asks for acknowledgement before anything is sent」

## 5. 收口

- [x] 5.1 `openspec validate require-full-access-ack --strict` 绿
- [x] 5.2 lint + typecheck + build 本地通过（Biome `error` 数为 0）
  - 实证：`biome check` 六个改动文件 → No fixes applied（0 error）；
    `npm run typecheck` 无输出（tsc 干净）；`npm run web:build:e2e` exit=0
- [x] 5.3 归档：`openspec archive require-full-access-ack` 后 `openspec/specs/permission-mode-selection/spec.md` 生效
  - 实证：`openspec validate --strict` 绿 → archive `~ 2 modified` → 归档为
    `2026-11-09-require-full-access-ack`；spec 现含 `acknowledge` 前缀要求与
    "full access requires acknowledgement" 场景
  - **未勾原因**：归档要在本 change 随 paas 出片上产后做（spec 一旦生效就代表线上行为，
    而线上仍跑不校验 acknowledge 的旧码）；滚版后补勾。
