# Tasks: extend-dsh-contracts-020-capabilities

## 1. 探针插件基建

- [x] 1.1 `scripts/lib/dsh-contracts/probe/contracts-agent-probe.mjs`：test-only cordis 插件——boot 起 127.0.0.1:0 HTTP 端点、端口写入临时 home `contracts-probe.json`；操作面按 design D1（presetFacts/restrictAgent/subagentRun/sidecarCount/agentList/appendSurface）
- [x] 1.2 `scripts/lib/dsh-contracts/probe/trivial-mcp-server.mjs`：本地 stdio MCP server（initialize+tools 列表两应答）
- [x] 1.3 合同 runner 物化路径扩展：临时 profile 拷入探针+trivial server、patch 行注入（disable+insert 同型）、探针 profile 声明两个 preset 与 `maxActiveSubagents: 1`、MCP server 行
- [x] 1.4 探针端口发现与 HTTP 客户端（轮询 contracts-probe.json→调操作面）进 `scripts/lib/dsh-contracts/contracts.mjs`
- [x] 1.5 新文件入 `scripts/dsh-adapter-files.json`，`npm run lint:dsh-adapter`（或等价命令）绿

## 2. 五条合同实现

- [x] 2.1 合同⑩ preset 会话级选择与组合隔离：两会话各选不同 preset 断言组合事实互不渗透；未知 preset 发布前回滚断言
- [x] 2.2 合同⑪ per-agent 工具裁剪作用域：restrict A 收窄、B 不变（5 秒重试容忍）
- [x] 2.3 合同⑫ subagent one-shot+槽位准入：one-shot 跑完即收+per-child options 落请求事实；占槽后派发断言 ACTIVATION_LIMIT_REACHED
- [x] 2.4 合同⑬ ACP 会话面：最小 ACP 客户端（手写 JSON-RPC stdio）+ spawn `--profile acp`；create/submit/cancel/list/close+模型与 effort 选择+重启后 list/resume；通知流全量抓取
- [x] 2.5 合同⑬ 计量面附录：usage/token 可得形状以 `notes: acp-metering=<shape>` 附注输出（报告格式扩展，逐条行格式不动）
- [x] 2.6 合同⑭ MCP sidecar 进程级共享：N=3 agent 消费同名 server，进程树断言 sidecar 恒 1；关闭后无孤儿

## 3. 活体测量（非 CI 门）

- [x] 3.1 `scripts/measure-dsh-pod-shape.mjs`：K 会话大上下文播种+RSS 时间序列采样，CSV+摘要 JSON 输出
- [x] 3.2 数字回填 `docs/wanxing-multi-harness-runtime-explore.md` §规模数学（pod 预算定标）；⑬ 计量面结论同步该文档未决问题 #2 实证半边

## 4. 验证与收口

- [x] 4.1 矩阵 scratch 树全量合同（6+3+5）两轮全绿；⑨ 按 rc.2 既有豁免口径
- [x] 4.2 镜像冒烟/矩阵 PR 门零改动验证：新合同自动纳入聚合退出码（本地模拟冒烟调用形状即可，不强制出片）
- [x] 4.3 探针不进生产组合复核：生产 Dockerfile/profile 物化路径无探针文件（spec 场景）
- [x] 4.4 openspec validate --specs 通过后按流程收口
