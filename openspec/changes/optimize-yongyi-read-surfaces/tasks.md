## 1. 先量一次（在改之前拿到真实数字）

- [x] 1.1 取一份现有读面实测：从 cell 的 trace.db 按工具名统计 `memory_*` 结果字节分布（总量 / 单次最大值 / p99），并从 `/admin/metrics` 取各 root 向量条数、`digest` 各档计数与蒸馏 token 账。产出 `reports/yongyi-read-surface-baseline.md`，逐项列出数字与取样窗口；verify：报告里每个数字都能指到具体的表/端点与时间范围，缺数项写明「未取到」而非留白
  - 2026-11-10 部分完成：已取到 104 根 / 12,518 页 / 4,974 向量的分布（见 design.md 的「生产实测」），结果写入 design.md 而非独立报告。**未取到**：/digest 各档计数（指标只在内存里，取它需要 root token）。已补取：cell 工具结果字节分布与蒸馏 token 账，见 design.md 同段。
- [x] 1.2 取线上页长分布（L1 note / L2 fact / L2 experience 各分位的 `body` 字节数），用于给 `memory_read_page` 的默认上限定值。verify：报告含三类的 p50/p90/p99/max，并据此写出选定值与「多少比例的页会受影响」
  - 2026-11-10 完成：note 均 663 / max 8.2 KB；fact 均 2,702 / max 10.0 KB；experience 均 1,637 / max 10.7 KB；handoff 均 2,256 / max 6.9 KB。max < 32 KiB → 默认上限取 32 KiB（永不触发的防御性护栏），结论已写入 design.md。

## 2. 读面上限与截断自证（P0，与 11-08 同型）

> 2026-11-10 实测后的顺序（24 个 cell 的 trace.db，近 24h）：`memory_handoff_list` 占全部永忆工具字节的 **92%**（297 次 / 3.49 MB / 单次均值 12.3 KB），其余工具合计不到 0.3 MB。因此 2.4 升为最高价值项，2.1/2.2/2.5 降为「潜在风险收口」——它们今天几乎不被触发。

- [x] 2.1 `memory_query` 与 `memory_recent` 夹取条数参数到 `[1, 50]`（默认 20），响应补 `total` / `truncated`。verify：新增测试覆盖「传 10000 只回 50 且 `truncated=true`、`total` 为真实总量」；传 0/负数回落到默认值
  - 2026-11-10 完成：query/recent 夹到 [1,50]（默认 20），total 由同一条语句的窗口函数给出（不另写 count，避免两份逻辑漂移）；测试覆盖 10000→50、0/负数回落默认、`_total` 不外泄。
- [x] 2.2 `memory_read_page` 增加字节上限与 `offset` 分页，返回 `truncated` / `total_bytes` / `next_offset`；按 UTF-8 字符边界对齐。verify：测试覆盖「超长页首段截断且 `truncated=true`」「按 `next_offset` 连续两次读完与整页逐字节相等」「多字节字符不被切断」
  - 2026-11-10 完成：offset/limit_bytes 分页，UTF-8 边界回退；测试覆盖「超长页首段截断」「按 next_offset 连续读与整页逐字节相等」「多字节字符不被切断」。
- [x] 2.3 `memory_handoff_accept` 对 summary / `open_questions` / `next_steps` / `files_touched` 逐个设上限并回报被截字段名。verify：测试构造超限交接，断言被截字段在 `truncated_fields` 中列出、未超限字段逐字节不变
  - 2026-11-10 完成：summary 4 KiB、两个列表各 20 项 × 500 字、files 200 项，回报 truncated_fields；未截字段保持原字节。
- [x] 2.4 `memory_handoff_list` 单行 summary 截断到 200 字符并带行内标记。verify：测试断言 20 行全部 ≤200 字符且标记出现时 `truncated=true`
  - 2026-11-10 完成：单行 summary 截 200 字，行内 summary_truncated + 页面级 truncated_summaries；实测该工具占永忆工具字节 92%。
- [x] 2.5 `/memory/promotions` 加跨分区总量帽（缺省 100），响应带 `total` / `truncated` / `total_partitions`。verify：测试构造 40 个分区 × 各 3 条待晋升，断言返回 ≤100 条且 `truncated=true`、`total_partitions=40`
  - 2026-11-10 完成：跨分区总量帽 100（env 可调），返回 total/truncated/total_partitions；测试覆盖 40 分区 × 3 条 → 120 总量、≤100 页、truncated=true。
