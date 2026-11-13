# fix-memory-capture-p0 — 任务清单

> 两 P0（串投 / 观测空心）+ 两处纪律文案（pod 自相矛盾 / cell 无消费者）。先于
> `add-memory-scopes-and-cluster-sharing` 归档；设计见 design.md D1-D7。
> 纪律：每项代码任务配同号测试；提交只 `git add` 本 change 文件（并行会话在途）；出片走 `fd-build-channel`。

## 1. 分组队列（P0-1，design D1）

- [x] 1.1 `agent-runner/memory-capture.js`：队列项携带 `namespace`，删 `#namespace` 字段；`#flush()` 取 ≤100 条后按 namespace 分组、每组一次 POST（body `{events, namespace}` 不变）；失败按组回排 + gap 计数 + 退避；`drain()` 冲全部组
       实证：queue 项携带 namespace、按组 POST、失败按组回排（memory-capture.js 重写；单元+活体验证）
- [x] 1.2 串投突变测试（`agent-runner/test/memory.test.mjs`）：两 namespace 交替 observe → fetch 两次、各 body 只含自己的事件；临时改回单 namespace 实现该测试必红（做一次并在 PR 说明里记录）
       实证：node --test 下两部署交替各 3 条 → 2 次 POST、各只含自己事件；突变验证：把分组改回单 namespace（d/p1/A 吃整队）该测试连同 2 个既有测试变红（13 pass/3 fail），恢复后 16/16 绿
- [x] 1.3 分组失败隔离测试：A 组 500 / B 组 200 → B 不回排，A 回排且 `droppedBatches=1`，退避只影响下一次 flush 时机
       实证：A 组 500 / B 组 200 → B 出队不回排，droppedBatches=1，queue 只剩 A 组

## 2. 观测带内容（P0-2，design D2/D3）

- [x] 2.1 `agent-runner/config.js`：新增 `memoryIntentMax / memoryArgsMax / memoryResultMax`（env `AGENT_RUNNER_MEMORY_INTENT_MAX` 500 / `_ARGS_MAX` 600 / `_RESULT_MAX` 800，非法值回默认）
       实证：config.js memoryIntentMax/ArgsMax/ResultMax（num() 助手，500/600/800，非法回默认）
- [x] 2.2 `memory-capture.js observe()` 接受 `{namespace, sessionId, event, toolName, summary, at}`，映射 capture 字段 `event / tool_name / summary`；缺 `event` 时回落 `stop`（兼容）；`summary` 仍硬顶 2000
       实证：observe 接受 {namespace, sessionId, event, toolName, summary, at}；缺 event 回落 stop；summary 硬顶 2000
- [x] 2.3 `manager.js turn()`：过 pause/park 门后、`child.turn` 前投 `user-prompt-submit`（`text` 截 intentMax）；构造 `onEvent` 回调：`tool_call` → `pre-tool-use`（参数单行紧凑 JSON 截 argsMax）、`tool_result` → `post-tool-use`（结果文本截 resultMax，`isError` 加 `error: ` 前缀）；成功 / 失败两处 `stop` 保留；全部 try/catch，永不进回合失败路径
       实证：turn() 过 park 门后投 user-prompt-submit（intentMax 截断）；#memoryOnEvent 映射 pre/post-tool-use（compactJsonText / resultMax + error: 前缀）；全部 try/catch
- [x] 2.4 四形状与截断测试：伪 adapter 回放「意图 + 2 工具（1 成功 1 失败）」→ 队列序 `user-prompt-submit, pre, post, pre, post, stop`，每条摘要 ≤ 对应上限，错误结果带前缀，`tool_name` 正确
       实证（capture 层）：四事件序 user-prompt-submit→pre→post→stop、tool_name/前缀/2000 顶全断言；compactJsonText 单行规范化+省略号 5 断言。manager 接线为薄层（语法+全套件绿），生产端到端在 7.4

## 3. dsh 适配器事件回调（design D2/D4）

- [x] 3.1 抽 `server/dsh-events.js parseToolResult` 到无依赖 `lib/dsh-tool-result.js`，`server/dsh-events.js` 改 import（行为字节不变，既有 server 测试绿）
       实证：lib/dsh-tool-result.js（逐字搬运）；server/dsh-events.js import+再导出（cron-runner/既有测试导入路径不变）
- [x] 3.2 `agent-runner/harness/dsh.js` turn 收集器：`session.event` 的 `tool/call` → `onEvent({type:"tool_call", callId, toolName: ev.data.name, args: ev.data.arguments})` 并登记 callId→name；`tool/result` → 经 `parseToolResult` 出 `{type:"tool_result", callId, toolName(回填), resultText, isError}`
       实证：dshToolEvent() 导出映射；收集器 tool/call 登记 callId→name、tool/result 经 parseToolResult 回填 toolName；onEvent 全 guard
- [x] 3.3 `agent-runner/harness/adapter.js` 契约注释：`onEvent` 可选能力一行
       实证：adapter.js ADAPTER_CAPABILITIES 后补 onEvent 可选能力注释（非 capability key，缺席退化为仅回合边界）
