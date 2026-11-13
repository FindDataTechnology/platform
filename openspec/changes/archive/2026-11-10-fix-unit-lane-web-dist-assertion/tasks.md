# Tasks — fix-unit-lane-web-dist-assertion

## 1. 定位

- [x] 1.1 确认 unit 车道没有 `web/dist`
  - 实证：`ci.yml` `PLATFORM_SKIP_WEB_BUILD=1`；`Build web (e2e seam)` 排在 `Unit tests` 之后
- [x] 1.2 确认断言依赖该产物
  - 实证：`gateway/index.js:346` `res.sendFile(path.join(WEB_DIST, "index.html"))`，
    `WEB_DIST = REPO/web/dist`；本机 dist 缺失时该条 3/3 红

## 2. 修

- [x] 2.1 断言分层：恒成立的是"匿名 `/` 不得被 302 劫持到 Logto"；200 + doctype 只在
      产物存在时断言

## 3. 验

- [x] 3.1 改后该文件不再卡在壳断言（推进到 304 行）
- [x] 3.2 `biome check scripts/test-cell-gateway.mjs` 无告警

## 4. 暴露出来的下一层（已由另一单解掉）

- [x] 4.1 `the restarted cell must sync its session list over the proxied WebSocket`
      （`scripts/test-cell-gateway.mjs:304`，实测 57–99s 后失败）
  - **已解**：根因是网关的空闲存活记账——`lastTraffic` 记在 fork 而非"开始服务"、挂着的 WS
    不算流量、`if (pending) return pending` 不刷新，导致 cell 在 dsh 就绪前被 SIGTERM，
    `ctx.session` 从未建立，于是 `sessions` 帧永远发不出来。修在 `fix-cell-idle-liveness`
    （`404d1e332`）。
  - 实证：该文件连跑 **4 次全绿**（45s / 42s / 75s / 79s），修复前 3 次里 2–3 次红。
