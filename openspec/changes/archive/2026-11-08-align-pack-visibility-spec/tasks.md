# 任务：pack-visibility 可见性回写

- [x] 1.1 三条 Requirement 逐条对代码核实（发行默认值 / owner-scoped 各面 / registry 条目跟随）
- [x] 1.2 定位真失真：`add-facet-content-management` 的 `PUT /api/packs/:id/visibility` 推翻了「发布后不可变」
- [x] 1.3 spec delta 改写（保留两条既有场景 + 新增翻转场景）
- [x] 1.4 `openspec validate --strict` + 归档