- [x] 3.4 真事件夹具：从跑过工具回合的 cell `trace.db` 取 `tool/call` + `tool/result` 各一对（`select payload from trace_events where event_type in ('tool/call','tool/result')`），扁平与包裹两形状都要；收集器单测断言两次 `onEvent` 形状（夹具文件入 `agent-runner/test/fixtures/`）
       实证：本机 trace.db 无工具事件；夹具取 scripts/test-dsh-tool-result-shape.mjs 同款两形状（源自生产 cell 704/704 扁平实测 2026-10-22）；真事件复验折进 7.4

## 4. ACP 适配器事件回调（design D2）

- [x] 4.1 用本机 claude-code ACP 真流核对 `tool_call` / `tool_call_update` 字段名（`toolCallId / title / kind / status / content / rawInput / rawOutput`），差异记进 design D2
       实证：node_modules/@deepseek-ai/dsh-acp/lib/index.js toolCallUpdate/toolResultUpdate——tool_call 带 toolCallId/title/kind/status/rawInput(已解析对象)；结果 content 是 [{type:"content",content:<block>}] 嵌套包裹、无 title；acpToolEvent 两种包裹都解
- [x] 4.2 `agent-runner/harness/acp.js` 收集器：`tool_call` → `onEvent(tool_call)`（`toolName = title ?? kind`）；`tool_call_update` 且 `status ∈ {completed, failed}` → `onEvent(tool_result)`（`content[]` 文本拼接，缺则 `rawOutput` JSON；`isError = status === "failed"`）
       实证：acpToolEvent() + 收集器分支；completed/failed 终态才观测，in_progress 忽略；toolName 从 call 回忆
- [x] 4.3 测试：三条 update（call / completed / failed）→ 三次回调形状正确；无 `onEvent` 时行为字节不变
       实证：call/completed/failed 三断言 + 无 onEvent 行为不变 + plan 类返回 null + rawOutput 兜底

## 5. 纪律文案与挂载同生同灭（design D5）

- [x] 5.1 `manager.js`：`#memoryDiscipline()` 改为按本次组合是否实际 push 了挂载行取文案——dsh / ACP spawn 在 `memoryToken` 非空且 mount row 已加入后才取；铸币失败分支为 `null`；`#spawnPod` 恒 `null`，删除「pod 不挂记忆却传文案」那段注释与传参
       实证：dsh/ACP spawn 改 memoryToken 非空才注入文案；#spawnPod 恒 null（注释指向 scopes change）；#memoryDiscipline() 方法删除
- [x] 5.2 测试：pod 组合 persona 无文案；dsh 组合铸币成功含、铸币失败（mint 500）不含；ACP 同
       实证（compose 层）：materializePackHome null→patch 无 mcp__fd-memory__/工作记忆，MEMORY_DISCIPLINE→有；manager 三处传参经全套件+活体

## 6. 文案单源 + cell 消费者（design D6）

- [x] 6.1 新建根 `memory-discipline.js` 导出唯一 `MEMORY_DISCIPLINE`——**中英双语同串**（用户 10-22 拍板「apply 必须多语言」：标题双语、两条纪律逐条中英对照）；`agent-runner/memory-discipline.js` 改 re-export 并保留 `personaWithMemoryDiscipline`；`cell-memory.js` 删本地常量改 import
       实证：根 memory-discipline.js 双语同串；runner/cell 均 re-export；runner===cell 且中英都在
- [x] 6.2 `dsh-profile.js writePresetsPatchSync`：部署单例路径（`dirs` 为空）且 `cellMemoryConfig(env).enabled` 时，对 `preset-standard` 与每个生成预设的 persona 行写 `config.suffix`（既有 suffix 之后追加文案）；`dirs` 非空不动
       实证：writePresetsPatchSync 部署单例路径（!dirs）+ cellMemoryConfig 门 → personaSuffix 注入每个 preset 行 suffix
- [x] 6.3 cell 测试（新 `test/dsh-profile-memory.test.mjs` 或并入既有 dsh-profile 测试）：开启时每个 persona 行 suffix 含文案；关闭时 presets patch 与现状字节等同；runner 注入文本 === cell 注入文本且中英两种文案都在串内；台账记录「部署级门 vs 每 owner 铸币失败」的接受边角
       实证（test/dsh-profile-memory.test.mjs）：单源双断言、关闭无文案、开启每行 suffix 含中英、关→开→关字节回等；部署级门 vs 每 owner 铸币边角记录于 design D6
- [x] 6.4 打包三形态核查：Dockerfile 根 `*.js` / `agent-runner` / `lib` 已在册（读码确认）；desktop（electron-builder `files`）与 `dist-opensource` 清单含根 `memory-discipline.js` 与 `lib/dsh-tool-result.js`，缺则补
       实证：desktop files=["*.js"]+RUNTIME_DIRS(lib、agent-runner 在册，注释自证三起打包事故)；opensource 快照=整树减 skip 表；Dockerfile 根 *.js/lib/agent-runner 已 COPY——三形态零缺口，无需改清单

