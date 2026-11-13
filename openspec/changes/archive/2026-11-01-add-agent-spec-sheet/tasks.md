## 1. 共享组件骨架

- [x] 1.1 在共享 web 层新增 spec-sheet 组件：三桶分区（角色/技能/工具）+ 徽章 + provenance + 可选引导；验收：组件单测渲染一个含三桶的 agent，断言三个分区、徽章、provenance 均出现。
- [x] 1.2 空桶显式呈现：验收：仅含 persona 的 agent 渲染出「技能为空」「工具为空」空态，不省略分区。
- [x] 1.3 徽章与 provenance 走既有推导（`deriveBadge`/`badgeFromFlags`、`describeProvenance`），组件内零重推导；验收：单测断言组件不导出/不调用自造推导逻辑，且 `lib/` 两模块零改动。

## 2. 引导来自文档数据

- [x] 2.1 有 `manifest.guide` 时渲染三步，缺失时不渲染引导块；验收：两份夹具（有/无 guide）单测分别断言渲染与不渲染。
- [x] 2.2 组件不引用 `packGuides.ts`；验收：`grep` 组件源码无 `packGuides` 引用。

## 3. 消费面接入

- [x] 3.1 市场详情（`PackDetailDialog`）接入：技能全文与 persona 全文保留在分区内的逐项展开；验收：既有关注点（订阅前可检查技能正文/persona/MCP 引用）回归测试绿。
- [x] 3.2 对话选择器（`AssistantPicker`）以紧凑模式消费同一组件；验收：picker 行显示三桶计数 + 徽章，且复用同一组件（单测断言组件被引用）。
- [x] 3.3 facet 与壹座同源渲染；验收：facet 构建通过 + 同一 agent 在两面的快照/断言一致（或组件位置在共享层可被两面 import 的构建检查）。

## 4. 收尾

- [x] 4.1 五语言 chrome parity（桶标签/空态/徽章与来源文案）；验收：`scripts/check-locales.js` 通过。
- [x] 4.2 真机走查 ✓（§15.120，playwright 双态 9/9：三桶/三岗/空态显式/徽章/guide v6 en 副轨眼见/社区 agent 同呈现）
- [x] 4.3 为下游预留：组件导出可被 `add-agent-studio` 预览与 `add-official-agent-gallery` 消费；验收：导出面单测/类型检查通过。
