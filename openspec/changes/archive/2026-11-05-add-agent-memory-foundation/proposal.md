# Proposal: add-agent-memory-foundation

## Why

永忆要成为 agents 系统的记忆处理地基，当前缺三块结构性能力：页面没有一等 metadata（舰队事实的 kind/memberId 被编码进标题串，成员相关召回退化为字符串相关性查询）；读面只有「q 相关性 + k + budget」一种形态，撑不起「按岗位/事实类型/时间段取记忆」这类 agent 系统查询；部署命名空间 `d/` 缺 owner 监督权（owner 只能读 shared，摸不到自己成员的私有记忆）与 agent 自我认知工具。壹座侧的舰队成员独立记忆（姊妹 change）以本单为硬前置。

## What Changes

- 页面增加一等 `metadata` 字段（结构化 JSON，携带 kind/memberId/refs 等），落库并建索引；标题恢复纯人类语义，不再承担机器寻址。
- `/digest` 与 MCP `memory_query`/`memory_recent` 增加结构化筛选参数（按 metadata 键值、时间范围、layer 过滤），与既有相关性召回正交组合。
- 既有 `[kind][memberId] 标题前缀` 的一次性回填迁移：存量页面解析出 metadata，读面双轨过渡后切净。
- **owner oversight grant**：person 令牌对自己名下的部署根（`d/<packId>`）获得审计式只读权（每次读取落审计行），弥补「owner 看不见成员私有记忆」的监督空洞；写权不变（成员私有分区仍只有成员令牌可写）。
- 新增 MCP 工具 `memory_overview`：agent 查询「我的分区有哪些、各有多少页、最近写入了什么」——agent 自我认知的最小读面。
- 不改四层记忆模型、蒸馏管线、预算纪律与 fail-open 降级姿态。

## Capabilities

### New Capabilities

- `agent-memory-foundation`：页面一等 metadata + 结构化查询 + owner oversight + agent 自我认知读面——永忆支撑 agents 系统记忆处理的地基契约。

### Modified Capabilities

- `fleet-memory`：令牌权限矩阵增加一格——person 令牌对自己名下部署根的审计式只读（原矩阵 person=u/ root 读写、对 d/ 无权；矩阵其余格不变）。

## Impact

- **fd-memory**（代码在本仓外 `/Users/chengsishi/finddata/fd-memory`，本仓为其治理根）：`src/db.ts`（metadata 列 + 索引 + 迁移）、`src/store.ts`/`src/http.ts`（写面收 metadata、读面筛选参数）、`src/digest.ts`（筛选下推）、`src/mcp.ts`（工具 schema + memory_overview + oversight 读权判定）、`src/auth.ts`（person 对自有 d/ 根的审计式读权）、`src/metrics.ts`（metadata 筛选命中计数）。
- **协议兼容**：/pages POST 新增可选 metadata 字段，不传时行为逐字节等价；/digest 新增可选筛选参数，缺省等价——零破坏升级。
- **壹座侧**：本单为姊妹 change（成员独立记忆 + knowledge profile）的硬前置；壹座现有 capture（标题前缀写法）在本单后仍可用（双轨读），迁移完成后切净。
- **测试**：70+ 既有单测不得回归；新增 metadata 筛选、回填幂等、oversight 审计、越权拒绝四组用例。
