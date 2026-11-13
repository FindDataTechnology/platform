# Design — fix-memory-capture-p0

## Context（as-built 读码结论，2026-10-22；兼作 §13 S2「manager 从 dsh 事件流能看到什么」的产出）

- **串投根因**：`agent-runner/memory-capture.js` 只有一个 `#namespace` 字段，`observe()` 每次覆盖，`#flush()` 把整队 `events` 用最后那个 namespace 一次 POST（`body: {events, namespace: this.#namespace}`）。同 manager 托管多部署时，A 的事件排队后 B 一 observe，A 的事件就落 B 的 namespace。fd-memory `/capture` 按批次 namespace 落 observation（`capture.ts ingest(rootKey, project, events)`），服务端无从纠正。
- **观测空心根因**：`manager.js #memoryObserve` 只在 `turn()` 成功 / 失败两处被调，summary 恒为 `"${kind} turn ${outcome} tokens=N (Nms)"`。工具层事件在两个 harness 收集器里**到了但被丢**：
  - dsh：`harness/dsh.js` turn 收集器 `if (method !== "session.event") return;` 之后只处理 `assistant/message`，`tool/call`（`ev.data.{callId,name,arguments(JSON 字符串)}`）与 `tool/result`（`ev.data.message.content[0].{toolCallId,content[],isError}` 或扁平 `message.content[]`，见 `server/dsh-events.js parseToolResult`）直接落空。
  - ACP：`harness/acp.js` 收集器只认 `agent_message_chunk` / `usage_update`；ACP 规范的 `tool_call`（`toolCallId,title,kind,status,rawInput`）与 `tool_call_update`（`status: completed|failed`，`content[]`/`rawOutput`）未接。
  - 入站意图 `text` 在 `manager.turn(entry, sessionId, text, …)` 手里，从未进观测。
- **capture API 已够用、不必改**：`CaptureEvent.event ∈ {session-start, user-prompt-submit, pre-tool-use, post-tool-use, stop, session-end}`，字段 `session_id / agent / tool_name / tool_input / summary(≤2000, sanitize 四类) / at`。四形状观测恰好一一对应。
- **纪律文案自相矛盾**：`#memoryDiscipline()` 只看 `this.memory` 是否存在，不看本次组合有没有真的 push 挂载行——`#spawnPod` 注释自承「pod 不挂记忆」却仍传 `memoryDiscipline`；dsh / ACP 路径铸币失败降级时同样注入文案。
- **cell 纪律无消费者**：`cell-memory.js cellMemoryMount()` 返回 `{mcpEntry, discipline}`，`dsh-profile.js` ≈968 只用 `mcpEntry`。cell 的 persona 文本在 `writePresetsPatchSync` 经 `composePresetRows(persona)` 写进 dsh-persona 行的 `prefix`；`@deepseek-ai/dsh-persona` 0.2.0 schema 另有 `suffix: z.string().default("")`（`lib/index.js:25`）——纪律挂 suffix 不碰各预设 prefix。
- **文案双源**：`agent-runner/memory-discipline.js`（英文）与 `cell-memory.js MEMORY_DISCIPLINE`（中文）是两份文本。
- **打包面**：平台镜像 runtime 阶段 `COPY /app/*.js ./` 与 `COPY /app/agent-runner ./agent-runner`、`/app/lib ./lib`、`/app/server ./server` 均在册（Dockerfile ≈196-270），根模块 / runner / lib 互相 import 不缺层；desktop 与 dist-opensource 清单在任务里逐一核（「打包类缺口三形态」教训）。

## Goals / Non-Goals

- Goals：① 观测永不串投（突变测试钉死）；② L0 带内容（四形状 + 工具名 + 截断摘要），distiller 接上即有料；③ 纪律文案与挂载同生同灭；④ cell persona 吃到纪律且与 runner 单源。
- Non-Goals：namespace 形状 / pod 令牌与挂载 / `agentId` 派生 / Scope-Grant（`add-memory-scopes-and-cluster-sharing`）；fd-memory 服务端任何改动；L2 蒸馏（`add-memory-distiller`）；dsh 的 `tool_update` 部分结果（dsh 无此事件）。

## Decisions

### D1 分组队列：事件自带 namespace，flush 按 namespace 成批

