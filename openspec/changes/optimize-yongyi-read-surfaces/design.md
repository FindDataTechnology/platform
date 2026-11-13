## Context

永忆（fd-memory）是 markdown 真源 + SQLite 派生索引的单进程服务。面向 agent 的读面分散在两类出口：

- **MCP 工具面**（`src/mcp.ts`，9 个工具）——形状由每个工具自己定义；
- **HTTP 读面**（`src/http.ts`，`/digest` `/pages` `/memory` `/memory/promotions` `/admin/*`）。

2026-11-08 的两次修复（`memory_handoff_list` 10.6MB、`memory_overview` 2.2MB）证明这条出口纪律缺失的代价直接落在 fleet 回合的上下文预算上。当前仍无上限的读面、以及 `superseded` 只在一条召回路径上过滤，是同一纪律缺失的剩余部分。

另一个约束来自评测侧：`fixtures/eval/continue-baseline.json` 不入库，文档中的历史数字对应已被脱敏替换的场景集，无法用当前场景复现；当前 21 个合成场景的 note 数最多 2 条，而 note-depth 臂的触发条件是 `notes > 3`，因此该门恒为 vacuous PASS。**在尺子修好之前改召回算法，改完无法判断是变好还是变坏。**

### 生产实测（2026-11-10，cheap-ts / fd-prod，镜像 `sha-28db31e`）

在 `fd-memory-65dbd67d5d-gf8jl` 上只读取样（104 个 owner 根）：

| 量 | 值 |
|---|---|
| 页面总数 / 向量总数 | 12,518 / 4,974 |
| 最大单根 | `u-aloadtree@gmail.com`：5,079 页、2,611 向量、2,615 条 L2（facts+experiences） |
| 单页字节数（按层） | note 均 663 / max 8.2 KB；fact 均 2,702 / max 10.0 KB；experience 均 1,637 / max 10.7 KB；handoff 均 2,256 / max 6.9 KB |
| 分区数 | 最大 34 个（同一根） |
| 全库 open handoff | 562 条 |
| 向量模型 | 单一 `Qwen/Qwen3-Embedding-8B`，无跨模型残留 |

三个直接结论：

1. **单页正文不是风险点**：全库最大页 10.7 KB，`memory_read_page` 的 32 KiB 上限永远不会触发；真正的体量在聚合面（一个根 34 个分区、5,079 页、562 条 open handoff）。
2. **每回合读放大是可测的**：最大根的一次 `/digest` 要对 2,615 个 L2 文件逐文件 `readFileSync`、并全量解码 2,611 条向量；fleet 车道一回合串行 3 次 → 约 7,800 次文件读 + 7,800 次向量解码。
3. **向量安全区口径已过期**：`src/metrics.ts` 的默认阈值是单根 2,000（注释称「实测最大 304，约 6.5 倍余量」），而现网最大单根已是 2,611 —— **该根今天就已越过阈值**，注释里的实测基准与现网相差约 8.6 倍。

### 生产实测之二：工具结果字节（2026-11-10，24 个 cell 的 `trace.db`）

按工具名汇总 `tool/result` 事件（借 `tool/call` 的 `callId` 关联），近 24 小时 6,128 次结果：

| 工具 | 次数 | 合计 | 单次均值 | 单次最大 |
|---|---|---|---|---|
| `memory_handoff_list` | 297 | 3.49 MB | 12.3 KB | 27.0 KB |
| `memory_recent` | 27 | 0.14 MB | 5.4 KB | 9.1 KB |
| `memory_overview` | 10 | 0.10 MB | 10.2 KB | 22.0 KB |
| `memory_read_page` | 26 | 0.04 MB | 1.5 KB | 3.1 KB |
| `memory_query` | 78 | 0.02 MB | 0.24 KB | 4.7 KB |
| `handoff_accept` / `begin` / `write_page` | 244 | 0.04 MB | — | — |

四条结论：

