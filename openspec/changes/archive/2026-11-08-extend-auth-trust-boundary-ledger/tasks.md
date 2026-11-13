# Tasks — extend-auth-trust-boundary-ledger

## 1. spec

- [x] 1.1 `auth` R7 扩写：豁免前缀表（11 条）+ 身份入口表（10 类）+ 三条通则
- [x] 1.2 保留原有四条场景原文，新增三条场景（豁免前缀自鉴权 / 常量时间比较 / 台账与代码一致）
- [x] 1.3 `openspec validate extend-auth-trust-boundary-ledger --strict`

## 2. 代码

- [x] 2.1 `server/auth.js` 导出 `AUTH_EXEMPT_PREFIXES`（台账自检需要单一真源）
- [x] 2.2 `server/routes/pack-usage.js` 的 `!==` 改为 `secretMatches`（行为等价，比较方式对齐）
- [x] 2.3 `scripts/test-pack-usage.mjs` 7/7 仍绿（旧写法与新写法行为等价，已双向验证）

## 3. 台账自检

- [x] 3.1 `scripts/test-auth-trust-boundary.mjs`：前缀集合与 spec 表逐条相等
- [x] 3.2 同文件：每行都有凭据列与失败姿态列；身份入口表 >= 10 行且五类关键入口仍在
- [x] 3.3 同文件：`server/routes/` 内不存在 ``!== `Bearer ${…}`` 形态的密钥比较
- [x] 3.4 反证：把 pack-usage 改回 `!==` 后 3.3 转红；删一行前缀后 3.1 转红

## 4. 归档

- [x] 4.1 `openspec archive extend-auth-trust-boundary-ledger`