`MemoryCapture.observe({namespace, …})` 把 namespace 写进每条队列项；`#flush()` 取队首 ≤100 条后按 namespace 分组，**每组一次 POST**（body 仍为 `{events, namespace}`，API 不变）。失败语义按组：某组 HTTP 失败只把该组回排、计一次 gap、退避重排；其它组与回合不受影响。`drain()` 冲全部组。去掉 `#namespace` 字段。

替代方案「每 namespace 一个 MemoryCapture 实例」被否：实例数随部署数增长、定时器成倍，且 drain / 退避状态分散。

### D2 事件级代采缝：harness adapter 的可选 `onEvent`

`turn(sessionId, text, { onDelta, onAsk, agentKey, onEvent })` 新增可选回调，归一化形状：

```
{ type: "tool_call",   callId, toolName, args }          // args: 原始参数（dsh JSON 字符串 / ACP rawInput 对象）
{ type: "tool_result", callId, toolName?, resultText, isError }
```

- dsh（`harness/dsh.js`）：收集器在 `session.event` 分支增加 `tool/call` → `onEvent(tool_call)`、`tool/result` → `onEvent(tool_result)`；`toolName` 由收集器内 `callId→name` 映射回填（dsh 的 result 事件不带工具名，同 `server/dsh-events.js T.toolNames` 做法）。
- ACP（`harness/acp.js`）：`sessionUpdate === "tool_call"` → `onEvent(tool_call)`（`toolName = title ?? kind`）；`"tool_call_update"` 且 `status ∈ {completed, failed}` → `onEvent(tool_result)`（`resultText` 取 `content[]` 文本块拼接，缺则 `rawOutput` JSON，`isError = status === "failed"`）。字段名以 claude-code ACP 真实流核对为准（任务 4.1）。
- `harness/adapter.js` 契约注释加一行：`onEvent` 可选；不实现则只有回合边界观测——与主 spec「不要求 harness 自带 hooks」一致。
- 回调里任何异常由 manager 侧 try/catch 吞掉，永不进回合失败路径。

### D3 L0 形状（S2 产出）与截断分工

manager 在 `turn()` 组装四形状，经 `memory.observe()` 直投 capture API：

| 时机 | capture `event` | `tool_name` | `summary` | 上限 env（默认） |
|---|---|---|---|---|
| `child.turn` 之前（已过 pause/park 门） | `user-prompt-submit` | — | 入站 `text` 头部 | `AGENT_RUNNER_MEMORY_INTENT_MAX`（500） |
| `onEvent(tool_call)` | `pre-tool-use` | toolName | 参数紧凑 JSON（单行） | `AGENT_RUNNER_MEMORY_ARGS_MAX`（600） |
| `onEvent(tool_result)` | `post-tool-use` | toolName | 结果文本头部；`isError` 时前缀 `error: ` | `AGENT_RUNNER_MEMORY_RESULT_MAX`（800） |
| 回合落定（成功 / 失败） | `stop` | — | 现有 `"${kind} turn ${outcome} tokens=N (Nms)"` | （不变） |

`agent` 字段统一 `platform-manager`（现状）；`at` 由 observe 补。截断在 runner（上限进 `config.js`，与 `AGENT_RUNNER_MEMORY_*` 同族）、脱敏在 fd-memory（既有 `sanitize` 四类 + 2000 硬顶）——不在 runner 重复脱敏，单处纪律。参数摘要用与 Hy-Memory `_compact_args` 同样的「单行 JSON + 省略号」形状，S1 已证明抽取器读得懂。

观测体积：每回合从 1 条变 2 + 2N 条；fd-memory PVC 5Gi 加一个观察点（任务 7.4），不在本 change 做配额。

### D4 `parseToolResult` 单源：抽到 `lib/dsh-tool-result.js`

runner dsh 适配器需要与 cell 完全相同的结果解析（dsh 生产事件是扁平形状，单测夹具喂包裹形状曾让线上全空——`dsh-tool-result-flat-shape` 教训）。把 `server/dsh-events.js parseToolResult` 原样搬到无依赖模块 `lib/dsh-tool-result.js`，`server/dsh-events.js` 与 `harness/dsh.js` 同引。夹具：从跑过工具回合的 cell `trace.db` 取真事件（`select payload from trace_events where event_type in ('tool/call','tool/result')`），两形状各一。

### D5 纪律文案与挂载同生同灭

`#memoryDiscipline()` 改签名为按「本次组合是否实际加入了挂载行」返回：dsh / ACP spawn 路径在拿到 `memoryToken` 且 push 了 mount row 之后才取文案；铸币失败（现有 fail-open 分支）→ 无文案；`#spawnPod` 在 scopes change 挂载到位前恒 `null`（去掉现在那段自相矛盾的注释与传参）。`memory-discipline.js personaWithMemoryDiscipline` 不变。

