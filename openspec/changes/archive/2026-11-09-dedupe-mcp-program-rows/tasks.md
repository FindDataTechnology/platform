# Tasks — dedupe-mcp-program-rows

- [x] 1.1 `extension-store.js` 出 `mcpProgramKey(config)` 与 `findSameProgram(rows, config, {excludeName})`
      （只认启用的行；url 条目无 command 不参与）
- [x] 1.2 `server.js` `seedStartupMcpConfigs`：种 bundle 前判重；命中且该行 `origin==="bundled"` 则删除，
      否则只记 skip；种入后把新行并入判重视图
- [x] 1.3 单测 `scripts/test-mcp-seed-dedupe.mjs`（4 例：同程序异名相撞 / 不同程序不相撞 /
      禁用不算重复 / url 不参与）
- [x] 1.4 启动级验证：本地起 `server.js`（生产 mcp.json + 真 bundle）→ 日志 skip 一行、补丁里 actions 1 条
- [x] 1.5 迁移验证：造含 `actions-mcp(bundled)` 行的库 → 启动日志 removed duplicate、补丁 1 条
- [x] 1.6 边界验证：手加 `actions-mcp(user)` 不删；`actions` 禁用时 bundle 那份照常种
- [x] 1.7 打包形态验证：空 `mcp.json` → 去重不触发、`actions-mcp` 照常种
- [x] 1.8 生产验证：镜像 `sha-0ae3e9d` 后 4 cell 各一行 removed duplicate；卫星/每 dsh 13.33→12.25，
      每 cell −93…−126Mi