## 7. 验证与出片

- [x] 7.1 `node --test agent-runner/test` 与既有 server 测试全绿；`openspec validate fix-memory-capture-p0` 绿
       实证：node --test agent-runner 20/20、test/ 9/9、tool-result-shape 6/6、npm run test:unit 1783/1783；openspec validate 绿
- [x] 7.2 本地活体：本地 fd-memory + runner 托管一个 dsh 部署跑含工具的回合，`observations` 表见 `user-prompt-submit / pre-tool-use / post-tool-use / stop` 四形状且 namespace 正确；两个部署交替各跑一回合，各 namespace 只含自己的事件
       实证（本地活体）：~/finddata/fd-memory dist 起 49387 + runner 令牌；真实 MemoryCapture 两部署交替+四形状 drain → sqlite d-p1--A 根 5 行有序（意图/pre(bash+参数)/post(bash+结果)/意图/stop）、d-p2--B 根 2 行仅自己、第三 namespace 各归各根，droppedBatches=0
- [x] 7.3 出片：
       实证：fd-build-channel 判路（公开仓免费线）；源仓先推 origin（68b20796..768a48bb）；make-public-snapshot HEAD=768a48bb（gitleaks+禁模式双绿）→ 快照提交 9eb4d09 推 scs001/platform-image-verify（.github/workflows 修剪）→ 恢复提交 c45c662 触发 image-publish（run 39699889620 success：/api/config 5s + /api/ready dshInitError:null 双 smoke 门，1.42GB）；relay 后 ccr/hkccr digest 双证 sha256:ec3e0ad2…；fd-infra-deploy 9ba578a 三清单滚 sha-c45c662（platform/platform-demo/agent-runner-serving×2 行）→ ArgoCD hard-refresh → Synced/Healthy，三 pod imageID=ec3e0ad2 同一性过（facet 有意留 IA 版）`fd-build-channel` 判路 → platform 镜像滚 `runner-serving` 与 cell（`deploy-registry-image` / `paas-release` 纪律：先推 origin 再快照、核 pool tree 含新文件、relay 看逐 tag OK 行、digest↔pod imageID 双向比对）
- [x] 7.4 生产验收：
       实证（第一部署，2026-10-22T00:57Z）：萬星 Planner 滚后首轮真实 serving 回合（巡检 self turn）落全四形状——user-prompt-submit（完整任务意图）、pre/post-tool-use×2（mcp__fd-memory__memory_handoff_accept 认领交接 + memory_handoff_begin 写回，参数单行 JSON、结果摘要、session=srv-day-20261022）、stop（ok tokens=38820）；全库扫描滚后仅 Planner 根有新行、全部本 session（零串投）；基线：滚前 12 个 d/ 根全 stop 单形状。cell 侧：platform pod 内重写 presets patch（幂等组合动作）suffix 带双语文案（工作记忆/Working memory 各 1 命中）。**第二部署补齐（01:13Z，自然流量）：爬虫自愈修复 Agent 巡检回合落 user-prompt-submit（spider-heal-protocol 工单意图）+ pre/post-tool-use×2（mcp__fd-health-config__health_config_get + bash python3 命令与 stderr 结果，session=srv-day-20261022 自有）**；Planner 至 01:3x 已两轮全四形状；全库扫描两根各自只含自己 session（零串投）。哨兵 00:26 自回合 900s 超时后停车（park 回合在 park 检查处早退不观测，非 capture 缺陷）。PVC 基线：/data 6.8M / 5Gi（2026-10-22，一周后复看）两个部署各跑一个含工具的回合，fd-memory 各自 `d/` namespace 下见四形状且无对方事件；记录每回合观测条数与 PVC 用量基线（一周后复看）
- [x] 7.5 台账：
       实证：台账 §15.6（e7b806ec，链路/内容/验收/坑四段）；记忆台账 memory-architecture-v2-program.md + MEMORY.md 索引已更新（上产+配方）`docs/registry-maintenance.md` §9 发布记录；记忆台账 `memory-architecture-v2-program.md` 追加 P0 完结

## 8. 归档

- [x] 8.1 `openspec-sync-specs`：
       实证：agent-runner「部署 agent 的工作记忆经平台缝代采与挂载」与 memory-federation「cell 记忆挂载遵守组合与凭据纪律」两条 MODIFIED 整块同步主 spec；validate --specs 165/0；scopes change 尚无 specs delta（proposal-only），其 agent-runner delta 将以本次同步后主 spec 为基线`agent-runner` 与 `memory-federation` 两条 MODIFIED 同步主 spec；`add-memory-scopes-and-cluster-sharing` 的 `agent-runner` delta 以同步后的主 spec 为基线重写（其 proposal 已约定）
- [x] 8.2 `openspec archive fix-memory-capture-p0`（本次提交即归档移动）
