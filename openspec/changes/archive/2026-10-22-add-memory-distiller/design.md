# Design — add-memory-distiller

## S1 Spike 裁决（2026-10-22）

**裁决：过门（附 3 条集成条件）。** Hy-Memory `CodingMemoryExtractor`（scene=working）+
`build_experience_reconcile_prompt()` / `CodingMemoryReconciler._parse_ops()` 可作 fd-memory L2 蒸馏引擎 #1。
核心判据——多 agent 共享去重（同一问题第二个 agent 再问，引擎 UPDATE/SKIP 既有经验而非重复 ADD）——两遍全过；
成本约 7.5k tokens/会话，远低于 40k 门槛；琐碎会话 0 经验；JSON 经 json_repair 后 0 硬失败。
不过门备选（mem0 / TencentDB memory-core）**不启动**；S3 **不启动**。

### 设置（与 proposal 的偏离须知）

| 项 | 取值 |
|---|---|
| 引擎 | Hy-Memory `main`（depth-50 clone，2026-10-22）；只 import `coding.extractor` / `coding.reconciler` / `coding.types` / `agent.llm_provider` / `config` / `pipelines.base`，无 Chroma/Kuzu |
| LLM | 词元车道 `deepseek-v4.1-flash`（推理模型，usage 含 reasoning_tokens），base `…/v1`，temperature 不传，timeout 120s，provider 内重试 2 |
| 抽取 / reconcile | `max_tokens` 6000 / 2000；`scene="working"`；中文输入自动路由 `EXTRACT_PROMPT_ZH` / `RECONCILE_PROMPT_ZH` |
| 测试集 | **12 段合成会话**（用户 10-22 明示无真实转录可用，偏离 proposal「20 段真实转录」）：A 余额 3 / B 消耗表 3 / C 集群 3 / D 交接 2 / 琐碎对照 1，全部取材 as-built 真实事件（台账），dsh 形状（assistant.tool_calls + role=tool），每段 7-10 条消息、2-5 次工具调用 |
| 候选 | 无 embedding 召回：候选 = 指定来源会话沉淀进池的**全量**经验（≤8），同一候选集喂每条 draft；落池规则镜像 `_execute`（越权 target 丢弃、未处理 draft 兜底 ADD） |
| 跑法 | 2 遍独立（候选池每遍从空起），抽取并行 4、reconcile 按会话顺序串行 |
| 产出 | `/tmp/memory-survey/s1/{fixtures.py, run_s1.py, s1_results.json, s1_run.log}`；持久副本 `paas/.zcode/memory-s1/`（不入库） |

### 数据（两遍）

| 门 | 判据 | 遍 1 | 遍 2 | 结果 |
|---|---|---|---|---|
| G1 琐碎负例 | 0 经验 | 0 | 0 | **PASS**（fact 两遍都写了 1 条薄记录，见发现 8） |
| G2 生产率 | A/B/C 9 段 ≥7 产经验 | 7/9 | 9/9 | **PASS**（遍 1 的 2 段缺失是解析/超时损失，非价值判断，见发现 5/6）；D 弧线 2/2、2/2 |
| G3 关键词命中 | expected_experience 组 ≥70% | 24/31 = 0.774 | 28/31 = 0.903 | **PASS** 均值 0.839；fact 关键词 0.826 / 1.0 |
| G4 subject 稳定性 | 跨遍记录 | 7/9 可比对逐字相等（77.8%） | | INFO（见发现 3） |
| G5 reconcile | s11 多 agent 去重 SKIP/UPDATE；s10 跨域不误改 | s11 `UPDATE→exp_s10_0`；s10 ADD、A 条目零改写 | 同 | **PASS** 两遍 |
| G6 成本 | ≤40k tokens/会话 | max 10,702 / mean 7,212 | max 10,200 / mean 7,776 | **PASS**；两遍合计 173,944 tokens / 38 次调用；reasoning 占 ~17% / ~14% |
| G7 解析 | json_repair 后 100% | 原生 16/17 + 1 可修 | 原生 20/20 | **PASS** 硬失败 0（见发现 5） |
| G8 中文 | 记录 | task 55.6% / solution 66.7% / fact 100% | task 54.5% / solution 72.7% / fact 100% | INFO（见发现 4） |
| G9 调用稳定 | 记录 | s08 网关 4 连超时整段丢 | s08 超时 1 次后重试成功 | INFO（见发现 6） |

