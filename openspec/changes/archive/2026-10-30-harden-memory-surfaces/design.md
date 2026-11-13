# Design: harden-memory-surfaces

## Context

`src/http.ts` 906 行，是全仓最大文件；`src/test/` 12 个文件 90 个测试，但**没有 `http-routes.test.ts`**。路由层的输入边界目前靠 `digest.test.ts` / `digest-lane.test.ts` / `reference.test.ts` 间接碰到（它们通过 `MemoryServer` 实例打真端口），但没有一份「输入 → 响应」的契约清单。

当天撞出的空 `q` 缺陷正是这个形态：不是逻辑错，是**没有一个测试钉住「空白 q 该走哪一档」**。这类缺陷的特点是——实现对了就不响、实现错了也不报，只有真机出过事故才知道。

向量侧：`db.allPageVectors(model)` 用 `SELECT page_rel, vector, dim FROM page_vectors WHERE model=?` 全表取回，JS 里逐条 `DataView` 解 Float32Array。当前最大单根 304 条 / 全局 1065 条，单次解 1.2k–1.3k 个 float，微秒到毫秒级。但 `db.ts` 里那句注释（「page count is small: tens to low hundreds」）是**唯一的规模防线**，没有监控、没有阈值、没有文档数字。

## Goals / Non-Goals

**Goals**
- 把已出过事故的边界行为钉成测试，使同类回归在测试阶段就失败。
- 让向量规模从「注释里的假设」变成「运维可见的事实 + 超阈亮灯」。
- 把安全区的数字写进文档，与阈值同源。

**Non-Goals**
- 不引入 ANN/向量索引（当前规模不需要，且近似检索与向量一致性诉求冲突）。
- 不改全表扫描的实现。
- 不新增 HTTP 路由、不改变任何既有响应形状。
- 不做覆盖率数字指标本身（测试到位即可，不为百分比凑测试）。

## Decisions

### D1 路由边界测试用真端口、真 MemoryServer，不 mock

沿用 `digest.test.ts` 既有范式：起一个 `MemoryServer` 在 ephemeral 端口，铸令牌，用 `fetch` 打真请求，断言状态码与响应体。

- **为什么不用 mock**：本仓路由的坑几乎都在参数解析与 scope 判定的交界处（`q ?? ""`、scope.kind 分支、clamp 表达式），mock 掉这些就等于不测。且 `digest.test.ts` 已证明该范式可靠（7 个测试）。
- **测试文件命名**：`src/test/http-routes.test.ts`，按路由分组（`/digest`、`/pages/mutate`、`/pages/write`、`/memory`）。

### D2 空查询档必须单独计数，不进 vector_ratio 分母

已由 `fix-digest-adaptive-embed-deadline` 落地为 `rung=empty`。本 change 的测试面要把这条钉死：空 q 的响应 MUST 不含 `model_note`，且指标里 `empty` 计数增加、`vector_ratio` 不受影响。

- **为什么写在本 change**：那是行为修复，这是**回归防护**。两处一起看才知道为什么「empty 档」要存在——单看任一处都容易误改回去。

### D3 向量规模指标走既有 `/admin/metrics`，新增一节

在 `metricsSnapshot()` 现有结构外新增 `vectors.scale: { roots, total, max_root, over_threshold, threshold }`。

- **为什么不开新端点**：`/admin/metrics` 是运维唯一入口，探针也读它（`scripts/probe-embedding-lane.mjs` 已在用）。加一节零新面。
- **阈值配置**：`FD_MEMORY_VECTOR_WARN_MAX_PER_ROOT`（单根上限）与 `FD_MEMORY_VECTOR_WARN_TOTAL`（全局上限），默认取当前实测的宽裕倍数（见 Open Questions），不是拍脑袋的紧值。
- **超阈标记是计数而非告警通道**：指标面只暴露布尔/数值，告警通道（cron 巡检、webhook）本 change 不建——那会把「观测」扩大成「运维系统」，超出范围。

### D4 安全区口径写进 `docs/memory-architecture-v2.md`，与阈值同源

文档给出：当前实现（全表扫描）、实测延迟（304 条/根）、默认阈值、跨过后的处置方向（换 ANN 前先看真实瓶颈——可能是解 float 而非扫描本身）。

- **为什么必须同源**：阈值改了文档不改，下次实施者按文档数字做决策，实际系统跑在别的线，是典型漂移源。

## Risks / Trade-offs

- **[新测试文件让 `npm test` 变慢] → 起 server 有固定开销；保持用例聚焦，不铺无关场景。**
- **[阈值设太紧 → 生产立刻报警但无意义] → 默认值取实测的宽裕倍数，且阈值可配，先观察再收紧。**
- **[测试钉住行为后误改会红] → 这正是目的；误改时先判断是需求变了还是实现退化，改 spec 与测试，不是删测试。**
- **[本 change 无上产风险] → 除指标新增字段外无行为变更，指标是纯增量。仍按流程出片（fd-memory）。**
- **[被人当成「覆盖率工程」而堆砌断言] → 只测出过事故或真有分支歧义的边界，不为覆盖百分比补测。**

## Migration Plan

1. fd-memory 一次出片同时带上：新增测试（不入镜像，仅 CI）、`vectors.scale` 指标、`docs/` 口径更新。
2. 上产后先读一次 `/admin/metrics`，确认新字段出现且数值与直查库一致（避免指标算错）。
3. 无需回滚预案——纯增量；若指标字段有误，回滚镜像即可。

## Open Questions

- 默认阈值具体取多少：单根 > 2000？> 5000？需结合一次实测（对最大单根跑 digest，看解 float 的实际耗时）再定，本 change 先给可配置与占位默认。
- 是否让 `scripts/probe-embedding-lane.mjs` 也把规模门纳入判定（超阈 exit 1）？倾向先只暴露不判定——规模大不等于车道坏了，直接 exit 1 会制造假警。
