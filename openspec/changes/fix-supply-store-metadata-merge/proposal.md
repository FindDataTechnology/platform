# fix-supply-store-metadata-merge

## Why

脊柱写闸的 `patchMcpServer` 用 **`{...existing, ...fields}` 浅合并**，而 `metadata` 是一个**整体对象列**：

```js
const merged = { ...existing, ...(fields ?? {}) };   // gateway/supply-store.js:305
```

后果是**任何只改 metadata 里一个键的调用者，都会静默抹掉兄弟键**。这不是理论风险，已经在产线上发作过两次：

1. **2026-11-07**：注册中心「探针卫兵」上线后，脊柱 26 行 metadata 的 `supported_transports` 整列丢失（迁移 dump 所致），
   网关全量 405；数据回填写回后，同日又被 `securities-line-agent` 的**整行 upsert（只带部分 metadata）**打掉，
   `/fd-open-data-mcp` 与 `/fd-cn-report` 再次 405（判词 `unhealthy: no transport declaration`）。
2. **2026-11-08**：同病复发并定位到机制——**写者只带部分 metadata + 写闸浅合并** 两者叠加，才让「只改 surface / 只改版本」
   变成「顺手删掉 transports」。当日另一起：把 `/wire-build-mcp` 的 `metadata.surface_source` 由 `self_report` 改成 `probe`
   以恢复路由，若只发 `{surface_source}` 就会连带抹掉 `credential_ref / supported_transports / surface_report_token_hash`，
   使该条目彻底不可用。

当前纪律是「调用者必须发全量 metadata」——这靠人记，靠不住：每个新写者（会话、脚本、注册中心回写、大道同行）都得记住这一条，
漏一次就是一次静默数据损坏，且**症状（405）与病因（metadata 被削）隔着好几层**，排查要重演整条链。

## What Changes

- **`metadata` 列改为按键合并**：`fields.metadata` 若是对象，则与现有 metadata **逐键合并**（`{...existing.metadata, ...fields.metadata}`），
  不再整块替换；其余可 patch 字段（`display_name`/`description`/`proxy_pass_url`/`num_tools`/`tool_list`/`tags`/`license`/
  `provider_organization`/`deployment`/`visibility`/`groups`/`is_enabled`）保持行级浅合并语义不变——它们本身是标量或整体语义的列。
- **显式 null 仍能删键**：`fields.metadata = { supported_transports: null }` 表示**删除该键**（而不是写入 `null` 值），
  这样「合并」不会把「我确实要去掉这个键」的能力也一并吃掉；`fields.metadata = null`（整个字段为 null）保持今天的语义
  ——把 metadata 整列置空。判定用 `Object.hasOwn`，不带该键 = 不改。
- **`source`/`actor`/审计不变**：仍走 `guardWrite`，仍落一行 `supply_write_audit`，审计记录的是**合并后**写入的 entry（可复算）。
- **未知字段仍报错不静默丢**：`patchable` 白名单与 `SUPPLY_UNKNOWN_FIELD` 行为不动。

## Capabilities

### Modified Capabilities

- `supply-store`：写闸对 `metadata` 的补丁语义从「整块替换」改为「按键合并 + 显式 null 删键」，
  使部分补丁不再有连带删除兄弟键的能力。

## Impact

- **服务端**：`gateway/supply-store.js`（`patchMcpServer` 一处合并表达式 + 一个小工具函数）。
- **行为变化（有意）**：调用者可以只发增量；原先依赖「发部分 metadata 即整块替换」的调用者（若有）会看到旧键被保留——
  这正是本 change 要的语义，且当前**没有任何调用者需要整块替换**（删除能力由显式 null 提供）。
- **测试**：扩展 `scripts/test-supply-store.mjs` —— 新增「只发一个键，兄弟键全在」「显式 null 删键」「`metadata: null` 仍整列置空」
  「非对象 metadata 照旧整块替换」四类断言；并做反向验证（把合并改回浅替换 → 新断言必须转红）。
- **运维**：不涉及出片（本 change 只改仓库代码与测试）；上线仍需一次 paas 出片滚版，遵「镜像只走 GitHub Actions」。

## 非目标

- 不改 `upsertMcpServer`（整行 upsert 的语义就是整行，写者本就该发全量）——本 change 只治**patch** 路径。
- 不改注册中心的探针/路由生成口径（那是 `fd-mcp-registry` 仓，另一个 change）。
- 不改 `groups`/`tags`/`tool_list` 等数组列的「整体替换」语义。
- 不顺手给 metadata 加 schema 校验（键集合仍自由；需要收紧要另立 change）。