reconcile 观察（soft，不进门禁）：s05 `UPDATE→exp_s04_0`（修复覆盖诊断，两遍一致）；s02 遍 2 `UPDATE→exp_s01_0`（复验流程并入诊断经验）；s03/s06/s08/s09 ADD（判「任务不同」，理由文本准确）。

### 发现

1. **多 agent 共享去重成立（核心判据）。** s11（agent-handoff-2）重问 TCR 100-tag 上限，候选含 s10（agent-handoff-1）沉淀的经验 + A 弧线 3 条余额经验，两遍均判 `UPDATE→exp_s10_0`，理由原话：「已有 exp_s10_0 描述同一 TCR tag 配额超限清理任务；新 draft 更新了具体仓库为 fd-infra/gateway……按规则用新 draft 替换」。无重复 ADD。
2. **跨域判别成立。** s10 面对 3 条余额/403 候选判 ADD，理由原话：「现有 candidates 分别涉及 API 充值后网关/部署复验和集群恢复后 403 排查，均与镜像仓库 tag 配额超限清理不是同一任务；无重复或可更新目标」。无跨域 UPDATE/DELETE。
3. **subject 作硬键：机器标识符稳，中文自由短语漂。** 文件路径 / 主机 / 邮箱 / registry 路径类 subject 两遍逐字相等（`platform-test@findmail.com`、`web/src/pages/UsageTable.tsx`、`hkccr.ccs.tencentyun.com/paas/agent` 等 7/7）；中文名词短语漂移 2 例（`cheap-2 deploy/agent-api` vs `cheap-2 上的 deploy/agent-api (namespace serving)`；`console 消耗表` vs `wanxing/console:v2 消耗表`）——同一实体、不同措辞，精确相等闸门会把它们当两个主体。与 Hy-Memory 自己把 `HY_FACT_SUBJECT_GATE` 默认关闭的理由一致。**含义**：我方 fact 覆盖判定不能只靠 subject 相等，要「subject 规范化 + 语义/LLM 判定」双路。
4. **中文：fact 稳、experience 漂。** fact statement 两遍 100% 中文；experience 的 `task` 仅 ~55%、`solution` ~70% 中文——zh 提示词下模型仍常整条输出英文（s01/s05/s06/s08/s09）。`task` 是检索主键，英文 task 对中文查询有跨语惩罚。**集成条件 C2**。
5. **解析：原生 36/37，1 例可修。** 遍 1 s02 模型在 JSON 字符串里多写了一个未转义引号（`'"'`），`json.loads` + 首尾花括号兜底均失败，`json_repair` 可完整修复；但 **抽取器本体没挂 json_repair**，原生路径该会话整段丢失（0 经验 0 事实）。**集成条件 C1**。
6. **调用失败被引擎静默吞掉。** `CodingMemoryExtractor.extract()` 捕获 LLM 异常后返回 `([], [])`，cache=None 时无任何记录——从调用方看与「没东西值得记」无法区分。遍 1 s08 网关 4 连超时（provider 2 次 × harness 外层未触发，因异常已被吞）即如此丢失；遍 2 同会话重试 1 次后 13s 成功，说明是网关抖动非提示词问题。**集成条件 C3**。
7. **成本比 proposal 预估低。** proposal 估「每会话 3-4 次调用、中文提示约 1 万字」；实测抽取 1 次（~5.5k tokens）+ 有候选时 reconcile 1 次（~4k），fact reconcile 未跑（S1 只判经验层）。推理模型 reasoning_tokens 计入 completion，占 ~15%。
8. **价值门槛只管经验层，事实层总会写。** 琐碎会话（打招呼 + 一次 `date`）两遍 0 经验，但各写 1 条薄 fact——这是抽取器契约（「ALWAYS write the fact … only greetings and pure chatter get null」），不是缺陷。**含义**：L2 事实层的量要靠我方 cursor / 去抖 / 预算控制，不能指望引擎过滤。
9. **抽取质量样例。** s01 把「零花费探针分型（max_tokens=4 或 /v1/models）→ 403 带码查 sub2api 余额 → `--all` 对照同池账号」整套含命令的流程抽成一条可复用 solution，boundary_envs 钉了端点/模型/env 名/脚本；s05 UPDATE 覆盖 s04 诊断（修复替代诊断、不留历史）符合经验层语义。关键词真漏项都是具体标识符被泛化（`49242b5`、`A-only`），solution 仍保留了方法。

### 过门附带的 3 条集成条件

