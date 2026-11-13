# Tasks — add-personal-data-export

## 1. 判据

- [x] 1.1 复核体检结论：导出/删除零命中；修正「12 张表」为 **9 张按 email 键的个人表**
  - 实证：`user_preferences`（部署级键值）、`user_presets`（无归属列）、
    `chart_bindings`（lineage 键）三者均无个人身份列
- [x] 1.2 先钉性质再写代码：导出只读（安全），删除级联（需裁定）

## 2. 实现

- [x] 2.1 `db.listPersonalRows(table, email)`：白名单外抛错，缺表降级为 `[]`
- [x] 2.2 `GET /api/users/me/export`：身份取自请求、凭据列掩码 `<held>`、
      会话只出归属事实、响应自带 scope 声明
- [x] 2.3 401（无身份）/ 503（库不可用）两道门

## 3. 测试

- [x] 3.1 `scripts/test-personal-export.mjs` 7 条：隔离 / 掩码 / 排除全局态 /
      会话无正文 / 空车道 / 401+503 / 白名单拒绝
  - 实证：`node --test scripts/test-personal-export.mjs` → **7 tests / 7 pass / 0 fail**
- [x] 3.2 自纠一处测试错误：白名单用例原本同时断言"抛错"与"返回空"，两者互斥
  - 实证：改为分开断言（4 张越界表逐个抛错；允许表但无行 → `[]`）

## 4. 收口

- [x] 4.1 `openspec validate add-personal-data-export --strict` 绿
- [x] 4.2 全仓 lint 0 error + web typecheck 干净
- [x] 4.3 归档
  - 实证：archive `+ 2 added` → `2026-11-09-add-personal-data-export`；
    `openspec/specs/personal-data-rights/spec.md` 新立，导出与擦除两条需求生效
- [x] 4.4 删除/擦除：按「个人行删、会话正文留」落地（产品裁定为 B 档）
  - 实现：`DELETE /api/users/me/data`，须显式 `{confirm:"erase"}`，否则 400 并声明口径；
    `db.erasePersonalRows()` 与导出**共用同一张白名单**（新增列不可能只导出漏删除）
  - 实证：`node --test scripts/test-personal-export.mjs` → **10 tests / 10 pass**，
    含「无确认即拒」「删行+解绑但正文仍在」「全局态不动」三条