- [x] 2.6 把上述上限集中成一份具名常量表并允许 env 覆盖，与既有 `OBSERVE_BODY_CAP_BYTES` 同源。verify：测试断言「env 放宽后上限随之变化」；`grep` 确认没有第二处硬编码的同一数值
  - 2026-11-10 完成：上限集中在 buildTools 的 envInt 常量表；grep 确认 32 KiB 仅两处（observe 的捕获帽 + read_page 的读帽，语义不同不算重复）。

## 3. 退役页判定下沉（P1）

- [x] 3.1 建 `superseded_edges(superseded_id, by_id, project)` 表与索引，在 `indexPage()` 写入时解析 `supersedes` 落边。verify：测试写入一条带 `supersedes: [x]` 的页后，边表存在 `x → 新页`，重复写入不产生重复边
  - 2026-11-10 完成：`superseded_edges(superseded_id PK, by_path, project)` + 索引；`indexPage` 每次写入先删旧边再落新边，`deletePageIndex` 双向清理。测试覆盖「重复写入不产生重复边」「改写去掉 supersedes 后旧边被撤回」。
- [x] 3.2 reindex 全量回填边表，并加自检「边数 = 全表 `supersedes` 展开去重数」，不一致即失败退出。verify：在含存量 supersede 的夹具根上跑 reindex，自检通过；人为破坏一条边后自检必须失败
  - 2026-11-10 完成：`rebuildSupersedeEdges()` 幂等重建；`supersedeEdgeAudit()` 比对「边数 = 目标去重数」；`/admin/reindex` 在审计不过时回 500 而不是静默服务。首次开库时若边表为空且存量页有 supersedes 会自动回填一次。测试覆盖「reindex 后自洽」「删空边表后审计失败」。
- [x] 3.3 `searchPages` / `recentPages` / `recentNotes` / `queryNotes` / `recentObservationPages` 统一加退役页排除。verify：测试断言「经 `memory_query` 查主题只返回新页」「经 `memory_recent` 不出现旧页」；且带 `include_superseded` 显式参数时旧页可见并标注取代者
  - 2026-11-10 完成：`searchPages` / `recentPages` / `recentNotes` / `queryNotes` 统一用 `aliveSql()` 排除退役页；MCP `memory_query` / `memory_recent` 新增 `include_superseded` 显式历史开关。测试覆盖「检索面/新近面都看不到退休页」「显式开关后可见」。
- [x] 3.4 移除 `/digest` 召回路径中重复的全表 JSON 解析（`supersededIds()`），改用同一谓词。verify：测试断言 digest 输出与改动前对同一夹具逐字节相同；`grep` 确认没有第二处 supersede 判定
  - 2026-11-10 完成：`supersededIds()` 改为读边表（不再每次 digest 全表解析 JSON）；`distill.js` 的候选活跃集也改读同一张表，顺带修掉「被请求集外的 supersede 指不到的页仍可见」这个旧缺陷。grep 确认判定只剩 `aliveSql()` 与边表两处、且同源。

## 4. 召回死档与标注缺陷（P1）

- [x] 4.1 `search_keys` 写入 frontmatter（保持 body 行不变），读侧对无 frontmatter 字段的存量页回落到 body 行解析。verify：测试断言「写入后 frontmatter 含 search_keys」「存量页（仅 body 行）仍能命中 ×2 档」；一组 title/keys/body 三档对照用例分数符合 3:2:1
  - 2026-11-10 完成：`writeDistillPage` 把 search_keys 写进 frontmatter（body 行保留，供读正文的人）；读侧对无该字段的存量页回落解析 body 行。测试断言三档顺序（title 3 > keys 2 > body 1）且存量页仍落在 ×2。
- [x] 4.2 修 `/digest` 的 shared 分区补充元数据：pageMeta 覆盖本次请求涉及的全部根。verify：测试断言 shared 分区的 L2 候选带非空 `updated_at` 与 `confidence`
  - 2026-11-10 完成：`/digest` 的 pageMeta 改为覆盖本次请求读到的全部根（`[project, "shared"]`）。测试构造 shared 分区候选，断言摘要里带出置信度与日期。

## 5. 评测闸门可执行（P1，必须在 6 之前完成）

- [x] 5.1 脚本输出三组数字及各自分母：全集胜率（旧口径）、headroom 校正胜率（`none ≤ 3`）、全集非劣率（`digest ≥ none − 1`），并写入基线记录。verify：用固定夹具跑一次，断言三组数字与手算一致，且输出里能看到各自分母
  - 2026-11-10 完成：门的算法抽成 `src/continue-gate.ts`（纯函数、无 I/O），脚本只负责喂数据与打印。输出与基线都含四组数字+各自分母：全集胜率（旧口径，仅对照）、headroom 校准胜率（`none ≤ 3`）、全集非劣率（`digest ≥ none − 1`）、首步胜+平率。4 条单测用手算夹具验算，不是跑一次截图。
