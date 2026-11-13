# 一个 program，只留一行 MCP

## Why

部署基线（`mcp.json`）与打包清单（`platform.bundle.json`）用**不同名字**指向同一个脚本：
`actions` 与 `actions-mcp` 都是 `server/actions-mcp.js`。而入库按**名字**去重，
所以托管 cell 同时拿到两行。

后果三条（2026-11-09 生产实测）：

1. 每个 dsh 多拉一个 ≈77Mi 的进程（cap=0 时每 cell 一份，开 worker 槽再加一份）；
2. 工具面里 `propose_action` 出现两次（两个 server 名下），模型更容易选错；
3. bundle 那份没有 `ACTIONS_MCP_PROPOSER_EMAIL` → 提案落库 `proposer_email = NULL`，
   而批准条件是 `userEmail === proposer`，**永远批不了**——摆给模型一条死路。

## What Changes

- 以 **program（command + args）** 作为「同一个服务器」的身份，而不是名字。
- 种 bundle 条目时：若同名程序已由启用的其它行提供 → 跳过种入；若库里已存在该
  bundle 行（老 cell）→ **删掉它**（仅当 `origin === "bundled"`）。
- 运维手加的行（`origin` 非 bundled）一律不删，只记一条 skip 日志。
- 被禁用的同名行不算「已提供」——否则禁掉一个名字等于把两条路都关掉。
- url 型条目没有 command，不参与判重（按名字走）。

## Impact

- 新增：`extension-store.mcpProgramKey()` / `findSameProgram()`；`server.js`
  `seedStartupMcpConfigs` 的跳种 + 删除分支；`scripts/test-mcp-seed-dedupe.mjs`。
- 影响面：所有托管 cell 的 MCP 组合（少一行、少一个子进程）；打包/桌面形态无
  `mcp.json` 时不触发，行为不变。
- 收益（生产实测）：卫星/每 dsh 13.33 → 12.25，每 cell −93…−126Mi，四 cell ≈0.4Gi。
- 残余：市场 pack 里 `registryName: "actions-mcp"` 的引用会悬空；已证实无害
  （聚焦层保留 `mcp.json` 全集，`propose_action` 仍在；该 server 只有一个工具，
  `allowTools` 本就等价全量）。命名统一另议。
