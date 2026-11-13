## Why

`add-curation-evidence-gate` 把证据形状、读面两维、拒绝点与台账生成都落了地，但它留了三件**本仓现在做不了**的收尾：证据要填进一个**还不存在的目录**、出片门要从观察轮切成阻断、采集器要在**另一个仓**里立变更。

把这三件留在原变更里会卡住两件事：原变更永远到不了"全部任务完成"，于是它的 spec delta 永远进不了 `openspec/specs/`——也就是 `curation-evidence` 这条契约永远只是提案、不是规格。所以按 OpenSpec 的规矩把仓外事项拆出来，原变更的契约先落地，这三件事在这里等条件成熟。

**不做什么**：不改证据形状（`lib/curation-evidence.js` 是冻结的契约，14 条形状用例可被对方仓当契约测试用）；不改读面；不改台账生成。

## What Changes

- **目录首次出现条目时逐条填证据**：真实上游 commit/tag、逐仓 LICENSE 原文核验、真实审校人。**不得脚本推导或猜**——这三样都是事实，编出来的证据比没有证据更坏。
- **出片门切阻断（已完成 2026-11-12）**：`predist` 与 `Dockerfile` 两处删掉 `--warn`，CI gates job 另加一条。原计划的"前置条件＝目录里条目全部 complete"已判定不成立：仓内根本没有目录文件，两个模式都是退出 0，所以切了是空操作；而"等人记得删 flag"才是真实风险——第一条条目落地时门已经不在判。
- **采集器在外部仓立项**：`mcp-gateway-registry` 侧按本仓形状（`axes` / `pin` / `licence` / `egress` / `reviewedBy` / `reviewedAt` / `reviewValidUntil`）写入证据。本条只在对方仓的会话里做，本仓只作契约与服务方登记。

## Capabilities

### New Capabilities

（无。三件事都是把已落地的契约推到生效条件，不新增要求。）

### Modified Capabilities

（无。）

## Impact

- **`packs/plugin-catalog.json`**（当前不存在）：一旦落地，每个被供给条目必须带完整 `evidence`；`node scripts/check-curation-evidence.mjs --all` 是本地判据。
- **`package.json`（predist）/ `Dockerfile`**：删 `--warn`；改动是两行，切换前先跑 `--all` 确认零问题。
- **`mcp-gateway-registry`（外部仓）**：新增一条变更，写入侧采集；本仓不实施。
