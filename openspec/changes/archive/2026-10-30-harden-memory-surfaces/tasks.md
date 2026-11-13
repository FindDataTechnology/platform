# Tasks: harden-memory-surfaces

## 1. 路由层边界测试（④）

- [x] 1.1 新增 `src/test/http-routes.test.ts`，沿用既有真端口范式（起 `MemoryServer` + 铸令牌 + fetch 打真请求）
- [x] 1.2 `/digest` 边界：缺 `project` → 400 可辨识错误码；非 person 缺 `rootKey` → 结构化拒绝
- [x] 1.3 `/digest` 空查询回归：`q=""` / `"   "` / `"\n\t"` → 200、回包无 `model_note`、指标 `empty` 计数增加且 `vector_ratio` 不受影响
- [x] 1.4 `/digest` 参数 clamp：`k` 传 0 / 负数 / 超上限，`budget` 传极值 → 正常完成且实际生效值在区间内
- [x] 1.5 `/pages/mutate` 边界：`set_tier` 传 `"verified"` → 400 且页 tier 不变；未知 `op` → 400 且响应含允许列表
- [x] 1.6 `/pages/write` 边界：非法 `tier` 行为确定（拒绝或归一 draft），以测试钉住
- [x] 1.7 `/memory` 边界：非法 `tier` / `tags` 筛选参数不 500；未授权 scope 结构化拒绝
- [x] 1.8 `npm test` 全绿 + `npx tsc --noEmit` 零错误

## 2. 向量规模观测（③）

- [x] 2.1 `src/db.ts` 提供轻量规模统计（每 root 向量数、总数、最大值），不改 `allPageVectors` 实现
- [x] 2.2 `src/metrics.ts` 新增 `vectors.scale: {roots,total,max_root,over_threshold,threshold}`，接进 `metricsSnapshot()`
- [x] 2.3 阈值可配：`FD_MEMORY_VECTOR_WARN_MAX_PER_ROOT` / `FD_MEMORY_VECTOR_WARN_TOTAL`，默认取实测宽裕倍数
- [x] 2.4 单测：空库 / 单根 / 多根 / 超阈 四种情形下指标数值与 `over_threshold` 正确

## 3. 文档口径

- [x] 3.1 `docs/memory-architecture-v2.md` 补「向量检索规模安全区」：当前实现、实测数字、默认阈值、跨过后处置方向
- [x] 3.2 口径与代码默认阈值同源核对（文档数字 = 代码默认值）

## 4. 上产与验证

- [x] 4.1 fd-memory 出片 + GitOps 滚版（`all-services/prod/fd-memory.yaml` 主容器与 initContainer 两处）
- [x] 4.2 真机验：`/admin/metrics` 出现 `vectors.scale`，数值与 namespace 直查库一致
- [x] 4.3 真机验：空查询三档仍不误报降级（与本 change 的回归测试对齐）
- [x] 4.4 台账 §15.79 续六：规模现状 + 边界测试覆盖说明