### D6 文案单源：根 `memory-discipline.js`（双语）

新建仓库根 `memory-discipline.js`（与 `cell-memory.js` 同层，三种打包形态里根 `*.js` 已随 cell-memory.js 在册）导出唯一 `MEMORY_DISCIPLINE`——**中英双语同串**（用户 2026-10-22 拍板「apply 必须多语言」）：标题双语、两条纪律逐条中英对照，总长 ~700 字符。`agent-runner/memory-discipline.js` 改为 `export { MEMORY_DISCIPLINE } from "../memory-discipline.js"` 并保留 `personaWithMemoryDiscipline`；`cell-memory.js` 删本地常量改 import。单测断言 runner 注入文本 === cell 注入文本、且同时含中英两种文案。

cell 消费：`writePresetsPatchSync` 在**部署单例路径**（`dirs` 为空）且 `cellMemoryConfig(env).enabled` 时，对 `preset-standard` 与每个生成预设的 persona 行写 `config.suffix = MEMORY_DISCIPLINE`（追加到既有 suffix 之后）；`dirs` 非空（runner 私有 home）不动——runner 自己在 persona 文本里追加。门取部署级配置而非每 owner 铸币结果：预设覆盖文件是部署单例，无法按 owner 分叉；某 owner 铸币瞬时失败时文案在而工具缺的边角按既有 fail-open 接受（任务 6.3 记录这一点进台账）。

### D7 回滚与开关

- 既有总杆 `AGENT_RUNNER_MEMORY_ENABLED=0`：观测与挂载全停，行为回到 v1 之前。
- cell：`CELL_MEMORY_ENABLED=0` 行与文案一并消失（spec「关闭回零」含文案）。
- 新增三上限 env 均有默认值，缺省即生效；不新增杆。

## Risks / Trade-offs

- 观测条数 ×(2+2N)：短期靠 fd-memory 侧 SUMMARY_MAX 与 runner 截断控体积；PVC 观察一周。
- ACP 字段名若与 claude-code 实流不符，观测退化为仅回合边界（D2 兜底），不致失败；任务 4.1 用真流核对。
- 双语文案使 runner 现有英文注入变为中英对照（既有单测只断言「含该字符串」，不绑文本）；长度 ~700 字符，dsh-persona prefix/suffix 均无上限约束。
- `writePresetsPatchSync` 多了对 `cell-memory.js` 的 import：两者同在根层，无打包缺口；desktop / opensource 清单任务 6.4 核。

## Test Plan（全部进 `agent-runner/test/memory.test.mjs` 与新 `test/dsh-profile-memory.test.mjs`）

1. 串投突变：两 namespace 交替 observe 各 3 条 → fetch 被调 2 次，各 body 只含自己的事件；把分组逻辑改回单 namespace 该测试必红。
2. 分组失败隔离：A 组 500、B 组 200 → B 事件不回排、A 回排且 gap=1。
3. 四形状与截断：伪 adapter 回放 1 意图 + 2 工具 → 队列为 `user-prompt-submit, pre, post, pre, post, stop`，摘要长度 ≤ 各上限，`isError` 结果带 `error: ` 前缀。
4. dsh 收集器：真事件夹具（扁平 + 包裹两形状）→ `onEvent` 两次形状正确，`toolName` 由 callId 回填。
5. ACP 收集器：`tool_call` + `tool_call_update(completed)` + `tool_call_update(failed)` → 三次回调形状正确。
6. 纪律条件化：pod 组合 persona 无文案；dsh 组合铸币成功有、失败无。
7. cell：`CELL_MEMORY_ENABLED=1` 时 presets patch 每个 persona 行 suffix 含文案；=0 时与现状字节等同；runner 与 cell 文案同一字符串。

## Rollout

本地 `node --test agent-runner/test` 绿 → 本地 runner 活体（一个 dsh 部署跑含工具回合，本地 fd-memory `observations` 表见四形状）→ 出片（`fd-build-channel` 判路；platform 镜像滚 `runner-serving` 与 cell）→ 生产验收：两个部署各跑一回合，各自 `d/` namespace 只含自己的事件且含 `pre-tool-use`/`post-tool-use` → 台账 `docs/registry-maintenance.md` §9。
