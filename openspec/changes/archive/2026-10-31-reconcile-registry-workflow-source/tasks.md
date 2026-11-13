## 1. 回灌主仓源

- [x] 1.1 从执行仓 `FindDataTechnology/mcp-registry-publish` 取现役
      `.github/workflows/mcp-registry-publish.yml`（`gh api repos/.../contents/...` 解码），
      替换主仓同名文件；验证：主仓文件与执行仓内容 `diff` 为空，且
      `grep -c "confirm == 'retire'"` = 1、`grep -c "environment:"` = 0

## 2. 消解文档分叉表述

- [x] 2.1 更新 `docs/ecosystem/mcp-registry-publishing.md` §5：删除双副本分叉对照表
      （含「已定案」注），改为一句「两仓 workflow 自 `reconcile-registry-workflow-source`
      起逐字节一致；源在主仓，改动后同步执行仓」；验证：§5 无分叉表残留
- [x] 2.2 更新同文件 §5.1 第 3 条：改为「两仓 workflow 一致，均未引用 `environment:`；
      加门需在 workflow 里补一行并在执行仓建同名 Environment」；验证：文内不再有
      「从未同步过去」「分叉」表述

## 3. 对账收口

- [x] 3.1 两仓对账：workflow 逐字节一致、`scripts/publish-mcp-registry.mjs` 逐字节一致、
      执行仓 workflow 自回灌基准起无新改动；验证：diff 全空
- [x] 3.2 提交主仓改动；验证：`git show --stat` 仅含 workflow 与指南两个文件
      （提交前复核，防误带他人删除）
