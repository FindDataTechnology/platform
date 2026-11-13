# Design: fix-fleet-provisioner-unique-post

## 决策

| # | 决策 | 理由 |
|---|------|------|
| D1 | 冲突**降级**不整体拒绝 | 与缺位降级同哲学（结构是模板的价值）；拒绝会让「对象正忙」的用户无法实例化任何市场模板。导出-重装腿在原舰队未解散时得到骨架副本而非报错，语义自洽（导出本就剥运行时数据）。 |
| D2 | 空哨兵表示法：冲突岗 `targetKind` 保留、`targetId = ""` | vacancy 是读时推导（resolveTarget 失败→vacant），persona 存在则推导必成功，所以冲突岗**不能**存真实 id。schema `target_id NOT NULL` 无法 ALTER 去约束（sqlite），而建岗/换防写路径都以 `!targetId` 拒空串——空串是 provisioner 独占、永不与真实目标碰撞的合法哨兵；`findPostByTarget(kind, "")` 亦不命中任何真实校验。 |
| D3 | 校验两查：跨舰队 `db.findPostByTarget`（查询本身 JOIN `state != 'archived'`，占坑修复 0030e1e8 语义直接复用）+ 本批 claimed 集合 | 本批重复（模板两岗同名对象）在跨舰队查询里看不到（舰队还没建），必须在前一岗位 resolve 后登记 claimed。 |
| D4 | a2a 豁免；claimed 键 `kind:id` | 与 D8 建岗路径逐字同源。persona id 与 cluster id 理论可同串，按 kind 分键。 |
| D5 | conflicts 清单形状 `{ref, title, kind, occupiedBy: {fleetId, fleetName, postTitle}}`；intra-batch 冲突 occupiedBy 置 null | API 调用方能直接讲清「谁占着」；与 `missing` 并列、互不混（缺位=对象不存在，冲突=对象存在但被占）。 |
| D6 | vacant 理由区分：`targetId === ""` → 「实例化时唯一岗冲突，未安排到任」 | 读面 evidence 诚实原则（fleet-reconcile D5 传承）：两种待补岗成因不同，主人的下一步动作不同（补岗 vs 等对象）。 |
| D7 | 不做：persona 按舰队克隆（多用户 pack-preset 真解）、web 确认页/选择器 | 克隆动 catalog/安装链是 v2 体量；web 无任何 from-template 调用点，无可过滤对象。 |

## 实现要点

- `provisionFleetFromTemplate` resolve 循环内在 degraded（缺位）判定之后加冲突判定；冲突时 `targetId = ""`、记 `conflicts`、**不**记 `missing`（两者互斥，同一岗缺位即不可能冲突——缺位时对象不存在）。
- 岗位创建与 reconcile 不变：空哨兵岗照常物化任务（paused 出生），reconcile 的 resolveTarget 失败→任务停火，补岗（swap）后原任务 preset 原地更新——与「删 persona→vacant→swap 补岗」同一条已验证链路。
- `deriveMemberStatus` 的 vacant 分支按 D6 分文案；`resolveTarget` label 兜底改为 `member.targetId || null`（空哨兵不给 "" 假标签）。
- 响应体：`{ ok, fleet, memberIdByRef, missing, conflicts, pausedAtBirth }`——纯新增字段。

## 风险

- 空哨兵进入 target 索引 `(target_kind, target_id)`：多支舰队可各有多条 `("", )` 行，无唯一约束，无碰撞。报数归属按真实 preset 定位，空串永不匹配调用方。低风险。
- 旧实例化产物（现网尚无：走查舰队已全解散、种子未被自然实例化）不存在存量双岗数据，无需迁移。
