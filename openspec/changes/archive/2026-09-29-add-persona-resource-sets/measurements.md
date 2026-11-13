# Measurements: add-persona-resource-sets

Probe: `scripts/probe-pack-scope.mjs`（新增 per-persona 报告与 `--auth`）。
Roster 数字来自对部署真实 store 组合两份 patch 并活测每服务工具数；token
数字来自 `--turn-trace`（同一 prompt、同一模型，usage 从 trace 事件读回）。

## fd-prod — 2026-09-29，sha-c1665d4 上线实测

PACK_BASELINE_MCP=websearch；细胞上已装包：数据-中国经济 v3（**唯一已装包**，
mixed 声明：skills=["china-macro-brief-workflow"]（该名被用户技能占用 → 按安装
报告真值跳过）, mcpServers=["fd-open-data-mcp"]）。

### Roster（per-persona，probe part 1）

| 模式 | servers | MCP tools | 明细 |
| --- | --- | --- | --- |
| full | 5 | 116 | fd-open-data-mcp 70、fd-cn-report 44、websearch 2；law-bench / fd-find-data-business-mcp 401（见下） |
| focused（pack-industry-analyst-macro，声明子集） | 2 | 72 | fd-open-data-mcp 70 + websearch 2（基线） |

**Δ = −44 tools（−38%）**：声明把已安装但未声明的 fd-cn-report（44 工具）从
聚焦面剔除 —— 相比 v1 未声明时代（3 服务 116 工具）的削减完全来自声明本身。
技能面 = 基线 only（声明技能在细胞上非包所有，compose root 如约为空）。

余下 401：law-bench（「invalid or missing access token」——lawbench 自有鉴权
域，非 registry token）与 fd-find-data-business-mcp（拒 registry token）。
两行为改造前既有（上一变更 rollout 时同样 401），不影响 roster 计数，只影响
活测工具数。

工具带核对：72 高于提案预估的 20–40 带 —— fd-open-data-mcp 单服务即 70 工具，
声明机制已把可减的（fd-cn-report 44）减掉；再往下裁是后续 overlay（变更②）
或上游 per-server 工具裁剪的事。

### Turn trace（probe part 2，--auth）

prompt「请用中文简要说明你能访问哪些工具和数据源，并举一个使用场景。」，
model deepseek/deepseek-v4.1-flash（volces）：

| 模式 | inputTokens | outputTokens |
| --- | --- | --- |
| full (standard) | 8 842 | 296 |
| focused（声明子集） | 9 013 | 206 |

净差 +81（噪声级；输出 −90）。解读：该运行时的工具 schema 并非逐 turn 全量
入 context（按需加载），所以 roster 削减的直接 token 收益在单 turn 上不显著；
上一变更的 scratch 实测（−671/turn，cache-read 列主导）说明缓存列才是主要
变量。硬收益仍是 roster 削减本身（连接数、失败面、列举成本）。

### 种子包重发（D8）

| 包 | 版本 | 声明形态 |
| --- | --- | --- |
| 法律-合同 | v1（未动） | 未声明 —— 零迁移默认的活样本 |
| 法律-案件 | v3 | mcpServers-only ["law-bench"]（技能维缺省=整包） |
| 数据-股票 | v3 | 空 {}（仅基线的语义样本；未安装） |
| 数据-中国经济 | v3（细胞已升级） | mixed：skills+mcpServers 双维声明 |

注：发布脚本一次重跑造成 v2/v3 为同内容重复快照（版本不可变追加，v3 现行，
无影响）。升级安装报告：agent installed；fd-open-data-mcp / fd-cn-report
reused；技能 skipped（同名用户技能所有）——安装报告即真值。

### 为量测铺路的既有故障修复（运维实录）

- **MARKET_REGISTRY_TOKEN 过期**（2026-09-28 到期的旧值，上一事故的 M2M
  修复未落到该 secret 或已被覆盖）：经 Logto `mcp-gateway-m2m`
  （resource=`https://mcp.finddatatech.cloud/api`）重新铸 1h token，patch
  platform-secrets + rollout。**1h 过期 —— 下次重启前需换 168h 正签**
  （registry UI 续签），同上一事故的遗留要求。
- **五个 MCP 行内嵌过期 token**（credentialRef 机制之前的旧装法，行内
  Authorization 头早已失效，运行时靠 failOnStartupError:false 静默带病）：
  四个 registry 前置服务改写为 `{url, credentialRef:"registry"}` 现行装法
  （open-connector 的静态 token 原样保留——非 registry 域）。
- **machine-owner 凭据行**已播种（probe 以 owner=null 组合时解析；
  1h 过期后自然失效）。
- **探针三处修复**：Accept 头笔误 `text-event-stream`→`text/event-stream`
  （registry gateway 406 的根因）；PROTOCOL_VERSION 2025-03-26→2025-06-18；
  新增 `--auth`（WS + trace 读回带 Bearer，过 AUTH_MODE=mp）。

### Ops checklist（提案附带项）

- `PACK_BASELINE_MCP` 复核：现值 `websearch`（2 工具）对全部角色族合理，维持。
- 部署 `skills/` 基线审计：`/app/skills` 未随本变更改动；fd-prod 五个包技能
  均为用户行（非包所有），所有 persona 的技能面=基线，与安装报告真值一致。
