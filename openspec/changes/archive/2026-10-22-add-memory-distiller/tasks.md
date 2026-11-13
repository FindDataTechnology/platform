# Tasks — add-memory-distiller

## 1. fd-memory：页型、cursor 与预算底座

- [x] 1.1 db.ts：`distill_state(project, obs_cursor, handoff_cursor, updated_at, last_error, last_tokens, gaps)` 表（RootDb）；pages 索引行加 forgotten 过滤口径（`pages.forgotten` 派生自真源 frontmatter，索引层维护）。验证：单测建表幂等 + forgotten 页在 searchPages/recentPages 全读口消失。
- [x] 1.2 okf/store：fact / experience 页型写入助手（frontmatter 形状=sources/supersedes/confidence/generated.by，`details ≤4000` 截断、过 sanitize）；写后过既有审计。验证：单测两页型 round-trip + reindex 后 frontmatter 完整、supersedes 指向的旧页逐字节不变。
- [x] 1.3 tokens.db：`distill_budget(owner_key, day, tokens, llm_calls)` 表 + 日限额扣账/查询（超限判定）。验证：单测跨 root 聚合同 owner、跨日自动重置、超限拒绝。

## 2. fd-memory：调度器与候选检索

- [x] 2.1 `src/distill-scheduler.ts`：capture 批末 session-end/stop 标 pending（去抖 5min）、10min 兜底扫描（cursor 落后 ≥200）、同 project 串行 / 跨 project 并发 ≤2、sidecar 超时 180s + 指数退避封顶 1h、双门（DISTILLER_URL / DISTILL_ENABLED）。验证：单测（mock fetch）触发/去抖/失败保 cursor/预算停/门关零调用。
- [x] 2.2 候选检索：project+shared 内 experience/fact 按 task+search_keys FTS→LIKE top-8，空退全量 ≤8；过滤 forgotten 页与 superseded 目标。验证：单测命中排序、shared 参与、forgotten/superseded 不入候选。
- [x] 2.3 DistillResult 落库：写 fact/experience 页（含 supersede 链）、cursor 前进仅在成功时、tokens 入预算账、gaps/last_error 记账。验证：单测成功前进 / 失败不前进 / 超限记 gap。

## 3. sidecar：引擎 #1 与三集成条件

- [x] 3.1 服务骨架：Python 容器（FastAPI/http.server）`POST /distill`（DISTILLER_SHARED_TOKEN 头）、pin hy-memory、requirements 钉版本 + 补丁目录。验证：容器内自测请求 round-trip（无 LLM 的形状校验档）。
- [x] 3.2 C1+C3：复刻 extract 内部序列（build_extract_prompt→complete→**json_repair**→_parse_output；reconcile 同理），每次 complete 记 llm_calls{stage,tokens,elapsed,error}，DistillResult.errors 上报，异常不吞。验证：S1 s02 损坏 JSON fixture 修复不丢 + s08 超时 fixture 显性报错（pytest）。
- [x] 3.3 C2：提示词补语言钉行 + 产物后检（中文会话 task 非 CJK 记 warning）。验证：pytest 用 S1 中文 fixture 断言 task 语言。
- [x] 3.4 脱敏与 lane：产物正文/details 过与 fd-memory 同款脱敏（移植 sanitize 为 Python 等价）；LLM 仅词元车道 env。验证：pytest 密钥 fixture 四类全红acted。

## 4. fd-memory：可见性面

- [x] 4.1 `GET /memory`（person-only，scope/layer/since/until/limit/offset，条目带 layer/sources/project）。验证：单测筛组合 + agent 令牌 403 + person 不见他人 root。
- [x] 4.2 `POST /forget`（confirm 必填、frontmatter forgotten_at、deletePageIndex、审计 op=forget、真源保留）。验证：单测三场景（forget 后全读口不现 / 无 confirm 拒 / 蒸馏候选不吃）。

## 5. 评测 v1

- [x] 5.1 零 LLM 档进 npm test：页型 reindex、layer/sources 出参（mcp 读口扩展）、supersede、预算闸、forget、cursor 幂等。验证：`npm test` 全绿（含既有 23 项不回归）。
- [x] 5.2 LLM 档 `scripts/eval-distill.mjs`：S1 fixture 重放走真 sidecar——关键词命中、task 语言、s10/s11 多 agent 去重回归、成本/调用基线输出；无 MEMORY_LLM_* 跳过。验证：本地跑出基线数字并与 S1（0.84 命中、去重全过）比对。

## 6. 出片与滚产

- [x] 6.1 fd-build-channel 判路 → fd-memory 与 fd-memory-distiller 双镜像出片（池/公开线按判路；digest 双证）。验证：两镜像 digest 在 hkccr=ccr 一致。
- [x] 6.2 fd-infra-deploy：sidecar Deployment（同 ns）+ fd-memory env 三枚（URL/ENABLED/DAILY_TOKENS，默认开门）→ gitee → ArgoCD。验证：四?清单 Synced/Healthy、sidecar /healthz 通。

## 7. 生产开门与验收

- [x] 7.1 开门后观察首批真实会话蒸馏：distill_state cursor 前进、L2 页落库带 generated.by、预算账目、mcp 读口带 layer/sources 眼见。验证：生产 DB 查询 + /admin/report。
- [x] 7.2 LLM 档评测对生产数据抽样跑一遍（基线入档）；回滚演练：关 DISTILL_ENABLED → capture/交接照常、cursor 不动。验证：演练日志 + 恢复开门续跑。
- [x] 7.3 台账（registry-maintenance §15.8）+ 主 spec 同步（memory-distiller / memory-visibility 新建 + fleet-memory 3 MODIFIED + Purpose 行「零 LLM」措辞同步）+ 归档（validate --specs 0 failed）。
