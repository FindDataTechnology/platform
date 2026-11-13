# Tasks — enumerate-auth-bridges-in-ledger

## 1. spec

- [x] 1.1 「Trust boundary and scope」补入内部桥接表（10 行：盖章身份 / 动词·路径 / 路由侧归属），
      并写明全部经同一个 `isInternalChild` 守卫
- [x] 1.2 「the ledger and the code agree」场景扩写到内部桥（保留原场景标题）
- [x] 1.3 `openspec validate enumerate-auth-bridges-in-ledger --strict` 绿
  - 实证：`Change 'enumerate-auth-bridges-in-ledger' is valid`

## 2. 代码（仅导出单一真源，行为零变化）

- [x] 2.1 `server/auth.js` 导出 `INTERNAL_BRIDGES`（与 `AUTH_EXEMPT_PREFIXES` 同理）
  - 实证：动态 import 打印 `bridges exported: 10 cron@internal,chart-bridge@internal,delegation@internal,
    fleet-architect@internal,builder-author@internal,skill-evolution@internal,persona-evolution@internal,
    save-bridge@internal,actions-bridge@internal,fleet-bridge@internal`

## 3. 自检

- [x] 3.1 `scripts/test-auth-trust-boundary.mjs` 新增：spec 桥接表的身份集合与
      `INTERNAL_BRIDGES` 的 `email` 集合逐条相等
- [x] 3.2 同文件：每行三段非空（身份 / 范围 / 归属），且范围列至少含一个 `/api` 形态
- [x] 3.3 反证：删掉 spec 表里一行 → 3.1 必须转红；改回即绿
  - 实证：删 `fleet-bridge@internal` 行 → **正是 3.1 那条转红**（6 tests / 5 pass / 1 fail）；
    从备份恢复后 `sha256sum -c` → `openspec/specs/auth/spec.md: OK`，6/6 绿
- [x] 3.4 既有 4 例仍绿（豁免前缀 / 身份入口 / 无常量比较的密钥）
  - 实证：归档后 `node --test scripts/test-auth-trust-boundary.mjs` → **6 tests / 6 pass / 0 fail**
    （原 4 例 + 新增 2 例）

## 4. 收口

- [x] 4.1 `node --test scripts/test-auth-trust-boundary.mjs` 全绿
- [x] 4.2 lint（Biome）0 error
- [x] 4.3 归档（归档后 spec 表才生效）
  - 实证：`openspec archive enumerate-auth-bridges-in-ledger --yes` → `~ 1 modified`，
    归档为 `2026-11-08-enumerate-auth-bridges-in-ledger`；spec 表现位于 133-146 行。
    注：本 change 只改台账与自检（唯一代码改动是给 `INTERNAL_BRIDGES` 加 `export`），
    无运行时行为变化，故与上一笔台账 change 同样即时归档，不必等出片。
