# fix-pack-relist-on-publish — 实施任务

## 1. 恢复上架的写路径

- [x] 1.1 `gateway/packs.js` `publishVersion`：追加版本前，若该 pack 当前 `unlisted`，同处置回 `unlisted = 0`（与既有 category 覆盖写法并列）；**不得**触碰 `visibility`。
- [x] 1.2 复核鉴权顺序未变：非作者仍在写任何包级状态之前被 `forbidden` 挡下。

## 2. 行为测试

- [x] 2.1 `scripts/test-pack-registry.mjs` 增用例「a new version restores listing」：publish → setUnlisted → publishVersion，断言 `reg.get(id)` 回到列表可见（`list()` 含该 id）且版本号递增。
- [x] 2.2 同用例内断言边界三态：非作者 `publishVersion` 返回 `forbidden` 且包仍 unlisted；private 包发版后仍 private 且不在公开列表；未下架包发版前后可见性零变化。

## 3. 验证与收口

- [x] 3.1 `node --test scripts/test-pack-registry.mjs` 全绿（含既有用例无回归）。
- [x] 3.2 `node --test scripts/test-facet-publish-gate.mjs` 全绿（同名闸/版本追加不受影响）。
- [x] 3.3 `openspec validate fix-pack-relist-on-publish --strict` 通过；归档后 `pack-marketplace` 主 spec 含新场景。
