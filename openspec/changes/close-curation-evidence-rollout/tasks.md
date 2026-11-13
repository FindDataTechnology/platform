## 1. 目录首次出现条目时的证据回填

- [ ] 1.1 `packs/plugin-catalog.json` 一旦落地，逐条按 `docs/ecosystem-curation.md` §7.3 填 `evidence`：`pin` 用**真实**上游 commit 或 tag（浮动分支拒）、`licence` 用逐仓 LICENSE 原文核出来的 SPDX、`reviewedBy` 是真实审校人。**禁止从文档推导或脚本生成**——事实不能猜。验证：`node scripts/check-curation-evidence.mjs --all` 零问题，且 `node scripts/gen-curation-ledger.mjs` 生成的行与之一致
- [ ] 1.2 既有台账里 12 条 MCP server 计划若进入目录，同样逐条补齐（它们今天不在目录里：`ls packs/` 只有四个 pack 目录，无目录文件）；不进入目录的条目留在散文里，不生成行

## 2. 出片门切阻断

- [x] 2.1 **已切阻断（2026-11-12，用户授权我决定）**：删掉 `predist` 与 `Dockerfile` 两处 `--warn`，并在 CI gates job 新增一条同名步骤（两处构建 + 一处 CI，共三门）。**为什么现在切而不是等目录出现**：今天仓内无目录文件，`--all` 与默认判定都是"没东西可判"退出 0——切了是零风险空操作；等着的代价是"人要记得删 flag"，而第一条条目落地时它已经不在判，正是本变更要消灭的那类静默窗口。反向证明门是活的：以真实供给集合造一条缺证据条目 → `node scripts/check-curation-evidence.mjs --catalog <tmp>` 退出 1 并点名 `@platform/supply-probe-bundle (missing)` + `evidence: no evidence block`；真仓无目录时退出 0。边界已写进 `docs/ecosystem-curation.md` §7：闸判的是**构建上下文里那份目录**，`PLUGIN_CATALOG_FILE` 指向仓外文件时不走这三道门

## 3. 外部仓立项（不在本仓实施）

- [ ] 3.1 在 `mcp-gateway-registry` 仓立一条变更：采集端按本仓冻结的形状写入证据（`lib/curation-evidence.js` 的字段与校验语义即契约，14 条形状用例可当契约测试）。本仓只作服务方登记，不代对方立项。**材料已备**：`handoff-mcp-gateway-registry.md`（字段矩阵 / 七个不合格样例 / 边界 / 可直接抄的条文）＋ `docs/curation-evidence-fixtures.json`（`curation-evidence@1`，3 合格 + 7 不合格，由 `scripts/test-curation-evidence.mjs` 逐条回放，所以不会写歪就过期）。对方立项时把这两份带走即可；本仓不需要再改任何东西
