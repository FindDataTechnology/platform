# Proposal: fix-fleet-provisioner-unique-post

## Why

fleet-core D8 裁决 persona/cluster 全局唯一岗（报数归属无歧义），建岗与换防写路径都以 `findPostByTarget` 拒 409 执行。但实例化器（provisioner）是第三条建岗写路径，`fleet-provisioner.js` 对目标只做**存在性**校验（`resolveExisting`/`catalogAgentIds`），不查在岗占用。两个可复现的洞：

1. **导出-重装腿**：导出模板把现役 targetRef 原样映射为 `existing-*`；若原舰队未先解散就重装，同一 persona/cluster 会被建出第二个岗位——报数归属按 preset 定位「唯一岗位」直接出歧义。走查当时先全解散再重装，恰好绕开。
2. **模板内重复/跨舰队占用**：模板两个岗位声明同一 existing-persona，或声明的对象已在另一支活舰队在岗，都会静默双岗。

現状没有任何 UI 调用 `POST /api/fleets/from-template`（走查由浏览器驱动 API），所以缺位无法靠前端选择器兜底——不变量必须钉在 API 层。

## What Changes

- provisioner 解析每个岗位目标后、建队前，对 persona/cluster 目标执行与建岗同源的唯一岗校验：既有活舰队在岗（`findPostByTarget`，天然排除 archived）或本批已被前面岗位占用，即判冲突。
- 冲突岗**逐项降级**（与缺位降级同哲学）：岗位照建、以「无人到任」的空哨兵 target 表示（`targetId` 空串，读面推导为 vacant 待补岗，换防可补），不整体失败；冲突清单 `conflicts` 随 from-template 响应回报（含占用它的舰队/岗位名）。
- a2a 豁免（D8 原文：外部执行无归属问题）。
- 读面为空哨兵给出诚实的 vacant 理由（「实例化时唯一岗冲突，未安排到任」），区别于「对象已被删」。
- 多用户同包 pack-preset 场景由同一机制覆盖（第二个实例化的冲突岗降级）；按舰队克隆 persona 的真解仍留 v2，本 change 不动。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `agent-fleet-templates`: 「实例化器编排建队且依赖缺位逐项降级」需求增加唯一岗校验与冲突降级场景。

## Impact

- 代码：`server/fleet-provisioner.js`（在岗校验+conflicts）、`server/fleet-reconcile.js`（空哨兵 vacant 理由）、`server/routes/fleets.js`（resolveTarget 标签兜底）；响应体新增 `conflicts` 字段（新增字段，不改既有字段语义）。
- 兼容：建岗/换防路由本就拒绝空 targetId，空哨兵只能由 provisioner 产生；`findPostByTarget(kind, "")` 不会命中任何真实目标。
- 测试：`scripts/test-fleet-templates.mjs` 增补 provisioner 单测与 from-template 路由冲突腿；既有测试零改动预期全绿。
