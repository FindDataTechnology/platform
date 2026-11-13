# Align agent-delegation-tools spec references

## Why

审计（optimize-paas-module-audit G 簇）发现该 spec 自 10-02 未随代码更新。核验后实际漂移极小：

1. spec 正文写死行号引用 `server/delegation-mcp.js:57,91,97`，现工具注册已在 59/93/99 行——行号类引用天然脆弱，每次插入都会静默腐烂。
2. 10-02 后唯一行为变化是 99c079c60（bridge 出站 fetch 换 fetchWithTimeout），该纪律归属 harden-cell-execution-reliability spec，本 spec 无需重复。

治本 = 去掉行号，改按工具名+注册文件定位（不随行漂移）。

## What Changes

- spec `agent-delegation-tools` 第一条 Requirement 正文：行号引用改为按名引用。
- 不改任何 Requirement 语义、不加/删 Requirement、场景不动。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `agent-delegation-tools`：第一条 Requirement 引用方式修正（MODIFIED）。

## Impact

- 仅 spec 文本；代码零改动。
