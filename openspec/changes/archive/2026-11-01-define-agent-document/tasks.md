## 1. 规格与设计定稿

- [x] 1.1 确认 `specs/agent-document/spec.md` 覆盖六条需求（原子单元 / 单校验器 / 四发射口 / 编辑器≠生命周期 / 三桶规格书 / 无凭据），每条至少一个场景；跑 `openspec validate define-agent-document --strict` 零错误。
- [x] 1.2 确认 `design.md` 的 D1–D7 与 spec 不冲突：四发射口与生命周期边界表、三桶规格书共享组件、下游排序均可在 design 中定位到对应段落。

## 2. 文档交叉引用

- [x] 2.1 在 `docs/roadmap-agents-native-teams.md` §6 立案次序补入本脊梁行与下游排序（`move-pack-guides-to-manifest` → `add-agent-spec-sheet` → `add-agent-studio` → `fold-blueprint-into-studio` → `add-agent-fork-lineage` → `add-official-agent-gallery`）；验收：六个 change 名在 §6 表内逐一出现且依赖列有值。
- [x] 2.2 在 `docs/creating-packs.md` 与 `docs/pack-marketplace.md` 各加一段指向 `agent-document` 能力（三桶模型 + 四发射口）；验收：两文档均出现「三桶 / 四个发射口」表述且链接到 spec 路径。

## 3. 下游登记（仅规划，不 scaffold、不实现）

- [x] 3.1 在 roadmap §6 登记六个下游 change 的依赖关系与体量；验收：每个下游行都有依赖与体量列，且与 `design.md` D6 的排序一致。
- [x] 3.2 验证本 change 零代码改动：`git status --porcelain` 仅显示 `openspec/changes/define-agent-document/` 与上述两处 docs 编辑，不含 `lib/`、`web/`、`server/`；验收：命令输出符合。
