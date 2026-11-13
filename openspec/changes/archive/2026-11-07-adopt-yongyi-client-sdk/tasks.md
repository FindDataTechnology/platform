# Tasks — adopt-yongyi-client-sdk

> 执行约定：任务 0 须全部完成（发布冻结解除）才可开始 1-4；1-4 内主仓与 agent-runner 可并行子代理；收口归主代理。

## 0. 前置：SDK 补件与发布（fd-memory 侧）

- [x] 0.1 SDK `src/mounts.ts`：从 paas `agent-runner/memory-mount.js` 逐字节移植 `memoryNamespaceFor`、`podMemoryNamespace`、`acpMemoryMount` 三件（`dshMemoryMount` 即既有 `memoryMcpEntry` 别名导出），金样钉 shape，版本升 0.1.1
- [x] 0.2 **npm 发布**：`@finddatatechnology/yongyi-client@0.1.0`（现包）+ `0.1.1`（补件后）——卡 owner 刷新 npm token（本机 token 已 401；`npm login` 或更新 ~/.npmrc 后 `cd sdk && npm publish --access public`）
- [x] 0.3 发布验证：`npm view @finddatatechnology/yongyi-client` 两版本可查、`npm pack --dry-run` 清单干净

## 1. 主仓重接（6 消费文件 + 删 4 模块）

- [x] 1.1 `package.json` +`@finddatatechnology/yongyi-client@^0.1.1`
- [x] 1.2 `server.js`、`dsh-profile.js`、`resources.js`、`server/ws.js`、`server/cron-runner.js`、`server/fleet-cost-digest.js`、`gateway/zhiyu/index.js`、`server/routes/fleets.js`、`server/routes/memory.js`、`server/routes/resources.js` 换 import 源（调用形状零改动，env 传 `process.env`）
- [x] 1.3 删 `cell-memory.js`、`memory-discipline.js`、`server/fleet-memory.js`、`server/cluster-memory.js`
- [x] 1.4 全仓 grep 确认零残留引用（含注释里的路径提及逐条过目）

## 2. agent-runner 重接（删 2 模块 + 3 import 更新）

- [x] 2.1 `agent-runner/manager.js` 三行 import 换 SDK（`MEMORY_DISCIPLINE`←discipline、`dshMemoryMount`→SDK `memoryMcpEntry` 或 mounts 别名、`acpMemoryMount/memoryNamespaceFor/podMemoryNamespace`←SDK mounts）
- [x] 2.2 `agent-runner/config.js`、`agent-runner/harness/{acp,adapter,dsh}.js` 相关 import 逐一过
- [x] 2.3 删 `agent-runner/memory-mount.js`、`agent-runner/memory-discipline.js`；**保留** `memory-capture.js`（D3 定性：fd-memory /capture 批量队列客户端，非拷贝）

## 3. 测试重指向（4 文件）

- [x] 3.1 `test/cell-memory.test.mjs`、`test/cluster-memory.test.mjs`、`test/dsh-profile-memory.test.mjs`、`agent-runner/test/memory.test.mjs`：删对本地实现的深测，改为断言「接线产出与金样逐字节一致」+ import 可解析
- [x] 3.2 `test/dsh-profile-memory.test.mjs` 保留 preset patch 形状断言（mcpEntry + discipline 注入点）

## 4. Portal 指引与文档

- [x] 4.1 `/memory` 页尾加独立 Portal 指引行（fd-memory `/portal`，自托管/其它 harness 用户人面）
- [x] 4.2 相关文档提及处（README/CLAUDE.md 若有记忆集成段落）同步「通用件已下沉 SDK」一句

## 5. 收口（主代理）

- [x] 5.1 定向回归绿：记忆面 12 个 scripts 部件 + 四重指向测试文件 = 126/126（全量 test:unit 因并发会话在途文件挂死中止——`test-owner-cross-line-spend.mjs` 挂 32min，其脏 diff 正移除 sharedGet 的 timeoutMs；依「并行会话活跃时禁跑全量基线」惯例改定向面，挂死件与本 change 无关）
- [x] 5.2 `openspec validate adopt-yongyi-client-sdk --strict` 绿（skip_specs）
- [x] 5.3 两仓字节钉互证：SDK 金样 vs 壹座重指向测试输出一致