- [x] 5.2 note-depth 门在分母为空时输出「未运行」并排除出整体通过条件。verify：测试断言「21 场景（note ≤2）下该门为 `not_run` 且整体裁决不因它判通过」
  - 2026-11-10 完成：note-depth 三态 `pass / fail / not_run`。`not_run` 带原因输出且被排除出通过条件；跑过且失败仍然判 FAIL。单测覆盖「无 digest+distill 样本」「全部已在天花板」「有头部空间但增量不足」「增量达标」四种。
- [x] 5.3 场景集补足深 note 场景，使至少 2 个场景的注入 note 数超过 L1 段容量而触发该门。verify：测试断言这些场景下该门有非空分母且实际执行
  - 2026-11-10 完成：新增 `deep-3` / `deep-4`，各 7 条 note，承载期望背景的两条按新近排第 6、7 位。离线核查（复刻 digest 臂的召回路径）确认 plain digest 对这批背景 **0/3 可见**——门有真分母。场景集 21 → 23，`validateScenes` 通过。
- [x] 5.4 基线记录绑定场景集版本与代码版本，并在运行手册给出可重放命令；对不可复现的历史基线做显式标注。verify：从一条基线记录出发，按手册命令可重跑并得到同裁决（或在标注为不可复现时明确失败并说明原因）
  - 2026-11-10 完成：基线记录带 `code_version`（git rev）、`scenes_sha`（场景集指纹）与 `replay`（可直接重放的命令）；`docs/eval-continue.md` 明写 run5–run15 产生于已被脱敏替换的场景集、**不可复现**，新基线从 2026-11-10 起算。
- [x] 5.5 修评测脚本从构建产物导入的问题（跑 `src` 或强制先构建）。verify：改动 `src` 中一处可观测输出后直接跑评测，断言该改动生效（无需手动 build）
  - 2026-11-10 完成：脚本启动先 `npm run build`，失败即中止；`EVAL_SKIP_BUILD=1` 可显式跳过。静态 import 改为动态 import 以保证构建先于加载。

## 6. 多根 digest（P0.5，跨仓三步，每步可停）

- [x] 6.1 fd-memory `/digest` 接受多个根并在一次请求内合并，预算统一执行、每条带来源标注；单根形状字节不变。verify：测试断言「多根请求的条目来源可辨」「同一夹具下单根请求响应与改动前逐字节相同」「多根总预算不超过单根上限」
  - 2026-11-10 完成：`/digest` 接受 `projects`（可重复或逗号分隔），一次请求、**一次预算**、逐条带分区标注（渲染进括号 + 响应 `projects`/`sources`）。召回跨分区（`hybridCandidates` 改吃分区集合，候选带 `project`）；部署/ pod 令牌逐分区校验授权，任一分区无权即整单 403。单分区形状未动（参数、检查顺序、错误形状、无来源标记与多余字段都保持原样，既有断言原封通过）。
  - **未达成 3→1**：legacy 段是另一个根 + 另一种令牌（person vs member），一次请求带不了两个身份。3→1 需要跨身份设计，留给 6.2/6.3。
- [x] 6.2 SDK 支持多根调用，保留单根路径为默认。verify：SDK 测试覆盖两种形状；对同一夹具两形状的合并结果集合相等
  - 2026-11-10 完成：`readDigest(..., { mergeOwnShared: true })` 发一次 `?projects=<member>,shared`（一次预算 = 两片），legacy 仍单独；分段变为 `["own+shared","legacy"]`。**默认路径不变**：仍是三次单段读、三段标签、`fleet-digest-block.txt` 金样逐字节通过。老服务端不认 `projects`（400）时退回两段单读，三段一段不少（有对应用例）。包版本**未动**（仍 0.1.3）——发版需要版本前滚 + 6.3 平台切换。SDK 62 测绿。
- [ ] 6.3 平台侧切默认多根，并保留退回单根三次的开关。verify：开关两态各跑一次回合，断言注入块内容等价；关掉开关时行为与改动前一致
  - **代码已落、端到端未验**（2026-11-10）：`FD_MEMORY_DIGEST_MERGE_OWN_SHARED=1` 时把 `mergeOwnShared` 传进 `readDigest`；默认关。已装 SDK 是 0.1.3（该选项 0 处引用），所以杠杆今天惰性——单测只钉住接线形状（选项仅在 flag=1 时出现、budget 不变），**「两态注入块等价」做不到，要等 SDK 发版后用真实回合验**。
