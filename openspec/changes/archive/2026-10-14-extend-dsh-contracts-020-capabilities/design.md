# Design: extend-dsh-contracts-020-capabilities

## D1. 探针插件（⑩⑪⑫⑭ 的断言通道）

ctx.agents / subagent 服务 / preset 注册表是**进程内 API**，现有 stdio RPC 面（initialize/prompt/shutdown + 平台扩展）够不到。设计：**test-only 探针插件**经合同 runner 物化的临时 profile 注入，与 platform-sdk-server 同一装载机制（cordis.patch.yml 的 disable+insert 行——合同⑤已钉住的语义）。

- **文件落点**：`scripts/lib/dsh-contracts/probe/contracts-agent-probe.mjs`——由 runner 在物化临时 home 时拷入（不进 `dsh-profile-template/`，生产 profile 零变化；spec 场景「探针插件不进生产组合」由此保证）。
- **回传通道**：探针在 boot 时起 `127.0.0.1:0` 临时 HTTP 端点，把端口写进临时 home 的 `contracts-probe.json`；runner 轮询该文件拿到端口后经 HTTP 调探针操作。不占 stdio（stdout 为协议帧保留）、不动生产桥、失败面隔离（探针崩溃=该合同 fail，不拖垮子进程协议面）。
- **探针操作面**（内部稳定契约，仅合同用）：`presetFacts {sessionId,presetId}`（返回组合事实：系统提示词段落/工具名单）、`restrictAgent {sessionId,deny}`、`subagentRun {parentSessionId,agentOptions,expectReject}`、`sidecarCount {mcpName}`、`agentList` 等；design 允许实施期增删，但每个操作必须同时返回「事实 JSON + 上游 API 调用点描述」供报告归因。
- **适配层纪律**：探针直引 `@deepseek-ai/*`（ctx.agents/subagent/preset 注册表）——`scripts/` 在 dsh-adapter-boundary 名单语义内，但名单是文件级的：新文件加入 `scripts/dsh-adapter-files.json`，同评审轨迹。

## D2. 假 LLM 与确定性

全部新合同复用 runner 自持的 dummy OpenAI 兼容端点（既有机制），零排演车道依赖、零费用、确定性输出。⑫ 的子代理模型请求同样打到 dummy——per-child options 的「生效」以请求头/组合事实断言（provider/model 落进请求事实），不依赖真实模型行为差异。

## D3. 各合同的机制要点

- **⑩ preset 会话级选择**：临时 profile 以声明式行声明两个 preset（0.2.0 适配已建立声明式 preset 行的先例，`standard.agent.cordis.yml` 同型）；探针经 preset 注册表让两会话各选其一，读各自组合事实断言互不渗透；未知 preset 走「发布前回滚」断言（创建调用以错误结束且 agents 列表无残留）。
- **⑪ 工具裁剪作用域**：探针对 agent A 施加 `restrict({deny})`（DS Bot 实战手法，含 5 秒重试容忍），断言 A 的工具面收窄、B 不变。deny 目标用临时 profile 里真实注册的测试工具，避免「未知名抛错」路径混入。
- **⑫ subagent one-shot+槽位**：探针 profile 把 `maxActiveSubagents` 设为 1（确定性拒绝）；先占满槽（continuable child 存活），再派发断言 `ACTIVATION_LIMIT_REACHED`；另跑一条 one-shot 断言跑完即收+per-child options 落进请求事实。
- **⑬ ACP**：独立 spawn `dsh --profile acp`（候选树、独立临时 home、dummy LLM 环境同款注入）；runner 内置一个**最小 ACP 客户端**（手写 JSON-RPC stdio，只实现本合同用到的几个方法，不引外部 ACP SDK——保持 scripts/ 依赖零增）。断言 create/submit/cancel/list/close + 模型与 effort 选择 + **进程重启后 list/resume 持久化**。回合期间抓全部 ACP 通知，把 usage/token 可得形状写进报告附录（可得与否均通过，只有会话面行为破坏才 fail）。
- **⑭ sidecar 共享**：临时 profile 配一个本地 trivial MCP server（`scripts/lib/dsh-contracts/probe/trivial-mcp-server.mjs`，stdio 传输，只应答 initialize/tools 列表）；探针建 N=3 个 agent 消费它，runner 从进程树数该 server 的子进程数（按命令行匹配脚本路径）断言恒 1；进程关闭后断言无孤儿。

## D4. 报告形状扩展

逐条 pass/fail 行保持既有格式（零改动接入承诺不破）；⑬ 的计量面附录作为合同⑬行下的缩进附注输出（`notes: acp-metering=<shape>`），机器可读、人不误解。

## D5. 活体测量（非合同、不进 CI 门）

`scripts/measure-dsh-pod-shape.mjs`：同款临时 home+探针+dummy LLM，建 K 个会话并以大上下文播种（经探针直接 append 大量表面消息——测的是进程内存形状，与内容真伪无关），按时间采样 RSS 输出 CSV+摘要 JSON。产出数字回填 `docs/wanxing-multi-harness-runtime-explore.md` §规模数学（pod 预算定标输入）。并发吞吐形状（M1）在合同⑨现场顺带记录时序数据，不单独立档。

## D6. 备选与否决记录

- **经生产桥扩展 RPC 断言**（如给 platform-sdk-server 加 probe 代理方法）：否决——为测试动生产面，且 per-session preset 接线本就是切片②的正戏，本片先钉上游地基即可。
- **用真实 LLM 驱动委派工具断言 subagent**：否决——非确定性+排演车道依赖；探针直调服务 API 同样钉住行为依赖且更准。
- **引外部 ACP 客户端库**：否决——scripts/ 依赖零增，手写最小客户端足够。

## D7. 验收口径

- 矩阵 scratch 树（剪后形状）全量合同（v1 六条+活控三条+新五条）两轮全绿；⑨ 按既有 rc.2 限制豁免口径不重开。
- 镜像冒烟与矩阵 PR 门的接线零改动（新合同自动纳入——聚合退出码机制）。
- `docs/wanxing-multi-harness-runtime-explore.md` 规模数学节回填 M2 数字；⑬ 附录回答「ACP 计量面可得性」并同步未决问题 #2 的实证半边。
- 适配层 lint 绿（新探针/测量文件进 `scripts/dsh-adapter-files.json`）。
