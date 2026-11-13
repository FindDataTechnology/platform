# 卸载一个包，不该在卡片上留下一个「待办的幽灵」

## Why

2026-11-08 在 bootstrap 租户上跑 ② 绑定的真机全链时量到：装一个声明 `connector_bindings` 的包
→ 授权 → 卸包之后，`GET /api/connections` 仍然报

```json
{"packs":1,"bindings":1,"unresolved":1}   // bindings[0].status = "missing"
```

包已经不在 `installed_packs` 里了，卡片却让用户去「连接 alpha_vantage」，还有一个指向不存在的
需求的动作按钮。根因是 `uninstallPack` 只清包自己的东西（skills / agents / bots / installed
行），从不碰 `connector_binding_ledger`；台账行就停在卸载那一刻的状态。而投影只把 `deprecated`
当作历史（`active` 过滤 `deprecated` 与 `undetermined`），所以 `missing` 被算成「用户欠的活」。

`deprecated` 在 connector-bindings spec 里的定义正是「包不再声明这个 key 了」的历史态——卸载
属于同一类事实，只是此前只有「重解析时 key 被删」这一条路径会写它。

## What Changes

- `db.js`：新增 `listConnectorBindingLedgerEmails(packId)`——台账按 `(email, pack_id,
  binding_key)` 存、授权按身份给，而「包被卸了」是部署级事实，卸载方手里没有 owner 名单，
  所以需要按 pack 跨身份取 email 集合。
- `pack-store.js` `uninstallPack`：在 `deleteInstalledPack` 之后把该 pack 的所有台账行置为
  `deprecated`（保留 `packVersion`/`provider`/`operations`/`connectionId`/`optional`/`role`，
  只改状态）。**令牌不动**——与「key 被删」那条路径的既有姿态一致：用户授权出去的凭证不能因为
  卸包被静默吊销，重装还得找得到它。
- `scripts/test-uninstall-deprecates-bindings.mjs`：三态钉死（跨身份置 deprecated、不碰别的包、
  令牌存活、二次卸载仍被拒且不改状态）。反证：摘掉修复后两条测试全红。

非目标：不改 `deprecated` 的语义；不做卸载时自动 revoke（那是用户的凭证，卸载不是撤销）；
不动投影侧的过滤条件（语义修在写侧，读侧不必知道这个坑）。

## Impact

- 影响面：卸载过「声明绑定」的包的用户——卡片从「1 pack · 1 binding · 1 to resolve」变成
  干净的零。已授予的令牌继续存在（重装即可用），行为不变。
- 无迁移、无 API 形状变更；`deprecated` 行本来就不注入、不计数。
