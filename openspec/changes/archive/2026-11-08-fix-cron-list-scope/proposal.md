# Proposal — fix-cron-list-scope

## Why

按「调用次数 × 单次体积」分开量之后，`cron_list` 是**单次最大**的工具结果：12 次调用共 1.3MB，**平均 112KB/次**。

原因不是格式（工具早已按每任务一行渲染），而是**量**：实测一个 cell 有 **816 个定时任务，其中 658 个是舰队岗位物化的节奏任务**
（57 支舰队 × 每岗一条）。也就是说，问「我有哪些定时任务」得到的是 800 行，**其中 80% 属于舰队面（`fleet_list` / `fleet_spec_read`）**，
对这个问题的答案毫无贡献，却每一行都要付出上下文预算。

这也是 P0′-1 链条上最后一个「平台侧可修」的大头。

## What Changes

- `cron_list` 增加 **scope**：`user`（默认，操作者自己的任务）/ `fleet`（仅舰队物化）/ `all`（审计）。
- 增加**分页**：默认 30 条、上限 200、`offset`，并回带 `total`/`truncated`。
- **头部永远报全量账目**：`774 total: 116 operator, 658 fleet-materialized — showing 1-30 of 116 (next offset 30)`。
  默认收窄不等于隐瞒——调用者一眼看到被排除的 658 条与如何去看。
- 视图抽到 `server/cron-list-view.js`（纯函数；cron MCP 也是 import 即起 stdio 服务，测不到）。

## Impact

- Affected specs: `scheduling-cluster-aware`（任务清单/`cron_list` 工具面 + 3 场景）
- Affected code: `server/cron-list-view.js`（新增）、`server/cron-mcp.js`
- 无迁移、无新表、无语义损失：同一批数据，默认给该问的那一层，其余用一句话交代。
