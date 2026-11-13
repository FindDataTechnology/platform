# Tasks: add-offline-pack-authoring

## 1. 草稿导出端点

- [ ] 1.1 `POST /api/pack-drafts/:id/export-bundle { manifest }`：`validatePackManifest`（与安装同源）→ `buildBundle`（offline-pack-supply 容器，origin 标注 draft 导出）→ 返回 `.yizpack` 字节（base64）；校验失败结构化报错且**与同内容安装的报错一致**（合同断言）
- [ ] 1.2 语义红线测试：导出后 `published_pack_id` 不变、无 packId/版本产生、草稿仍可编辑、已安装列表/技能库/MCP 零变化
- [ ] 1.3 确定性：同一草稿同一 manifest 两次导出，容器摘要一致（复用 buildBundle 的确定性，回归钉住）

## 2. bundle → 草稿

- [ ] 2.1 `POST /api/pack-drafts/import-bundle`：完整容器校验（readBundle 三闸）→ manifest 反向编译为草稿字段（name/description/tags/entries）→ 新建草稿；**不安装/不物化**
- [ ] 2.2 round-trip 测试：导出 → 导入 → 再导出，两次 bundle 摘要一致；导入后已安装列表/技能库/MCP 零变化
- [ ] 2.3 entries 反向编译的字段覆盖测试：skills（含 files/frontmatter 树）、agents（serving 声明）、mcpServers 引用、bots——逐类断言草稿 entries 与 manifest 源等价

## 3. 编辑器动作

- [ ] 3.1 `PackDraftsView` 加「导出安装包」（下载 .yizpack 文件）与「从安装包导入草稿」（选文件上传）；与「发布」按钮并列但**视觉/文案分区**（导出≠发布提示）；i18n 五语言
- [ ] 3.2 错误呈现：校验失败的结构化错误与安装同款呈现（复用既有 confirm/错误映射）
- [ ] 3.3 e2e：导出下载 + 导入建稿 + 发布按钮不受影响（fast 车道）

## 4. 见证

- [ ] 4.1 `npm test` 全绿 + `openspec validate add-offline-pack-authoring --strict` 绿
- [ ] 4.2 手动全链：断网机器 草稿→bundle→装机→运行（与 offline-pack-supply 的安装探针合流），证据入台账