- [ ] 6.4 回合读放大与延迟回归：记录切换前后单回合 `/digest` 调用次数与耗时。verify：报告显示调用次数 p99 不高于改动前，且调用次数下降的幅度与实际设计一致
  - **目标已按实际能力改写（2026-11-10）**：原写「3→1」在当前设计下不可达——legacy 段是**另一个根 + 另一种身份**（person 令牌 vs 成员令牌），一次 HTTP 请求带不了两个身份；本次实际把 own 与 shared 合成一次，期望 **3→2**。要到 3→1 需要 person 令牌经 oversight 一次读自己名下 d 根与 u 根的跨身份设计，属授权模型改动，不在本 change。
  - 未执行：切换依赖 6.3 的端到端，而 6.3 依赖 SDK 发版。

## 7. 蒸馏成本度量（P2，只加观测不改参数）

- [x] 7.1 每次蒸馏运行的 `items / llm_calls / tokens` 分布进入指标面。verify：跑一次蒸馏后能从 `/admin/metrics` 读到该次的三项计数，与日志行中的数字一致
  - 2026-11-10 完成：`/admin/metrics` 的 `distill.recent` 给出最近 ≤200 次成功运行的 items/calls/tokens 分布（total/mean/max + tokens p50/p90 + 最后一次明细）；失败不计入样本。对应用例断言空集回 null 而不是 0。
- [x] 7.2 基于 1.1 与 7.1 的真实 token 账，写出是否调整分片参数的结论（改或不改，都需给数字依据）。verify：结论文档引用具体数字；若建议改，必须同时给出「加大分片导致完成度截断」的验证方式
  - 2026-11-10 完成：`docs/distill-cost-tuning.md`。结论=**不改 CHUNK=2**，依据是现网账（`u-aloadtree@gmail.com` 2026-11-08：3,734,259 tokens / 324 次 = 11,525/次，上限 400k）+ 代码里记录的完成度截断探针（4 条 → completion 6000 → 静默空产出）。同文指出下一个更干净的杠杆是「同一次运行内复用候选集」，并说明为什么它不碰完成度上限。
- [x] 7.3 **日预算闸门实测失效，需要修**：现网 `u-aloadtree@gmail.com` 单日花掉 3,734,259 tokens，而 `FD_MEMORY_DISTILL_DAILY_TOKENS` 默认 400,000 —— 超 9.3 倍。原因在代码形状而非参数：闸门是每次运行**开始前**读一次已用量，随后分片循环整段跑完才把花费写回账本（`src/distill-scheduler.ts:396` 检查、`:490` 写入），因此单个长跑或两个并发项目都能穿过闸门。修法：把检查移进分片循环（每次调用前比一次累计值），并让账本在每次调用后增量写。verify：测试构造「初始已用 399k + 一次 10 万 token 的批次」，断言第二轮分片被拒绝且账本增量正确；再用并发两个项目复现「双穿」，修后必须只有一个通过
  - 2026-11-10 完成：闸门移进分片循环 + 每次调用后增量记账 + 同 owner 串行化。测试三条：长跑在第二片停（2 次调用 / 2600 tokens，旧形状是 3 次 / 3900）、并发两项目只允许一个通过（抽掉串行闸该测试即红——已实测）、停在闸上时记 gap 且保留游标。

## 8. 收尾

- [x] 8.1 全量测试与 `npm run leak-check` 通过。verify：`npm test` 全绿且 leak-check PASS
  - 2026-11-10：`npm test` 196 passed / 0 failed（起点 181），`leak-check` 137 tracked files / 0 hits。
- [x] 8.2 更新 `README.md` 的工具面表格与 `docs/DEPLOYMENT.md` 的读面上限说明（含 `read_page` 分页与 env 覆盖）。verify：文档中出现的每个上限值与代码常量一致
  - 2026-11-10 完成：README 增「读面上限表 + 退役页单一判定」，DEPLOYMENT 增环境变量覆盖清单与两个自愈派生结构（`page_id`、`superseded_edges`）及 reindex 自检说明。文档里出现的每个上限值都与代码常量一致。
- [x] 8.3 `openspec validate optimize-yongyi-read-surfaces --strict` 通过。verify：命令退出码为 0
  - 2026-11-10：退出码 0。
