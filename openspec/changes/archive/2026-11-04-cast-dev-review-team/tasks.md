# cast-dev-review-team — Tasks

## 1. 选角与钉版

- [x] 1.1 源钉版：`VoltAgent/awesome-claude-code-subagents` @ `ed74d115b7fb7026a22a4f816a8e3250f425e3b4`（MIT，root LICENSE 已核）
- [x] 1.2 八岗选型（只取「读—判—说」本质型，规避"动手型"失真）：code-reviewer / security-auditor / architect-reviewer / performance-engineer / qa-expert / api-designer / debugger / api-documenter——逐文件核过上游身份句与判据领域
- [x] 1.3 刻意不搬：176 角色里"动手型"（backend-developer 等，正文以 shell 动作为主）一律不进；superpowers 方法论技能不随包（其正文同样以执行为前提，装进 handless 岗即说谎）

## 2. 改铸

- [x] 2.1 `packs/dev-review-team/manifest.json`：八岗 persona 全部含读—判—说契约、无触手声明、领域判据、严重度+证据的输出契约、职责边界
- [x] 2.2 逐岗出处：persona 尾部携带所取上游文件路径 + 钉版 sha；包级 provenance 记 official-adopted（仓/许可/钉版）
- [x] 2.3 上游 `tools:`/`model:` 字段不进包（pack agent 是 persona-only，违者过不了发布门）；正文的 shell 动作段改写为「建议用户执行」
- [x] 2.4 i18n en 覆盖层对齐覆盖层契约（agent 只许 name+serving、card 不收 examples——首版写多了被发布门当场拦下，按门收窄）

## 3. 基线测试

- [x] 3.1 `scripts/test-dev-review-team-pack.mjs` 8 例全绿：发布门零错 / 八岗 chat 面 / 逐岗出处+钉版 / 谎报触手四形态拒绝 / 判据领域性（两两重合 ≤40%）/ provenance 形状 / 不夹带 skills 与 mcpServers / en 覆盖层镜像
- [x] 3.2 `openspec validate cast-dev-review-team --strict` 绿

## 4. 未做（对外动作，需另行确认）

- [x] 4.1 发布到市场（走 gateway 发布门，管理员身份；发布后补五语覆盖层审计——官方名册上线时 en 之外的语种按既有审计脚本补齐）
- [x] 4.2 官方名册核对：发布账号须在 OFFICIAL_AUTHOR_EMAILS，否则官方画廊不可见（本包 provenance 用发布账号 aloadtree@gmail.com）