1. **11-08 的两刀确实生效**：7 日窗口里 `handoff_list` 的单次最大值是 49.9 KB（撞运行时的 50 KB 天花板），24 小时窗口已降到 27 KB，且没有任何永忆工具再撞天花板（24h 内 10 次撞顶全发生在 `web_fetch` 等非记忆工具上）。
2. **`memory_handoff_list` 仍是永忆最大的单项成本**：占近 24 小时全部永忆工具字节的 **92%**。条数已夹到 20，但每行 `summary` 是全文，单次均值仍 12.3 KB —— **任务 2.4（裁单行 summary）是剩余项里价值最高的一个**。
3. **`memory_query` / `memory_recent` 的未夹取 limit 是潜在风险而非现存问题**：`query` 单次均值 0.24 KB（返回的是 snippet，不是正文），`recent` 5.4 KB。仍然要收口，但优先级低于 2.4。
4. **`memory_read_page` 的上限是纯护栏**：观测到的最大单次返回 3.1 KB，与页长分布一致（全库最大页 10.7 KB）。

### 生产实测之三：蒸馏日预算没有真正生效

`tokens.db.distill_budget` 的按日汇总：

| 日期 | 全站 tokens | 调用数 |
|---|---|---|
| 2026-11-09 | 2,742,865 | 447 |
| 2026-11-08 | 4,800,434 | 707 |
| 2026-11-07 | 1,162,856 | 123 |

单 owner 最高：`u-aloadtree@gmail.com` 在 2026-11-08 花掉 **3,734,259** tokens（324 次调用），而默认上限是 **400,000**——超 9.3 倍。

原因不是参数而是代码形状：闸门在每次运行**开始前**读一次累计用量，随后分片循环整段跑完才把花费写回账本（`src/distill-scheduler.ts:396` 检查、`:490` 写入）。因此（a）单个长跑可以一路跑到底，（b）同一 owner 的两个项目并发时都读到「已用 0」而双双通过。这是「判据在事前成立、过程中失效」的典型形态，单列在 tasks 7.3。


## Goals / Non-Goals

**Goals:**

- 把「读面返回值有界且截断自证」变成可枚举、可测试的清单，而非逐个案修补。
- 让「什么算退役页」只有一处定义，所有读面共用。
- 让一个 fleet 回合对同一 owner 的记忆读取从三次串行降为一次。
- 让评测硬门在脚本里可执行、可复算，并让「该门未运行」与「该门通过」在输出上不可混淆。

**Non-Goals:**

- 不改存储形态（markdown 真源 + SQLite 派生）、不引入外部依赖、不引入向量索引/近似检索。
- 不改免费纪律（无计量面、无付费墙、无授权闸）。
- **本变更不改召回融合算法**（加权和 / RRF / rerank）——见 D5。
- 不改蒸馏的 `CHUNK=2` 分片参数——见 D7。

## Decisions

### D1. 上限以「字段级自证」实现，不做响应级字节截断

每个读面的上限写成一个具名常量（可被 env 覆盖），响应带 `truncated` 与总量字段；受影响的正文型读面同时给出继续读取的游标。

| 读面 | 上限 | 自证字段 |
|---|---|---|
| `memory_query` / `memory_recent` | 条数夹取到 `[1, 50]`，默认 20 | `total` / `truncated` |
| `memory_read_page` | 正文按字节上限分段（默认 32 KiB，与 `OBSERVE_BODY_CAP_BYTES` 同源） | `truncated` / `total_bytes` / `next_offset` |
| `memory_handoff_accept` | 单字段上限（summary ≤ 4 KiB、`open_questions`/`next_steps` ≤ 20 项 × 500 字、`files_touched` ≤ 200 项） | `truncated` + 被截字段名 |
| `memory_handoff_list` | 单行 summary 截 200 字符 | 行内标记 + `truncated` |
| `/memory/promotions` | 跨分区总量 100 条 | `total` / `truncated` / `total_partitions` |

