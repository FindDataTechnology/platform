# Proposal — add-fleet-artifact-handoff

## Why

接棒/扇出只转述**散文**（上游结果 ≤2000 字）。上游明明产出了图表、表格、文档，
下游却只读到一段描述——于是它要么重新生成一遍（再付一次钱，还常落到不同结果），
要么停在"我拿不到那个文件"。

而产物**早就被平台收好了**：回合产出的文件由 `resources.captureFilesFromTurn` 自动收进
资源库（`resources` 表，带 `session_id` / `file_path` / 内容哈希），只是**从没跨过边**。
explore P2-3 记的就是这条：「产物只能传散文（无句柄/附件）」。

## What Changes

- 新增资源库读取口 `resources.artifactsForSession({sessionId, sinceMs, limit})`：
  取该会话在**该回合窗口**内的条目，返回 `{id, type, title, filePath, createdAt}`。
- 接棒与扇出的 persona 目标 prompt SHALL 追加「上游产物」段：
  ```
  【上游产物】上游回合产出了以下可寻址产物——直接用它们，不要重新生成：
  - 资源库 <id>「<标题>」 · workspace: <相对路径>
  ```
  位置：散文之后、`{{fleetEdgeContext}}` 之前。
- `igniteFleetEdges` 改为 async（两个调用方本来就 `await`）；产物读取**降级放行**
  （无 db、表缺失、读失败一律当"没产物"，接棒照常）。
- 只给 persona：a2a 是另一服务（库标识无意义），tool 的 prompt 必须是纯 JSON 参数。

## Impact

- Affected specs: `agent-fleet-orchestration`（1 处 MODIFIED：handoff 边接棒）
- Affected code: `resources.js`（`artifactsForSession`）、`server/fleet-handoffs.js`
  （产物段 + async）
- 无迁移、无新表：读的是既有 `resources` 表，写路径一行未改。
