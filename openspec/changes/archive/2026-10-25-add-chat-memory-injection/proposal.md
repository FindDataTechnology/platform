# add-chat-memory-injection — Proposal

## Why

S0 生产调查（台账 §15.30，2026-10-25）定案：壹座**主聊天链路对 fd-memory 的调用为零**。集群 cron 面已经闭环——add-cluster-digest-injection 的三档 digest 阶梯 + add-digest-note-recall 的 /digest L1 notes 召回，drill witness 在案（§15.33：回合→hook② 写回→/digest 召回→接棒执行）——但用户日常使用的 web 主聊天仍是无记忆冷启动：换会话、隔天回来，先前的偏好、结论、未竟事项全部重推。

写侧同时缺一个触发面：MEMORY_DISCIPLINE（memory-discipline.js，fleet persona 与 cell preset suffix 双面单一来源）只教了 handoff 纪律，没教「用户说『记住 X』时写 note」——note 工具挂载了但触发全靠模型自觉，写量稀疏（S0：u/ 根 notes 靠偶发）。

## What Changes

1. **主聊天每回合 digest 注入**：本地 web 聊天回合在 `skills.expandDocRefs` 之后、`ctx.session.prompt` 之前挂记忆三档阶梯（digest → 共享标题列表 → 原样），owner = 当前连接用户，project = `"default"`（person token `u/<email>` 的 MCP 写回落 project，fd-memory `auth.ts` namespaceParts——**读面必须 = 写面**，§15.31 补记三 t2 空块开环反证的教训）。历史行仍记 raw text。
2. **note 写纪律文本**：MEMORY_DISCIPLINE 加一行「用户明示记住 / 学到持久偏好时用 memory_write_page 记 note」（zh+en 镜像），双面自动生效且随挂载出现/消失；fd-memory note 工具描述加同义触发提示，覆盖非 dsh 的 MCP 消费面。
3. **eval note 场景**：continue-scenes 增 ≥3 个背景存于 note 的场景，digest 臂照赢——给 1/2 的读面与写触发一个可度量的验证面。

### New Capabilities

- `chat-memory`: 主聊天面的记忆注入（三档阶梯、独立开关、历史保真）与 note 写纪律的单一来源。

### Non-goals

- **u/ 根蒸馏缓议**（distill-scheduler 的 `d-` 前缀闸不动）：L1 note 召回已给 note 读面；u/ 蒸馏引入 per-owner 蒸馏成本与「平台蒸馏器读 person 根」的隐私姿态问题，须独立立项带自己的 eval。
- bridge 层全 lane 注入；bots/webhook lane、远程 fork lane、/skill 命令 lane（v1 只挂主 prompt lane，其余留后续）。

## Impact

- **代码**：paas `server/ws.js`（挂点）、`server/cluster-memory.js`（抽共享阶梯 + chat 薄壳）、`memory-discipline.js`（纪律行）；fd-memory `src/mcp.ts`（工具描述）、`fixtures/eval/continue-scenes.json`（场景）。cron-runner 既有行为零变化（由既有测试钉死）。
- **出片**：双端（platform + fd-memory）。
- **风险与回滚**：每回合 +1 次 /digest 调用（5s AbortController，降级开放不阻塞回合；embed 慢时 keyword 降级带 model_note）；`CELL_MEMORY_CHAT_DIGEST=0` 一键杀 chat 面，`CELL_MEMORY_ENABLED` 四件套总闸不变。