- **C1 解析层挂 json_repair**：sidecar 不直接用 `extract()` 的返回，而是拿原文经 `json_repair` 后再喂 `_parse_output` / `_parse_ops`（或在 fork 契约层补一行）。
- **C2 `task` / `search_keys` 语言钉**：提示词补「task/search_keys 用与会话相同的语言」一行，或 sidecar 后处理检测非 CJK 时翻译；评测 v1 加「task 语言 = 会话语言」断言。
- **C3 调用失败显性化**：sidecar 注入 cache（走 `_store_coding_log`）或包住 `llm_provider.complete` 记录每次调用，`DistillResult` 上报 `llm_calls / errors`，让「没抽到」与「调用失败」在我方账目里分开；失败会话保留 cursor 不前进。

### S1 未覆盖（apply 阶段或评测 v1 补）

- 真实转录（合成集可控但偏理想，真 dsh 事件里工具输出更长更脏，`tool_result_max_bytes=2048` 截断的影响未量）。
- 事实层 reconcile（`WorkingFactReconciler`）只抽未判覆盖；subject 规范化方案（发现 3）在 apply 时定。
- embedding 召回候选（S1 喂全量 ≤8 条；真系统 top-3 by task+search_keys）——漏召回会把该 UPDATE 的判成 ADD，属 fd-memory 检索层责任。
- 并发 4 下网关 1/24 丢失率是否随并发升高（发现 6）。

## 其余设计决策（S1 过门后、apply 前展开；基线=add-memory-scopes-and-cluster-sharing 已归档的 v2 as-built）

### D1 蒸馏坐标：per-project scope，observations rowid 水位作 cursor

- 蒸馏 scope = 一个 project（v1 只开 `d/` 成员 project——runner 观测最完整；person `/hook` project 留 `FD_MEMORY_DISTILL_PERSON=1` 门后开，默认关）。产物写回同 project，跨 project 共享结论仍由 agent 经 `target: shared` 自助搬运——蒸馏不越 project 写。
- cursor = 该 project `observations` 表 rowid 水位（含 handoff 截止时间的双水位：obs_rowid + handoff created_at，取 max 验证单调）。新表 `distill_state(project, obs_cursor, handoff_cursor, updated_at, last_error, last_tokens)`（RootDb，per-root）。
- 幂等边界：items 按 cursor 起取且严格含端点（下次从 cursor_next 续），同 cursor 重跑喂同 items——S1 已证引擎在相同输入下 reconcile 稳定。

### D2 页型与检索层标注：frontmatter 为真源，layer 是派生

- fact / experience 页型直接落 frontmatter（proposal 的字段形状），目录 `<project>/facts/<id>.md`、`<project>/experiences/<id>.md`；okf 的 frontmatter 保留 + reindex 按 frontmatter.type 索引天然覆盖，页型识别零新增（验证场景即钉）。
- `layer` 不落盘——由条目类型推导（observation→L0；handoff/note/session→L1；fact/experience→L2），mcp 读口与可见性面在出参时计算；`sources[]` / `supersedes[]` 自 frontmatter 透传。候选检索（D6）与 forget 过滤同理读 frontmatter。

### D3 sidecar 形状：不信任 `extract()` 的返回值——三条件全在包一层实现

- Python 3.11-slim 容器 `fd-memory-distiller`：pin `hy-memory`（requirements 钉版本；提示词补丁按 fork 纪律放补丁文件目录，不 clone 不 vendor）。HTTP `POST /distill`（ClusterIP 仅集群内 + `DISTILLER_SHARED_TOKEN` 头互信），fd-memory 为唯一调用方。
- **C1+C3 的落地方式**：sidecar 不调 `CodingMemoryExtractor.extract()`（它吞错、无 repair），而是同形复刻其内部序列——`build_extract_prompt()`（zh/en 自动路由）→ `LLMProvider.complete()`（原文留痕）→ `json_repair` → `_parse_output`；reconcile 同理（`build_experience_reconcile_prompt` → complete → repair → `_parse_ops`）。每次 complete 记 `{stage, prompt_tokens, completion_tokens, elapsed, error?}` 进 `DistillResult.llm_calls`——「没抽到」与「调用失败」自此在账目上分开（S1 发现 6 的根治）。
- **C2**：提示词末补一行「task / search_keys MUST use the same language as the conversation」+ 产物后检（task 非 CJK 且会话为中文时记 warning 入 llm_calls 审计，评测断言钉住；不改写产物——改写是下一刀的事，先可观测）。
- LLM 仅词元车道（`LLM_API_KEY` 路由 DeepSeek 端点，S1 同款：temperature 不传、timeout 120s、provider 内重试 2）；推理模型 reasoning 计入 tokens。

