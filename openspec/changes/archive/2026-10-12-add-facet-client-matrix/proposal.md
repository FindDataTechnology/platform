## Why

F2.2（`docs/facet-market-roadmap.md`）：五客户端的能力差异今天散在五份指南里——用户要
逐篇读才能知道「这家能不能项目级装/写不写 MCP」。一张矩阵+定期冒烟把「支持」从静态
文档变成被验证的事实（照 dsh-version-matrix 先例：矩阵+脚本互为咬合）。

## What Changes

- **支持矩阵**（F2.1 实证+CLI 代码事实源）：客户端×能力——技能安装用户级/项目级、
  MCP 配置写用户级/项目级、插件市场形态、更新路径（facet update）、真环境实证状态。
- **深度文档** `docs/ecosystem/client-matrix.md`（OSS）：矩阵+口径说明（矩阵行=CLI 与
  客户端的双向事实：CLI 写什么[代码事实]、客户端认什么[实证/边界]）。
- **冒烟脚本** `scripts/smoke-facet-clients.mjs`：隔离 FACET_HOME 逐 target 真跑
  install --write-mcp（预置哑 wgk 凭据——写入不验键）→ 断言技能落位+五种原生配置
  形状 → 打印矩阵判定。CI/本地皆可跑（照 dsh-version-matrix 先例）。
- **#/docs 矩阵表**：facet web DocsView 安装节加紧凑矩阵（cliFacts 单源派生+五语标签）。

## Impact

- 新文档+新脚本+facet/web DocsView/cliFacts+i18n 五语；镜像三面滚（web 变更）+OSS 快照。
- specs：facet-platform 增补支持矩阵需求。