**为什么不做响应级截断**（例如把整个 JSON 响应切到 N 字节）：切 JSON 会产出不可解析的载荷或静默丢字段，调用方无法区分「没有这一项」与「被切掉了」。这正是 2026-11-08 那两次修复的判据——截断必须自证，不能把被截断的页报告成完整。

**备选方案**：只夹 `limit` 不夹正文。否决，因为 `memory_read_page` 没有 `limit`，整页正文是当前最大的单点风险。

### D2. `memory_read_page` 用字节偏移分页，而不是行号

`offset` 是 UTF-8 字节偏移，返回片段在字符边界对齐（不得切断多字节字符），`next_offset` 指向下一个未返回字节。不传 `offset` 时返回首段。

**为什么用字节而不是行**：markdown 页的行长分布不均（表格行可达数千字符），按行分页会出现「一页几十字节」或「一页几百 KB」；字节偏移让每次返回体量可预测。代价是调用方需要把 `next_offset` 原样回传，不能自己算。

**兼容性**：默认上限 32 KiB 高于当前绝大多数页的体量，正常读取行为不变；超限页的行为改变（截断 + 自证），需要文档明示。

### D3. `superseded` 关系物化成边表，读面用一条判定

现状是 `supersededIds()` 每次调用扫 `pages.supersedes` 全表并逐个 JSON 解析，且只有 `/digest` 的召回路径调用它。改为：

- 写入 `indexPage()` 时解析 `supersedes` 并落到 `superseded_edges(superseded_id, by_id, project)`，带索引；
- 读面（`searchPages` / `recentPages` / `recentNotes` / `queryNotes` / `recentObservationPages`）统一用 `EXISTS (SELECT 1 FROM superseded_edges WHERE superseded_id = p.id)` 排除退役页；
- 边表是派生数据，可由 reindex 重建。

**为什么不保留「读时解析 JSON」**：判定成本从 O(全表 JSON 解析) 降到一次索引探测，且所有读面共用同一条 SQL 谓词，避免「同一个服务两套存活答案」。**为什么不加缓存**：缓存会引入失效窗口，而这是正确性问题，不是性能问题。

### D4. 多根 digest 走「一次请求 + 统一预算」，旧单根形状字节不变

新形状接受多个根并在一次请求内合并，响应每条带 `source` 标注（现有 `sourceOf()` 已具备）。预算仍是**一次**执行：多根不放大总预算，段间按现有语义等分。

**为什么不改成「并行三次」**：并行只压延迟，不压固定读成本（每次仍要全量读 L2 候选、全量解码向量、读 1000 行 pageMeta），且三次并发对单进程 SQLite 是负收益。**为什么保留旧形状**：`project=<单根>` 的字节必须不变，已部署的 SDK 才能平滑过渡。

**发布顺序**：fd-memory 先支持双形状 → SDK 发版支持多根 → 平台侧切默认。三步之间任何一步失败都可停在「单根 ×3」，不产生记忆丢失。

**实现后的一处更正（2026-11-10）**：D4 原先的收益口径是「一回合 3 次读降为 1 次」。实现时发现三次调用不是三个分区，而是**(根, 身份)** 三元组：

| 段 | 令牌 | 根 | 分区 |
|---|---|---|---|
| own | 成员（deployment） | `d/<fleetId>` | 成员自己的分区 |
| shared | 成员（deployment） | `d/<fleetId>` | `shared` |
| legacy | person（owner） | `u/<owner>` | `f/<fleetId>` |

一次 HTTP 请求只携带一个 `Authorization`，所以 own 与 shared 能合并（同一根同一身份），legacy 不能。实际收益是 **3→2**；要到 3→1 必须让 person 令牌经 oversight 一次读其名下的 d 根与 u 根，那是授权模型的改动，不属于本变更。任务 6.4 的目标已按此改写，不再断言一个做不到的数字。

### D5. 本变更只修「死档」与可观测性，不动融合权重

现状确认的两处缺陷可直接修：

