## 1. 盘点与夹具

- [x] 1.1 盘点 `packGuides.ts` 中带 guide 文案的 pack 清单，与市场在册 pack id 对齐；验收：清单落本 change 目录（inventory.md 或 tasks 注记），每条标注官方/社区与是否已有 manifest.guide。

## 2. 内容回填（官方优先）

- [x] 2.1 为清单内 pack 撰写 `manifest.guide`（文案与客户端逐字对齐，不重写），官方资产补 `i18n.en.guide`；验收：过发布门校验（本地 `validatePackManifest` 夹具测试）。
- [x] 2.2 发布新版本（vN+1，`notes` 注明「guide 迁移，无功能变更」）；验收：市场版本列表出现新版本，`skill-md`/详情读面返回含 guide 的 manifest。

## 3. 消费面切换

- [x] 3.1 `PackDetailDialog` 引导卡改读 manifest 数据；验收：有 guide 的 pack 渲染三步、无 guide 的不渲染（组件测试双夹具）。
- [x] 3.2 `ChatWelcome`/`HelpDialog` 的 guide 类块切换数据源或按缺失省略；验收：欢迎态 prompt 卡不受影响（既有测试仍绿）+ guide 缺失时无兜底文案（组件测试）。
- [x] 3.3 `packGuides.ts` 删除 guide 步骤条目与 pack id 索引键，仅存 prompts；【**第二批终局（2026-11-01，§15.120 十三续）**：登录态核实 7 支候选全退役（含最后一条 法律-合同 J9sO… /api/packs 登录读 404；4 支 unlisted 实为退役非匿名门；2 支原作者闸对象亦已退役）→无可迁内容，终局=摘除最后一条+PackDetailDialog 的 guideFor 回退退役（manifest.guide 唯一源，test-agent-spec-sheet 翻钉）+packGuides 空壳注释留痕；HelpDialog 空态兜底与 promptsFor 通道保留】验收：客户端源码 `grep` 无按 pack id 的引导文案（仅注释留痕）；`scripts/check-locales.js` 通过；test-agent-spec-sheet/official-starter-teams/onboarding-hosted 16/0。

## 4. 回归与走查

- [x] 4.1 迁移一致性：发布版 manifest 的 guide 文案与被删除的客户端文案逐字相等（迁移当批）；验收：一致性断言测试（或在 PR 内以脚本比对留档）。
- [x] 4.2 真机走查：【manifest 侧已 API 回读验证（v6 guide/en/notes/官方身份 5/5）】市场详情/官方 starter 卡/欢迎态三处引导呈现正确；facet 域同一 pack 引导一致；验收：走查记录落台账。【2026-10-31 台账 §15.120 走查实证：市场详情 guide 来自 manifest v6（客服班组三步）+引导步骤 3+官方徽章+facet 域一致（走查 01-detail-official.png 与 facet 06-facet.png）；残余批次（第二批 4 支）见 3.3 挂账。】
