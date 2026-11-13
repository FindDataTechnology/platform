## 1. 共享服务单元（前端 + playwright MCP + chromium）

- [x] 1.1 新增共享浏览器服务入口（streamable-http 面）：用一个 MCP 服务端接受 cell 侧会话，每个会话开一条到 playwright MCP 的 SSE 客户端会话；验证 = 单元测试起两个会话、断言各自拿到独立会话 id 与独立 tools/list（不共享上下文）
- [x] 1.2 服务进程内拉起并守护 playwright MCP（`--port`，SSE；显式**不**传 `--shared-browser-context`，传 `--isolated` 与 `--output-dir`）；验证 = 进程表断言只有一份 cli.js，且命令行不含 `--shared-browser-context`（哨兵测试）
- [x] 1.3 `tools/call` 转发与保真：正常返回、长操作、取消、错误码透传；验证 = 契约测试对 dummy MCP 覆盖四类响应，断言取消真的体现在上游会话
- [x] 1.4 cell 身份判定：标识来自部署内可信来源（pod 内来源 + 部署配置映射），不接受客户端自报；验证 = 测试伪造标识仍归到真实 cell
- [x] 1.5 产物按 cell 路由：转发时把 `filename` 前缀改写为该 cell 的绝对子目录，未命名产物同目录；验证 = 两 cell 各截一张图，断言文件系统落点与 `/api/files` 可见性互不可见

## 2. 接线（profile 与供应门）

- [x] 2.1 `dsh-profile.js` 增加共享端点分支：`BROWSER_SHARED_MCP_URL` 存在时写 `{transport: "streamable-http", url}` 条目，不再写 stdio 命令与 `BROWSER_OUTPUT_DIR` 注入；验证 = 生成 patch 的快照测试（有/无该 env 两种）
- [x] 2.2 无共享端点时行为保持不变（stdio 垫片路径原样）；验证 = 现有 browser lane 快照/单测全绿，patch 逐字节对比无变化
- [x] 2.3 供应门三态保持：local / remote(`BROWSER_CDP_ENDPOINT`) / absent(`BROWSER_LANE=off`)；验证 = 既有三态单测全绿，新增一态"有共享端点但 `BROWSER_LANE=off` → 条目缺省"
- [x] 2.4 失败不回落：共享端点不可达时不 spawn 本地 playwright；验证 = 故障注入测试断言 pod 内无 cli.js 进程且日志点名 shared endpoint

## 3. 部署单元

- [x] 3.1 platform pod 增加共享服务 sidecar（或同 pod 容器）与两个 env（共享端点、产物根）；验证 = 渲染后的清单含该容器且 env 就位
- [x] 3.2 健康与观测：服务可达性进健康面，内存面孔新增该服务 footprint 行；验证 = 面返回含该行，服务停掉时状态变灰
- [x] 3.3 镜像冒烟：车道能在共享形态下完成一次真实导航；验证 = 冒烟用例输出导航成功的截图或页面标题

## 4. 隔离与回归哨兵

- [x] 4.1 跨 cell 隔离哨兵：两 cell 同时登录不同账号，互不可见；会话结束后不残留；验证 = 该用例在 CI 常驻
- [x] 4.2 产物跨 cell 不可读哨兵：cell B 列举/获取不到 cell A 的截图；验证 = 该用例在 CI 常驻
- [x] 4.3 内存对照：改造前后同一 pod 的 footprint 与 cell 进程表对照（预期 platform pod ≤2.5GB，cell 内无 browser 子进程）；验证 = 记录到台账，数字来自 `kubectl top` 与 /proc 实测

## 5. 灰度与文档

- [x] 5.1 灰度：先给一个测试 cell 设 `BROWSER_SHARED_MCP_URL`，走查工具面、产物、降级三项；验证 = 走查记录三项均符合
- [x] 5.2 全量打开后观测 footprint 与降水域，保留回滚面（删 env 即回到每 cell 自家进程）；验证 = 观测记录 + 回滚演练一次
- [x] 5.3 文档：`docs/` 补供应说明（两种形态、环境变量、降级语义、回滚），`.env.example` 同步；验证 = 文档与环境样例一致