### D4 调度：进程内、去抖、单并发、门控

- fd-memory 单实例内 `DistillScheduler`：capture ingest 批末见 `session-end`/`stop` 且 project 属 `d/` → 标 pending（去抖窗 5 分钟合并同 project）；每 10 分钟兜底扫 cursor 落后 ≥200 观测的 project。同 project 串行（Map 锁），跨 project 并发 ≤2（对 sidecar）。
- sidecar 超时 180s / 5xx → 记 `distill_state.last_error`、cursor 保留、退避（连续失败指数退避封顶 1h）。总开关 `FD_MEMORY_DISTILLER_URL`（空=调度器不启动，等价回滚杆）+ `FD_MEMORY_DISTILL_ENABLED=1` 双门。

### D5 预算：tokens.db 全局表、按 owner 日限额、护栏非对账

- `distill_budget(owner_key, day, tokens, llm_calls)`（tokens.db，跨 root 聚合——owner_key = root 的 owner 部分）。默认日限 `FD_MEMORY_DISTILL_DAILY_TOKENS=400000`（S1 实测 ~7.5k/会话 ≈ 53 会话/日/owner，起步宽裕）；超限：该 owner 当日停止蒸馏、`distill_state` 记 gap、次日零点自动续。计费真源仍是 sub2api；本表是护栏与可见性，不用于对账。

### D6 候选检索：v1 无 embedding，FTS/LIKE top-8（S1 全量喂法为空时兜底）

- candidates = 该 project + shared project 内 experience/fact 页按 task+search_keys 关键词（FTS trigram 短词退 LIKE）取 top-8；检索为空则退 S1 形状（全量 ≤8）。**已知风险（S1 未覆盖节）**：漏召回会把该 UPDATE 的判成 ADD——评测 v1 记录重复率指标观测，embedding 召回留 v2.2 与向量检索同刀。

### D7 可见性：person-only 读面 + forget 逻辑删

- `GET /memory?scope=&layer=&since=&until=&limit=&offset=`（person 令牌，仅自己 root；条目=页面索引行+观测，带 layer/sources/project/时间）；`POST /forget {path, confirm: true}`——frontmatter 落 `forgotten_at`、`deletePageIndex` 剔除、审计 op=`forget`、真源文件保留。agent 令牌 403（spec 钉死）。候选检索与 supersede 目标解析均过滤 forgotten 页。

### D8 评测 v1：两档进 CI

- 零 LLM 档（`npm test` 常跑）：页型 reindex 识别、layer/sources 出参、supersede 不改旧页、预算闸、forget 三段（不现/无确认拒绝/蒸馏不吃）、cursor 幂等。
- LLM 档（`scripts/eval-distill.mjs`，有 `MEMORY_LLM_*` 才跑）：S1 fixture 重放走真 sidecar——任务关键词命中、task 语言断言（C2）、多 agent 去重回归（s10/s11 双景）、成本与调用数基线输出。引擎/提示词/检索变更必跑并比对基线数字。

### D9 部署与回滚

- 上线序：fd-memory 先滚（调度器双门关）→ sidecar Deployment（build-pool 出片、同 ns、镜像 pin）→ 开 `DISTILLER_URL`+`ENABLED` → 观察首批真实会话蒸馏。回滚 = 关门或 scale sidecar 0（cursor 全保留，无损失）；已写 L2 批清 = 按 `generated.by` 前缀脚本 + reindex（台账记录配方）。
- 新增部署物：`fd-memory-distiller` Deployment（cheap 与 fd-memory 同 ns/同节点域）；fd-memory env 三枚（URL/ENABLED/DAILY_TOKENS）。

### Risks / Trade-offs

- [中文 task 漂（S1 发现 4）] → C2 提示词行 + 后检 warning + 评测断言；改写留后刀。
- [漏召回→重复 ADD] → 评测记重复率观测；embedding 同 v2.2。
- [推理模型 reasoning token 吃预算] → 预算护栏按总 tokens 计（含 reasoning），S1 基线 ~15% 已入账。
- [hy-memory 上游漂移] → pin 版本 + 补丁目录；契约层对齐，升级必过评测门。
- [fact 层薄记录灌量（S1 发现 8）] → cursor 去抖（D4 的 200 观测兜底阈值）+ 预算闸；fact 频率监控进 admin/report。

### Open Questions

（无——S1 未覆盖项已各自转为设计决策或观测指标；subject 规范化双路判定随事实层 reconcile 留 v2.1，不阻塞本刀。）
