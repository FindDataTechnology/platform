# 任务：runtime bindings 补端点契约

- [x] 1.1 五条 Requirement 逐条对代码核实（三 REST 端点 / WS 三事件 / cell 作用域 / 共享边界）
- [x] 1.2 定位缺口：`POST /api/users/me/bindings/apply` 在架且在 SDK 导出，现行 spec 无契约
- [x] 1.3 tenant-cell-runtime 五条同批核过，成立，不改
- [x] 1.4 spec delta 改写（保留两条既有场景 + 新增端点场景）
- [x] 1.5 `openspec validate --strict` + 归档