1. `search_keys` 的 ×2 档从未生效——写入只落进 body 的 `search_keys:` 行（`src/store.ts:275-282`），读取只读 `frontmatter.search_keys`（`src/distill.ts:34`）。修法：写入时同时落 frontmatter，读侧对存量页回落到 body 行解析。
2. `/digest` 的 L2 补充元数据只对 `[project]` 建 map，循环却查 `shared` 路径，导致 shared 分区页永远没有 `updated_at`/`confidence`。

融合算法本身（向量整段优先、关键词 `score:-1` 补位、无阈值无 rerank）**留到下一个 change**，理由是本变更的 D6 会先把尺子修好；在基线不可复现时改排序权重，等于用一把不知道准不准的尺子量改动。

### D6. 评测门由脚本自身计算，且「未运行」是一等结果

- 脚本输出三组数字及各自分母：全集胜率（旧口径）、headroom 校准胜率（`none ≤ 3`）、全集非劣率（`digest ≥ none − 1`），全部写入基线。
- note-depth 臂在分母为空时输出「未运行」并排除出整体通过条件，**不得**记 PASS。
- 场景集补足「注入 note 数 > L1 段容量」的深场景，使该门有真实分母。
- 基线记录绑定场景集版本与代码版本；运行手册给出可重放命令。脚本从构建产物导入的问题在任务中单列（跑 `src` 或先构建）。

**理由**：一个恒为真的判据等于没有验收（`vacuous PASS`），而「空集当通过」会把「没做」读成「做对了」。

### D7. 蒸馏分片参数不动，只加度量

`CHUNK=2` 是应对引擎完成度截断的实证参数（历史上 4 条交接 → completion 6000 → 静默返回空结果）。为了少发几次请求而加大分片，会把「省调用」换成「静默丢产出」，属于用可见成本换不可见损失。本变更只把每次运行的 `items / llm_calls / tokens` 分布并入指标面，等真实 token 账出来再决定是否批量。

## Risks / Trade-offs

- **[`memory_read_page` 默认截断改变既有行为]** → 默认 32 KiB 覆盖绝大多数页；截断带 `truncated` 与 `next_offset`；上限可配；文档在发布说明中明示。
- **[边表回填不全导致旧页复活或新页被隐藏]** → 边表由 reindex 全量重建；回填后自检「边数 = 全表 supersedes 展开数」，不一致即失败而非静默。
- **[多根 digest 改变预算分配]** → 保持等分语义，并用「单根请求字节不变」的对照测试钉住。
- **[SDK 形状变更影响已部署平台]** → 双形状兼容期 + 三步发布顺序；平台侧保留退回单根三次的开关。
- **[评测改动后历史数字不可比]** → 基线记录显式标注旧场景集不可复现，不沉默陈留；新基线从零开始计。

## Migration Plan

1. fd-memory：建 `superseded_edges` + 索引 → reindex 回填 → 自检边数；读面切换谓词。
2. 读面上限与 `read_page` 分页：延迟到同一次发版，env 可放宽以支持回滚。
3. 评测脚本与场景集：先补口径与深场景，再跑一次新基线（旧基线标注不可复现）。
4. SDK 多根支持发版；平台切默认单列，可回退。
5. 回滚：边表可 drop（派生数据）；上限可通过 env 放宽；SDK 单根路径始终保留。

## Resolved Questions（2026-11-10 实测后结案）

- `memory_read_page` 默认上限：**取 32 KiB**。全库最大页 10.7 KB，该上限当前永不触发，属防御性护栏；真正需要自证截断的是聚合型读面。
- `/memory/promotions` 总量帽：**取 100 条**。最大单根 34 个分区，上限 100 条低于"34 × 每区 50"的理论最大值，会真实触发截断，符合设计意图。
- 新增待办（不在本变更范围，但已被实测证伪）：`src/metrics.ts` 的向量安全区基准写着「实测最大 304」，现网最大单根 2,611 已越过 2,000 阈值。该口径与文档需要独立修订，并据此重新评估全表扫描是否仍是可接受方案。

## Open Questions

（无。上述两项已由 2026-11-10 的只读取样定值。）

